"""Context for the field view: the same patch seen by WISE (2010-2024 images) and Gaia
(star positions and motions).

WISE: the WiseView image service (Backyard Worlds / AMNH; unofficial, so everything is
cached). It returns yearly W1/W2 frames as PNGs plus a TAN WCS for the cutout. The PNG
rows run north-up (row 0 = north), which we verified against Gaia stars (within 1-2 px).
We reproject every frame onto a north-up grid centred on the target at 2.75"/px, so WISE
and SPHEREx fields line up by construction.

Gaia: DR3 cone from MAST, positions at epoch 2016.0, moved to any date with proper motion.
"""
from __future__ import annotations

import io
import math
import time
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.wcs import WCS
from PIL import Image
from reproject import reproject_interp

import cache

WISEVIEW_API = "https://moo23y1au0.execute-api.us-west-2.amazonaws.com/default/png-animation"
WISEVIEW_S3 = "https://amnh-citsci-public.s3-us-west-2.amazonaws.com/"
WISE_PIXEL_ARCSEC = 2.75
WISE_TTL_S = 30 * 24 * 3600  # WISE data are final; a month is plenty
GAIA_EPOCH_MJD = 57388.5  # 2016.0
MJD_EPOCH = datetime(1858, 11, 17, tzinfo=timezone.utc)
MAX_GAIA = 3000


def mjd_to_iso(mjd: float) -> str:
    return (MJD_EPOCH + timedelta(days=float(mjd))).isoformat(timespec="seconds").replace("+00:00", "Z")


def _wise_grid(ra: float, dec: float, fov: float) -> tuple[WCS, tuple[int, int]]:
    n = int(round(fov * 3600 / WISE_PIXEL_ARCSEC))
    n += (n + 1) % 2
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    s = WISE_PIXEL_ARCSEC / 3600
    w.wcs.cdelt = [-s, s]
    return w, (n, n)


def _wiseview_query(ra: float, dec: float, size_px: int, band: int) -> dict:
    key = f"{ra:.5f},{dec:.5f}|{size_px}|W{band}"
    hit = cache.get_json("wiseview", key, ttl_s=WISE_TTL_S)
    if hit:
        return hit
    params = dict(
        ra=ra, dec=dec, band=band, size=size_px, max_dyr=0, minbright=-50, maxbright=500, invert=0,
        stretch=0.5, diff=0, scandir=0, outer=0, neowise=0, window=0.5, diff_window=1, unique=1,
        smooth_scan=0, shift=0, pmx=0, pmy=0, synth_a=0, synth_b=0,
    )
    last = None
    for attempt in range(3):
        try:
            r = httpx.get(WISEVIEW_API, params=params, timeout=90.0)
            r.raise_for_status()
            data = r.json()
            if not data.get("ims"):
                raise RuntimeError("WiseView returned no images")
            cache.put_json("wiseview", key, data)
            return data
        except (httpx.HTTPError, ValueError, RuntimeError) as err:
            last = err
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"WiseView unavailable ({type(last).__name__})")


def _png(key: str) -> bytes:
    p = cache.path_for("wisepng", key, ".png")
    if p.exists():
        return p.read_bytes()
    r = httpx.get(WISEVIEW_S3 + key, timeout=60.0)
    r.raise_for_status()
    cache.write_atomic(p, r.content)
    return r.content


def wise_frames(ra: float, dec: float, fov: float, band: int = 2) -> dict:
    """List WISE epochs for this field. Images are served by wise_frame_png()."""
    size_px = min(600, int(math.ceil(fov * 1.3 * 3600 / WISE_PIXEL_ARCSEC)))
    data = _wiseview_query(ra, dec, size_px, band)
    frames = []
    for i, (key, mjds) in enumerate(zip(data["ims"], data["mjds"])):
        mjd = float(np.mean(mjds))
        frames.append({"index": i, "mjd": mjd, "date_iso": mjd_to_iso(mjd), "key": key})
    return {
        "ra": ra, "dec": dec, "fov": fov, "band": band,
        "mission": "WISE/NEOWISE (unWISE coadds via WiseView)",
        "wavelength_um": 3.4 if band == 1 else 4.6,
        "pixel_scale_arcsec": WISE_PIXEL_ARCSEC,
        "frames": frames,
        "_wcs": {k: data[k] for k in ("CRPIX1", "CRPIX2", "CRVAL1", "CRVAL2", "NAXIS1", "NAXIS2")},
    }


