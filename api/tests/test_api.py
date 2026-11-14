"""API smoke tests against the warmed cache (run `python -m ingest --targets showcase` first).

Tests that need cached data skip themselves when it is missing, so the suite never hits
the network: `./.venv/bin/python -m pytest -q`
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cache  # noqa: E402
import context  # noqa: E402
import cutouts  # noqa: E402
import main  # noqa: E402
import spherex  # noqa: E402

client = TestClient(main.app)

# WISE 0855 field used during development (fully cached by the Step 5-10 work and ingest)
RA, DEC, FOV = 133.7578, -7.2420, 0.1


def cached_frames(ra=RA, dec=DEC):
    hit = cache.get_json("frames", f"{ra:.3f},{dec:.3f}")
    if not hit:
        pytest.skip("frame list not cached; run ingest first")
    return hit


def test_health():
    assert client.get("/api/health").json() == {"ok": True}


def test_bad_input_is_rejected():
    assert client.get("/api/frames", params={"ra": 400, "dec": 0}).status_code == 422
    assert client.get("/api/cutout", params={"id": "nope", "ra": 1, "dec": 1}).status_code == 404


def test_frames_from_cache():
    cached_frames()
    r = client.get("/api/frames", params={"ra": RA, "dec": DEC})
    d = r.json()
    assert r.status_code == 200 and d["cached"] is True
    assert d["n_frames"] > 100 and d["n_visits"] >= 4
    mjds = [f["mjd"] for f in d["frames"]]
    assert mjds == sorted(mjds)


def test_cutout_shape_and_wavelength():
    frames = cached_frames()["frames"]
    f = next((f for f in frames if cutouts.is_processed(f, RA, DEC, FOV)), None)
    if f is None:
        pytest.skip("no processed cutout cached")
    r = client.get("/api/cutout", params={"id": f["id"], "ra": RA, "dec": DEC, "fov": FOV})
    assert r.status_code == 200
    w, h = int(r.headers["x-width"]), int(r.headers["x-height"])
    assert (w, h) == (59, 59)
    data = np.frombuffer(r.content, "<f4")
    assert data.size == w * h and np.isfinite(data).mean() > 0.8
    import json
    meta = json.loads(r.headers["x-meta"])
    assert 0.74 <= meta["wavelength_um"] <= 5.01
    assert r.headers["cache-control"] == "no-cache"


def test_gaia_moves_barnard_about_10_arcsec_per_year(monkeypatch):
    # Gaia DR3 values for Barnard's Star at 2016.0 (ESA archive)
    star = {"source_id": "4472832130942575872", "ra": 269.44850252543836, "dec": 4.739420051112412,
            "pmra": -801.5509783684709, "pmdec": 10362.394206546573, "parallax": 546.98, "g_mag": 8.19, "bp_rp": 2.83}
    monkeypatch.setattr(context, "_gaia_cone", lambda ra, dec, r: [star])
    later = context.gaia_sources(star["ra"], star["dec"] + 0.03, 0.2, mjd=context.GAIA_EPOCH_MJD + 10 * 365.25)["sources"][0]
    moved = math.hypot((later["ra"] - star["ra"]) * math.cos(math.radians(star["dec"])), later["dec"] - star["dec"]) * 3600
    assert moved == pytest.approx(103.9, abs=0.5)  # 10.39"/yr over 10 years
    assert later["dec"] > star["dec"]  # north


def test_spectrum_rejects_points_near_the_edge():
    cached_frames()
    r = client.get("/api/spectrum", params={"ra": RA + 0.049, "dec": DEC, "ra0": RA, "dec0": DEC, "fov": FOV, "max_new": 0})
    assert r.status_code == 400


def test_spectrum_from_cache_has_d6_flux_like_wise():
    cached_frames()
    r = client.get("/api/spectrum", params={"ra": RA, "dec": DEC, "ra0": RA, "dec0": DEC, "fov": FOV, "max_new": 0})
    d = r.json()
    d6 = [p["flux_mjy"] for p in d["points"] if p["detector"] == 6]
    if len(d6) < 10:
        pytest.skip("not enough D6 points cached")
    # WISE 0855: W2 = 13.9 mag ~ 0.47 mJy at 4.6 um; SPHEREx D6 median should be close
    assert 0.3 < float(np.median(d6)) < 0.7
    assert any(b["g_mag"] < 17 for b in d["blends"])  # the G=16.3 neighbour is reported


def test_skypatch_is_twice_as_sharp_and_north_up():
    import cutouts as cu
    import skypatch
    frames = cache.get_json("frames", "269.446,4.768")
    if not frames:
        pytest.skip("Barnard's Star frames not cached")
    r = client.get("/api/skypatch", params={"ra": 269.44627, "dec": 4.7682, "fov": 0.25, "band": 37, "smooth": False})
    if r.status_code != 200:
        pytest.skip(f"patch not available offline ({r.status_code})")
    m = r.json()
    w = m["wcs"]
    assert w["CD1_1"] < 0 < w["CD2_2"]  # east left, north up (as Aladin expects for PNG rows)
    assert abs(w["CD2_2"] * 3600 - cu.PIXEL_SCALE_ARCSEC) < 1e-6  # 6.15"/px, vs 12.9" for the HiPS tiles
    png = client.get(m["url"])
    assert png.status_code == 200 and png.headers["content-type"] == "image/png"
    assert skypatch.MAX_FOV == 0.6 and m["lo"] < m["hi"]
