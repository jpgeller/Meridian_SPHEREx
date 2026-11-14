"""Full-resolution SPHEREx patches for the 3D sky.

IRSA's all-sky HiPS cube stops at order 5 (12.9"/px). Past ~3 deg of zoom Aladin can only
magnify those tiles, and it draws them with nearest-pixel filtering, so they look blocky.
SPHEREx's own pixels are 6.15", twice as fine. A patch built from the Level 2 images and
laid over the sphere gives the real detail, and optional smoothing (interpolated, no new
information) replaces the squares beyond it.

A patch = median of the most recent frames that saw the centre in the requested band,
on the shared north-up 6.15"/px grid (cutouts.process), stretched to an 8-bit PNG with
transparency where there is no data, plus the WCS Aladin needs to place it.

Caveat (shown to users): SPHEREx's filter changes wavelength across each image (about 5 bands
per degree), so a patch is exactly band k at its centre and drifts by about 1 band at the edges
of a 0.5 deg patch. Patches are therefore capped at 0.5 deg.
"""
from __future__ import annotations

import io
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

import cache
import cutouts
import spherex

MAX_FOV = 0.5
MIN_FOV = 0.05
MAX_FRAMES = 4
SMOOTH_FACTOR = 4  # upsampling for the smooth version
FOLD = {0: 1, 50: 49, 51: 52}  # blank cube bands fold into neighbours (same as the web app)
VERSION = "v1"


def _display_band(b):
    return FOLD.get(b, b)


def _pick_frames(ra: float, dec: float, band: int) -> tuple[list[dict], int]:
    """Most recent frames that saw (ra, dec) in `band`; else the nearest band with frames."""
    frames = [f for f in spherex.frames_with_meta(ra, dec)["frames"]
              if f.get("inside") and not f.get("error") and f.get("band") is not None]
    if not frames:
        return [], band
    bands = sorted({_display_band(f["band"]) for f in frames}, key=lambda b: abs(b - band))
    used = bands[0]
    picked = sorted((f for f in frames if _display_band(f["band"]) == used), key=lambda f: -f["mjd"])
    return picked[:MAX_FRAMES], used


def _stretch(img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """asinh stretch to 8 bit; returns (grey, alpha). NaN -> transparent, +inf -> white."""
    sat = np.isposinf(img)
    good = np.isfinite(img)
    grey = np.zeros(img.shape, dtype=np.uint8)
    if good.any():
        lo, hi = np.percentile(img[good], [1, 99.7])
        x = np.clip((img - lo) / max(hi - lo, 1e-12), 0, 1)
        x = np.arcsinh(10 * x) / np.arcsinh(10)
        grey = np.nan_to_num(x * 255, nan=0, posinf=255).astype(np.uint8)
    grey[sat] = 255
    alpha = np.where(good | sat, 255, 0).astype(np.uint8)
    return grey, alpha


def sky_patch(ra: float, dec: float, fov: float, band: int, smooth: bool = True) -> dict:
    fov = float(min(MAX_FOV, max(MIN_FOV, fov)))
    key = f"{ra:.5f},{dec:.5f}|{fov:.4f}|b{band}|{'s' if smooth else 'n'}|{cutouts.PROCESS_VERSION}|{VERSION}"
    meta_hit = cache.get_json("skypatch", key)
    png_path = cache.path_for("skypatch", key, ".png")
    if meta_hit and png_path.exists():
        return meta_hit

    frames, used_band = _pick_frames(ra, dec, band)
    if not frames:
        raise LookupError("SPHEREx has no images of this spot yet")

    def one(f):
        try:
            return cutouts.process(f, ra, dec, fov)
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = [r for r in pool.map(one, frames) if r is not None]
    if not results:
        raise RuntimeError("the SPHEREx images could not be loaded")

    stack = np.stack([r["image"] for r in results]).astype(np.float64)
    n_sat = np.isposinf(stack).sum(axis=0)
    n_ok = np.isfinite(stack).sum(axis=0)
    with np.errstate(all="ignore"):
        finite = np.where(np.isfinite(stack), stack, np.nan)
        img = np.nanmedian(finite, axis=0) if len(results) > 1 else finite[0]
    img[n_sat > n_ok] = np.inf  # saturated in most frames: a bright star core

    grey, alpha = _stretch(img)
    # FITS order has row 0 at the south; PNG row 0 is the top (north).
    grey, alpha = np.flipud(grey), np.flipud(alpha)
    tw, (n, _) = cutouts.target_wcs(ra, dec, fov)
    scale = SMOOTH_FACTOR if smooth else 1
    im = Image.merge("LA", (Image.fromarray(grey), Image.fromarray(alpha)))
    if smooth:
        im = im.resize((n * scale, n * scale), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    cache.write_atomic(png_path, buf.getvalue())

    pix = cutouts.PIXEL_SCALE_ARCSEC / 3600 / scale
    size = n * scale
    meta = {
        "key": key,
        "ra": ra, "dec": dec, "fov": fov,
        "band": used_band, "band_requested": band,
        "wavelength_um": round(float(np.mean([r["meta"]["wavelength_um"] for r in results])), 4),
        "n_frames": len(results),
        "dates": sorted(r["meta"]["date_iso"] for r in results if r["meta"].get("date_iso")),
        "pixel_scale_arcsec": cutouts.PIXEL_SCALE_ARCSEC,
        "smooth": smooth,
        # WCS for Aladin's A.image: TAN, north up, east left. Image rows run top (north) to
        # bottom like the PNG; the sign of CD2_2 is verified against the HiPS stars.
        "wcs": {
            "NAXIS": 2, "NAXIS1": size, "NAXIS2": size,
            "CTYPE1": "RA---TAN", "CTYPE2": "DEC--TAN",
            "CRVAL1": ra, "CRVAL2": dec,
            "CRPIX1": (size + 1) / 2, "CRPIX2": (size + 1) / 2,
            "CD1_1": -pix, "CD1_2": 0.0, "CD2_1": 0.0, "CD2_2": pix,
            "CUNIT1": "deg", "CUNIT2": "deg", "EQUINOX": 2000.0,
        },
    }
    cache.put_json("skypatch", key, meta)
    return meta


def patch_png(key: str) -> bytes:
    p = cache.path_for("skypatch", key, ".png")
    if not p.exists():
        raise FileNotFoundError(key)
    return p.read_bytes()
