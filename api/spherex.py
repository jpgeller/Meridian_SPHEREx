"""SPHEREx frame search: which Level 2 images cover a point, in date order.

One SIA row = one exposure (obs_id) on one detector (D1-D6). The six detectors sit side
by side on the sky, so a point usually lands on two detectors per exposure. The same
exposure can appear in DR1 and QR3 (reprocessed); DR1 wins.
"""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import httpx

import astropy.units as u
from astropy.coordinates import SkyCoord

import cache
import framemeta

COLLECTIONS = ["spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep"]
COLLECTION_RANK = {c: i for i, c in enumerate(COLLECTIONS)}  # lower = preferred
VISIT_GAP_DAYS = 5.0
FRAMES_TTL_S = 24 * 3600  # new SPHEREx data arrives weekly; a day is fresh enough
MJD_EPOCH = datetime(1858, 11, 17, tzinfo=timezone.utc)
HIPS_PROPERTIES = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/properties"
META_WORKERS = 16


def mjd_to_iso(mjd: float) -> str:
    return (MJD_EPOCH + timedelta(days=float(mjd))).isoformat(timespec="seconds").replace("+00:00", "Z")


def frame_id(obs_id: str, detector: int) -> str:
    return f"{obs_id}_D{detector}"


def _detector(bandpass: str) -> int:
    # 'SPHEREx-D3' -> 3
    return int(str(bandpass).rsplit("D", 1)[-1])


def _query(ra: float, dec: float) -> list[dict]:
    from astroquery.ipac.irsa import Irsa  # slow import; keep it off the startup path

    coord = SkyCoord(ra, dec, unit="deg")
    table = Irsa.query_sia(pos=(coord, 1 * u.arcsec), collection=COLLECTIONS)
    best: dict[str, dict] = {}
    for row in table:
        det = _detector(row["energy_bandpassname"])
        fid = frame_id(str(row["obs_id"]), det)
        rec = {
            "id": fid,
            "obs_id": str(row["obs_id"]),
            "collection": str(row["obs_collection"]),
            "detector": det,
            "mjd": float(row["t_min"]),
            "access_url": str(row["access_url"]),
            "em_min_um": round(float(row["em_min"]) * 1e6, 4),
            "em_max_um": round(float(row["em_max"]) * 1e6, 4),
        }
        old = best.get(fid)
        if old is None or COLLECTION_RANK[rec["collection"]] < COLLECTION_RANK[old["collection"]]:
            best[fid] = rec
    return sorted(best.values(), key=lambda r: (r["mjd"], r["detector"]))


def _add_visits(frames: list[dict]) -> list[dict]:
    visit, last = -1, None
    for f in frames:
        if last is None or f["mjd"] - last > VISIT_GAP_DAYS:
            visit += 1
        f["visit"] = visit
        f["date_iso"] = mjd_to_iso(f["mjd"])
        last = f["mjd"]
    return frames


def remember(frames: list[dict]) -> None:
    """Index id -> frame so /api/cutout can look up the access_url by id."""
    for f in frames:
        cache.put_json("frame", f["id"], f)


def lookup(fid: str) -> dict | None:
    return cache.get_json("frame", fid)


def frames_at(ra: float, dec: float, refresh: bool = False) -> dict:
    key = f"{ra:.3f},{dec:.3f}"
    if not refresh:
        hit = cache.get_json("frames", key, ttl_s=FRAMES_TTL_S)
        if hit is not None:
            return {**hit, "cached": True}
    frames = _add_visits(_query(ra, dec))
    remember(frames)
    visits = []
    for v in sorted({f["visit"] for f in frames}):
        vf = [f for f in frames if f["visit"] == v]
        visits.append({
            "visit": v,
            "start_iso": vf[0]["date_iso"],
            "end_iso": vf[-1]["date_iso"],
            "n_frames": len(vf),
            "detectors": sorted({f["detector"] for f in vf}),
        })
    result = {
        "ra": ra,
        "dec": dec,
        "n_frames": len(frames),
        "n_visits": len(visits),
        "visits": visits,
        "frames": frames,
        "queried_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    cache.put_json("frames", key, result)
    return {**result, "cached": False}


def cube_wavelengths() -> list[float]:
    """Centre wavelength (um) of each of the 102 cube bands, from the HiPS properties."""
    hit = cache.get_json("cube", "wavelengths", ttl_s=7 * 24 * 3600)
    if hit:
        return hit
    text = httpx.get(HIPS_PROPERTIES, timeout=20.0, follow_redirects=True).text
    m = re.search(r"data_cube_crval3_arr\s*=\s*(.+)", text)
    if not m:
        raise RuntimeError("cube wavelengths not found in HiPS properties")
    values = [float(v) for v in m.group(1).split()]
    cache.put_json("cube", "wavelengths", values)
    return values


def frames_with_meta(ra: float, dec: float, refresh: bool = False) -> dict:
    """frames_at() plus, for every frame, the wavelength seen at (ra, dec) and the nearest
    cube band. Two small Range requests per new frame, run in parallel, cached forever."""
    base = frames_at(ra, dec, refresh)
    cube = cube_wavelengths()
    frames = base["frames"]
    with httpx.Client(timeout=30.0, follow_redirects=True) as client:
        def one(f):
            try:
                return framemeta.frame_meta(client, f, ra, dec)
            except Exception as err:  # one bad file must not sink the whole field
                return {"error": str(err)}
        with ThreadPoolExecutor(max_workers=META_WORKERS) as pool:
            metas = list(pool.map(one, frames))
    out = []
    for f, m in zip(frames, metas):
        rec = {**f, **{k: v for k, v in m.items() if k not in ("x", "y")}}
        if "wavelength_um" in m:
            rec["band"] = framemeta.nearest_band(m["wavelength_um"], cube)
        out.append(rec)
    return {**base, "frames": out}


def field_frames(ra: float, dec: float, band: int, refresh: bool = False) -> dict:
    """Frames that saw (ra, dec) in cube band `band`, oldest first, one list per visit."""
    data = frames_with_meta(ra, dec, refresh)
    picked = [f for f in data["frames"] if f.get("band") == band and f.get("inside")]
    return {
        "ra": ra, "dec": dec, "band": band,
        "band_wavelength_um": cube_wavelengths()[band],
        "n_frames": len(picked),
        "visits": sorted({f["visit"] for f in picked}),
        "frames": picked,
        "all_bands_seen": sorted({f["band"] for f in data["frames"] if "band" in f}),
    }
