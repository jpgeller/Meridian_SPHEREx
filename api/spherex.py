"""SPHEREx frame search: which Level 2 images cover a point, in date order.

One SIA row = one exposure (obs_id) on one detector (D1-D6). The six detectors sit side
by side on the sky, so a point usually lands on two detectors per exposure. The same
exposure can appear in DR1 and QR3 (reprocessed); DR1 wins.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import astropy.units as u
from astropy.coordinates import SkyCoord

import cache

COLLECTIONS = ["spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep"]
COLLECTION_RANK = {c: i for i, c in enumerate(COLLECTIONS)}  # lower = preferred
VISIT_GAP_DAYS = 5.0
FRAMES_TTL_S = 24 * 3600  # new SPHEREx data arrives weekly; a day is fresh enough
MJD_EPOCH = datetime(1858, 11, 17, tzinfo=timezone.utc)


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
