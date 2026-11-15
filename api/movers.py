"""Objects that move across a field fast enough to show over the WISE + SPHEREx baseline.

Used by the change video (web/src/field/changeModel.js), which slides each mover along its
catalogue motion between the real images. Two catalogues:
  - Gaia DR3 (ESA archive; positions at 2016.0, motions in mas/yr) for ordinary stars.
  - CatWISE2020 (IRSA cone search; motions from WISE 3.4/4.6 um, arcsec/yr) for cold brown
    dwarfs that Gaia cannot see, such as WISE 0855. CatWISE often lists a very fast mover
    several times along its track; duplicates are merged after moving all positions to one date.
"""
from __future__ import annotations

import csv
import io
import math
import time

import httpx

import cache
from context import GAIA_EPOCH_MJD, _gaia_cone

CATWISE_SCS = "https://irsa.ipac.caltech.edu/SCS"
EPOCH_MJD = 61041.0  # 2026.0: every mover's position is given at this date
MIN_PM_MAS = 150  # 150 mas/yr = 2.4" over 16 years, about one WISE pixel
CATWISE_MIN_PM_MAS = 300  # CatWISE motions are noisier
CATWISE_MIN_SNR = 5  # motion / its error
CATWISE_MAX_W2 = 16.5
MERGE_ARCSEC = 8.0
MAX_MOVERS = 12
# IRSA's cone search answers 0.08 deg in ~1.5 s but fails or times out beyond ~0.1 deg (Nov 2026),
# so CatWISE covers the middle of the field, where the target is.
CATWISE_MAX_RADIUS = 0.08


def _num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _move(ra: float, dec: float, pmra_mas: float, pmdec_mas: float, from_mjd: float, to_mjd: float) -> tuple[float, float]:
    years = (to_mjd - from_mjd) / 365.25
    cosd = max(math.cos(math.radians(dec)), 1e-6)
    return ra + pmra_mas * years / 3.6e6 / cosd, dec + pmdec_mas * years / 3.6e6


def _sep_arcsec(a: dict, b: dict) -> float:
    dra = (a["ra"] - b["ra"]) * math.cos(math.radians(a["dec"]))
    return math.hypot(dra, a["dec"] - b["dec"]) * 3600


def _catwise_cone(ra: float, dec: float, radius_deg: float) -> list[dict]:
    key = f"{ra:.4f},{dec:.4f}|{radius_deg:.4f}"
    hit = cache.get_json("catwise", key)
    if hit is not None:
        return hit
    last = None
    for attempt in range(2):
        try:
            r = httpx.get(CATWISE_SCS, params={"table": "catwise_2020", "RA": ra, "DEC": dec, "SR": radius_deg, "format": "csv"}, timeout=httpx.Timeout(20.0, connect=6.0))
            r.raise_for_status()
            break
        except httpx.HTTPError as err:
            last = err
            time.sleep(2 * (attempt + 1))
    else:
        raise RuntimeError(f"CatWISE unavailable ({type(last).__name__})")
    rows = []
    for rec in csv.DictReader(io.StringIO(r.text)):
        vals = {k: _num(rec.get(k)) for k in ("ra_pm", "dec_pm", "pmra", "pmdec", "sigpmra", "sigpmdec", "meanobsmjd", "w2mpro_pm")}
        if None in vals.values():
            continue
        rows.append({"name": rec["source_name"], **vals})
    cache.put_json("catwise", key, rows)
    return rows


def merge_movers(candidates: list[dict]) -> list[dict]:
    """Drop duplicates (same object within MERGE_ARCSEC at EPOCH_MJD): Gaia first, then the most precise."""
    order = sorted(candidates, key=lambda m: (m["catalog"] != "Gaia DR3", m.get("pm_err_mas", 0)))
    kept: list[dict] = []
    for m in order:
        if all(_sep_arcsec(m, k) > MERGE_ARCSEC for k in kept):
            kept.append(m)
    return sorted(kept, key=lambda m: -math.hypot(m["pmra"], m["pmdec"]))[:MAX_MOVERS]


def field_movers(ra: float, dec: float, fov: float) -> dict:
    radius = fov * 0.75 + 0.06  # fast movers may have been outside the field in 2010
    found: list[dict] = []
    notes = []
    answered = 0  # catalogues that answered (an answer with no fast movers is still an answer)
    try:
        gaia = _gaia_cone(round(ra, 4), round(dec, 4), round(radius, 4))
        answered += 1
        for g in gaia:
            if g["pmra"] is None or g["pmdec"] is None or math.hypot(g["pmra"], g["pmdec"]) < MIN_PM_MAS:
                continue
            ra2, dec2 = _move(g["ra"], g["dec"], g["pmra"], g["pmdec"], GAIA_EPOCH_MJD, EPOCH_MJD)
            found.append({"id": f"Gaia DR3 {g['source_id']}", "catalog": "Gaia DR3", "ra": ra2, "dec": dec2,
                          "pmra": g["pmra"], "pmdec": g["pmdec"], "mag": g["g_mag"], "band": "G"})
    except Exception as err:  # one catalogue down should not hide the other
        notes.append(f"Gaia unavailable: {err}")
    try:
        cat = _catwise_cone(round(ra, 4), round(dec, 4), round(min(radius, CATWISE_MAX_RADIUS), 4))
        answered += 1
        for c in cat:
            pmra, pmdec = c["pmra"] * 1000, c["pmdec"] * 1000
            pm = math.hypot(pmra, pmdec)
            err = 1000 * math.hypot(c["sigpmra"], c["sigpmdec"]) / math.sqrt(2)
            if pm < CATWISE_MIN_PM_MAS or pm < CATWISE_MIN_SNR * err or c["w2mpro_pm"] > CATWISE_MAX_W2:
                continue
            ra2, dec2 = _move(c["ra_pm"], c["dec_pm"], pmra, pmdec, c["meanobsmjd"], EPOCH_MJD)
            found.append({"id": f"CatWISE {c['name']}", "catalog": "CatWISE2020", "ra": ra2, "dec": dec2,
                          "pmra": pmra, "pmdec": pmdec, "pm_err_mas": err, "mag": c["w2mpro_pm"], "band": "W2"})
    except Exception as err:
        notes.append(f"CatWISE unavailable: {err}")
    if not answered:  # 15 Nov 2026: Gaia answered with no movers while CatWISE was down, and this said 503
        raise RuntimeError("; ".join(notes))
    movers = merge_movers(found)
    return {"ra": ra, "dec": dec, "fov": fov, "epoch_mjd": EPOCH_MJD, "min_pm_mas": MIN_PM_MAS,
            "catalogs": "Gaia DR3 + CatWISE2020 (IRSA)", "notes": notes, "movers": movers}