def wise_frame_png(ra: float, dec: float, fov: float, band: int, index: int) -> bytes:
    """One WISE epoch reprojected north-up onto a grid centred on (ra, dec)."""
    key = f"{ra:.5f},{dec:.5f}|{fov:.4f}|W{band}|{index}|v1"
    p = cache.path_for("wisealigned", key, ".png")
    if p.exists():
        return p.read_bytes()
    info = wise_frames(ra, dec, fov, band)
    if not 0 <= index < len(info["frames"]):
        raise IndexError("no such WISE epoch")
    img = np.asarray(Image.open(io.BytesIO(_png(info["frames"][index]["key"]))).convert("L"), dtype=np.float64)
    img = np.flipud(img)  # PNG row 0 is north; FITS-style arrays start at the south
    wc = info["_wcs"]
    src = WCS(naxis=2)
    src.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    src.wcs.crval = [wc["CRVAL1"], wc["CRVAL2"]]
    src.wcs.crpix = [wc["CRPIX1"], wc["CRPIX2"]]
    src.wcs.cd = [[-WISE_PIXEL_ARCSEC / 3600, 0], [0, WISE_PIXEL_ARCSEC / 3600]]
    tw, shape = _wise_grid(ra, dec, fov)
    out, cover = reproject_interp((img, src), tw, shape_out=shape, order="bilinear")
    out = np.nan_to_num(np.where(cover > 0.5, out, 0), nan=0)
    buf = io.BytesIO()
    Image.fromarray(np.flipud(np.clip(out, 0, 255)).astype(np.uint8)).save(buf, format="PNG")
    cache.write_atomic(p, buf.getvalue())
    return buf.getvalue()


# --- Gaia --------------------------------------------------------------------------
def _gaia_cone(ra: float, dec: float, radius_deg: float) -> list[dict]:
    key = f"{ra:.4f},{dec:.4f}|{radius_deg:.4f}"
    hit = cache.get_json("gaia", key)
    if hit is not None:
        return hit
    from astroquery.mast import Catalogs  # slow import
    import astropy.units as u

    t = Catalogs.query_region(SkyCoord(ra, dec, unit="deg"), radius=radius_deg * u.deg, catalog="Gaia", version=3)
    t.sort("phot_g_mean_mag")
    rows = []
    for r in t[:MAX_GAIA]:
        def num(name):
            v = r[name]
            return None if np.ma.is_masked(v) or not np.isfinite(float(v)) else float(v)
        rows.append({
            "source_id": str(r["source_id"]),
            "ra": float(r["ra"]), "dec": float(r["dec"]),
            "pmra": num("pmra"), "pmdec": num("pmdec"), "parallax": num("parallax"),
            "g_mag": num("phot_g_mean_mag"), "bp_rp": num("bp_rp"),
        })
    cache.put_json("gaia", key, rows)
    return rows


def gaia_sources(ra: float, dec: float, fov: float, mjd: float | None = None) -> dict:
    """Gaia DR3 stars in the field, positions moved from 2016.0 to `mjd` (if given)."""
    # Margin for fast stars: 10"/yr over a few decades still fits inside +0.05 deg.
    radius = fov * 0.75 + 0.05
    rows = _gaia_cone(round(ra, 4), round(dec, 4), round(radius, 4))
    years = 0.0 if mjd is None else (mjd - GAIA_EPOCH_MJD) / 365.25
    out = []
    for r in rows:
        ra2, dec2 = r["ra"], r["dec"]
        if years and r["pmra"] is not None and r["pmdec"] is not None:
            cosd = max(math.cos(math.radians(r["dec"])), 1e-6)
            ra2 = r["ra"] + r["pmra"] * years / 3.6e6 / cosd
            dec2 = r["dec"] + r["pmdec"] * years / 3.6e6
        # keep only what falls inside the square field (plus a little)
        dx = (ra2 - ra) * math.cos(math.radians(dec))
        dy = dec2 - dec
        if abs(dx) <= fov * 0.55 and abs(dy) <= fov * 0.55:
            out.append({**r, "ra": ra2, "dec": dec2})
    return {
        "ra": ra, "dec": dec, "fov": fov,
        "epoch_mjd": mjd if mjd is not None else GAIA_EPOCH_MJD,
        "catalog": "Gaia DR3 (MAST)",
        "n": len(out),
        "sources": out,
    }
