"""Spectrum of a point from every SPHEREx frame that covers it (forced photometry).

SPHEREx's filter changes wavelength across each detector, so every exposure sees a
point at one wavelength per detector; over many exposures the 102 bands fill in.
Photometry runs on the aligned field cutouts (cutouts.process), so the same cache feeds
the time-lapse and the spectrum.

Measurement per frame:
  * aperture radius 2 px (12.3"), background = median of an annulus 4-7 px
  * flux in mJy: sum(MJy/sr) x pixel solid angle (6.15"^2) x 1e9; no aperture correction
    (relative shape is right; absolute fluxes are ~10-20% low for point sources)
  * error from the VARIANCE plane plus the background uncertainty
  * flags: 'saturated' if any aperture pixel is saturated, 'partial' if >30% has no data

Large fields are computed in rounds (max_new frames per call) so the first answer is fast
and the browser fills in the rest.
"""
from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor

import httpx
import numpy as np

import context
import cutouts
import framemeta
import spherex

R_AP, R_IN, R_OUT = 2.0, 4.0, 7.0
PIX_SR = (cutouts.PIXEL_SCALE_ARCSEC / 206264.806) ** 2
TO_MJY = PIX_SR * 1e9  # MJy/sr * sr -> MJy -> mJy
WORKERS = 4
PER_BAND = 2  # deep fields have thousands of frames; a spectrum needs only a few per band


def _photometry(image: np.ndarray, variance: np.ndarray, x: float, y: float) -> dict | None:
    h, w = image.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx - x, yy - y)
    ap = r <= R_AP
    ann = (r >= R_IN) & (r <= R_OUT)
    if not ap.any():
        return None
    vals = image[ap]
    saturated = bool(np.isposinf(vals).any())
    good = np.isfinite(vals)
    if good.mean() < 0.7:
        return {"flag": "partial"}
    bg_vals = image[ann]
    bg_vals = bg_vals[np.isfinite(bg_vals)]
    if bg_vals.size < 8:
        return {"flag": "partial"}
    bg = float(np.median(bg_vals))
    bg_sigma = float(1.4826 * np.median(np.abs(bg_vals - bg)))
    n = int(ap.sum())
    # fill the few missing aperture pixels with the background so the sum is not biased low
    filled = np.where(good, vals, bg)
    flux = float(np.sum(filled - bg))
    var = variance[ap]
    var_sum = float(np.nansum(np.where(np.isfinite(var), var, np.nanmedian(var))))
    err = math.sqrt(max(var_sum, 0.0) + (n * bg_sigma) ** 2 / bg_vals.size)
    return {
        "flux_mjy": round(flux * TO_MJY, 5),
        "err_mjy": round(err * TO_MJY, 5),
        "flag": "saturated" if saturated else "",
    }


def _select(frames: list[dict], per_band: int) -> list[dict]:
    """At most `per_band` frames per cube band (most recent first), so deep fields such as
    R Dra (2493 frames) cost ~200 cutouts instead of ~10 GB."""
    by_band: dict[int, list[dict]] = {}
    for f in sorted(frames, key=lambda f: -f["mjd"]):
        lst = by_band.setdefault(f.get("band", -1), [])
        if len(lst) < per_band:
            lst.append(f)
    return [f for lst in by_band.values() for f in lst]


def spectrum(ra0: float, dec0: float, fov: float, ra: float, dec: float, max_new: int = 40,
             per_band: int = PER_BAND) -> dict:
    """Photometry at (ra, dec) using the field centred on (ra0, dec0) with size fov."""
    tw, (n, _) = cutouts.target_wcs(ra0, dec0, fov)
    x, y = (float(v) for v in tw.world_to_pixel_values(ra, dec))
    if not (R_OUT <= x <= n - 1 - R_OUT and R_OUT <= y <= n - 1 - R_OUT):
        raise ValueError("point is too close to the field edge for photometry")

    frames = [f for f in spherex.frames_with_meta(ra0, dec0)["frames"] if f.get("inside") and not f.get("error")]
    frames = _select(frames, per_band)
    cached = [f for f in frames if cutouts.is_processed(f, ra0, dec0, fov)]
    todo = [f for f in frames if not cutouts.is_processed(f, ra0, dec0, fov)][:max_new]

    def measure(f):
        try:
            res = cutouts.process(f, ra0, dec0, fov)
        except Exception as err:  # one frame failing must not sink the spectrum
            return {"id": f["id"], "error": str(err)}
        phot = _photometry(res["image"], res["variance"], x, y)
        if phot is None:
            return None
        return {"id": f["id"], "mjd": res["meta"]["mjd"], "detector": res["meta"]["detector"], "visit": f["visit"], **phot}

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        measured = list(pool.map(measure, cached + todo))

    # Wavelength at the measured point (not the field centre): cheap header reads, cached.
    by_id = {f["id"]: f for f in frames}
    points = [m for m in measured if m and "flux_mjy" in m]
    with httpx.Client(timeout=30.0, follow_redirects=True) as client:
        def wl(p):
            try:
                meta = framemeta.frame_meta(client, by_id[p["id"]], ra, dec)
                return meta["wavelength_um"], meta["bandwidth_um"]
            except Exception:
                f = by_id[p["id"]]
                return f.get("wavelength_um"), f.get("bandwidth_um")
        with ThreadPoolExecutor(max_workers=16) as pool:
            wls = list(pool.map(wl, points))
    for p, (w, bw) in zip(points, wls):
        p["wavelength_um"] = w
        p["bandwidth_um"] = bw
    points = [p for p in points if p.get("wavelength_um")]
    points.sort(key=lambda p: p["wavelength_um"])
    done = len(cached) + len(todo)
    return {
        "blends": _blends(ra, dec, points),
        "ra": ra, "dec": dec, "field": {"ra": ra0, "dec": dec0, "fov": fov},
        "n_frames": len(frames),
        "n_done": done,
        "complete": done >= len(frames),
        "units": "mJy (no aperture correction)",
        "aperture_arcsec": R_AP * cutouts.PIXEL_SCALE_ARCSEC,
        "points": points,
        "failed": sum(1 for m in measured if m and "error" in m),
    }


def _blends(ra: float, dec: float, points: list[dict]) -> list[dict]:
    """Gaia stars inside the aperture at the date of the measurements: their light is in the
    spectrum too (WISE 0855 sits 3.3" from a G=16.3 star in 2026, for example)."""
    if not points:
        return []
    mjd = sorted(p["mjd"] for p in points)[len(points) // 2]
    try:
        g = context.gaia_sources(ra, dec, 0.02, mjd)
    except Exception:
        return []
    out = []
    for star in g["sources"]:
        sep = math.hypot((star["ra"] - ra) * math.cos(math.radians(dec)), star["dec"] - dec) * 3600
        if sep <= R_AP * cutouts.PIXEL_SCALE_ARCSEC and star["g_mag"] is not None and star["g_mag"] < 20:
            out.append({"source_id": star["source_id"], "sep_arcsec": round(sep, 1), "g_mag": round(star["g_mag"], 1),
                        "bp_rp": None if star["bp_rp"] is None else round(star["bp_rp"], 2)})
    return sorted(out, key=lambda b: b["sep_arcsec"])
