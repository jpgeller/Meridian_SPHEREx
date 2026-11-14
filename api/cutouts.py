"""SPHEREx cutouts on one common sky grid, so frames from different dates line up pixel
for pixel (needed for blink, add and subtract).

Pipeline per (frame, ra, dec, fov):
  1. IRSA cutout service: access_url + ?center=RA,DECd&size=FOV  (cached FITS)
  2. image = IMAGE - ZODI (zodiacal light model); variance from VARIANCE
  3. mask only broken pixels (see BAD_PLANES); SOURCE/OUTLIER are kept on purpose,
     a moving object can be flagged OUTLIER
  4. reproject onto a north-up TAN grid centred on (ra, dec), 6.15"/px
  5. wavelength + bandwidth at the centre from the spectral WCS (key 'W')
"""
from __future__ import annotations

import io
import time
import warnings

import httpx
import numpy as np
from astropy import log as astropy_log
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS, FITSFixedWarning
from reproject import reproject_interp

import cache

astropy_log.setLevel("WARNING")  # SPHEREx SIP headers trigger a harmless INFO message

PIXEL_SCALE_ARCSEC = 6.15
# Mask planes that mean "this pixel value is not usable". Names come from the FLAGS
# header (MSKNnnnn / MSKMnnnn), so a renumbering upstream does not break us.
BAD_PLANES = {"TRANSIENT", "NONFUNC", "MISSING_DATA", "HOT"}
# Saturated cores of bright stars. Their values are unreliable but the star is real, so we
# send +Infinity (drawn at full brightness, excluded from maths) instead of NaN (no data).
SATURATED_PLANES = {"OVERFLOW", "SUR_ERROR", "NONLINEAR"}
# Planes worth reporting to users (percent of pixels in the field).
REPORT_PLANES = ["SOURCE", "OUTLIER", "PERSIST", "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK",
                 "BLOOM", "SNOWBALL", "HALO", "DICHROIC", "NONFUNC", "TRANSIENT", "HOT", "COLD"]


def _quiet():
    ctx = warnings.catch_warnings()
    ctx.__enter__()
    warnings.simplefilter("ignore", (FITSFixedWarning, AstropyWarning))
    return ctx


def mask_planes(flags_header: fits.Header) -> dict[str, int]:
    planes = {}
    for k in flags_header:
        if k.startswith("MSKN"):
            n = k[4:]
            m = flags_header.get(f"MSKM{n}")
            if m is not None:
                planes[str(flags_header[k]).strip()] = int(m)
    return planes


def target_wcs(ra: float, dec: float, fov: float) -> tuple[WCS, tuple[int, int]]:
    n = int(round(fov * 3600 / PIXEL_SCALE_ARCSEC))
    n += (n + 1) % 2  # odd, so the target sits on the centre pixel
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    s = PIXEL_SCALE_ARCSEC / 3600
    w.wcs.cdelt = [-s, s]  # north up, east left
    return w, (n, n)


def download_cutout(frame: dict, ra: float, dec: float, fov: float, retries: int = 3) -> bytes:
    key = f"{frame['access_url']}|{ra:.5f},{dec:.5f},{fov:.4f}"
    p = cache.path_for("cutout", key, ".fits")
    if p.exists() and p.stat().st_size > 0:
        return p.read_bytes()
    # The cutout box is a bit larger than the field so reprojection never runs off the edge.
    size = round(fov * 1.25 + 2 * PIXEL_SCALE_ARCSEC / 3600, 5)
    url = f"{frame['access_url']}?center={ra},{dec}d&size={size}"
    last = None
    for attempt in range(retries):
        try:
            r = httpx.get(url, timeout=60.0, follow_redirects=True)
            if r.status_code == 503 and attempt == 0:
                # Some files make the cutout service fail every time (seen 14 Nov 2026 on QR3)
                # while the file itself downloads fine. Don't wait for retries: use the full file.
                break
            r.raise_for_status()
            cache.write_atomic(p, r.content)
            return r.content
        except httpx.HTTPError as err:
            last = err
            time.sleep(2 * (attempt + 1))
    # Cutout service failed (503 or repeated errors): fall back to the whole file.
    return download_full(frame)


def download_full(frame: dict) -> bytes:
    """Fallback: the whole Level 2 file (~65 MB), cached. process() reprojects it onto the
    small target grid exactly like a cutout, so the result is identical."""
    p = cache.path_for("full", frame["access_url"], ".fits")
    if p.exists() and p.stat().st_size > 0:
        return p.read_bytes()
    last = None
    for attempt in range(2):
        try:
            r = httpx.get(frame["access_url"], timeout=300.0, follow_redirects=True)
            r.raise_for_status()
            cache.write_atomic(p, r.content)
            return r.content
        except httpx.HTTPError as err:
            last = err
            time.sleep(3)
    raise RuntimeError(f"image download failed ({type(last).__name__})")


def process(frame: dict, ra: float, dec: float, fov: float) -> dict:
    """Returns {'image','variance': float32 2D arrays (row 0 = south), 'meta': dict}."""
    key = f"{frame['access_url']}|{ra:.5f},{dec:.5f},{fov:.4f}|v4"
    p = cache.path_for("aligned", key, ".npz")
    if p.exists():
        with np.load(p, allow_pickle=False) as z:
            return {"image": z["image"], "variance": z["variance"], "meta": _json_meta(z["meta"])}

    raw = download_cutout(frame, ra, dec, fov)
    ctx = _quiet()
    try:
        with fits.open(io.BytesIO(raw)) as hdul:
            hdr = hdul["IMAGE"].header
            img = hdul["IMAGE"].data.astype(np.float64) - hdul["ZODI"].data.astype(np.float64)
            var = hdul["VARIANCE"].data.astype(np.float64)
            flags = hdul["FLAGS"].data.astype(np.int64)
            planes = mask_planes(hdul["FLAGS"].header)
            bad_bits = sum(m for name, m in planes.items() if name in BAD_PLANES)
            sat_bits = sum(m for name, m in planes.items() if name in SATURATED_PLANES)
            # Saturation wins: bright star cores are also flagged NONFUNC/TRANSIENT and have
            # NaN values, but they are real stars, not broken pixels (checked on Barnard's Star).
            sat = (flags & sat_bits) != 0
            bad = ((flags & bad_bits) != 0) & ~sat
            img[bad | ~np.isfinite(img)] = np.nan
            # Fill saturated cores with the brightest valid value before interpolating, so
            # bilinear reprojection does not spread NaN into a dark ring around bright stars.
            peak = np.nanmax(img[~sat]) if np.any(np.isfinite(img[~sat])) else 0.0
            img[sat] = peak
            var[bad | ~np.isfinite(var)] = np.nan

            src = WCS(hdr)
            spec = WCS(hdr, fobj=hdul, key="W")
            cx, cy = src.world_to_pixel(SkyCoord(ra, dec, unit="deg"))
            wl, bw = spec.pixel_to_world(cx, cy)

            tw, shape = target_wcs(ra, dec, fov)
            image, cover = reproject_interp((img, src), tw, shape_out=shape, order="bilinear")
            variance, _ = reproject_interp((var, src), tw, shape_out=shape, order="bilinear")
            image[cover < 0.5] = np.nan
            sat_r, _ = reproject_interp((sat.astype(np.float64), src), tw, shape_out=shape, order="nearest-neighbor")
            saturated = np.nan_to_num(sat_r) > 0.5
            image[saturated] = np.inf

            n = flags.size
            flag_pct = {name: round(100.0 * np.count_nonzero(flags & planes[name]) / n, 2)
                        for name in REPORT_PLANES if name in planes}
            meta = {
                "id": frame["id"],
                "mjd": float(hdr.get("MJD-AVG", frame["mjd"])),
                "date_iso": frame.get("date_iso"),
                "detector": int(hdr.get("DETECTOR", frame["detector"])),
                "wavelength_um": round(float(wl.to_value("um")), 5),
                "bandwidth_um": round(float(bw.to_value("um")), 5),
                "width": shape[1],
                "height": shape[0],
                "pixel_scale_arcsec": PIXEL_SCALE_ARCSEC,
                "bunit": hdr.get("BUNIT", "MJy/sr"),
                "bad_pct": round(100.0 * np.count_nonzero(bad) / n, 2),
                "saturated_px": int(np.count_nonzero(saturated)),
                "coverage_pct": round(100.0 * float(np.mean(cover >= 0.5)), 1),
                "flags_pct": flag_pct,
            }
    finally:
        ctx.__exit__(None, None, None)

    image = image.astype(np.float32)
    variance = variance.astype(np.float32)
    buf = io.BytesIO()
    import json
    np.savez_compressed(buf, image=image, variance=variance, meta=np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8))
    cache.write_atomic(p, buf.getvalue())
    return {"image": image, "variance": variance, "meta": meta}


def _json_meta(arr) -> dict:
    import json
    return json.loads(bytes(arr).decode())


def to_png(image: np.ndarray, lo: float | None = None, hi: float | None = None) -> bytes:
    """Quick-look PNG: asinh stretch, north up (FITS row 0 is south, so flip)."""
    from PIL import Image

    sat = np.isposinf(image)
    finite = image[np.isfinite(image)]
    if finite.size == 0:
        arr = np.zeros(image.shape, dtype=np.uint8)
    else:
        lo = np.percentile(finite, 1) if lo is None else lo
        hi = np.percentile(finite, 99.7) if hi is None else hi
        x = np.clip((image - lo) / max(hi - lo, 1e-12), 0, 1)
        x = np.arcsinh(10 * x) / np.arcsinh(10)
        arr = np.nan_to_num(x * 255, nan=0).astype(np.uint8)
        arr[sat] = 255
    out = io.BytesIO()
    Image.fromarray(np.flipud(arr)).save(out, format="PNG")
    return out.getvalue()
