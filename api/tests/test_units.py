"""Offline unit tests (no network). Run from meridian/api:  ./.venv/bin/python -m pytest -q"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

import resolve  # noqa: E402
import spherex  # noqa: E402

SESAME_XML = """<?xml version="1.0"?><Sesame><Target><name>Barnard's Star</name>
<Resolver name="S=Simbad"><oname>NAME Barnard's star</oname><otype>BY*</otype>
<jradeg>269.4520769586187</jradeg><jdedeg>4.69336496657667</jdedeg>
<pm><v>10393.349</v><pmRA>-801.551</pmRA><pmDE>10362.394</pmDE></pm></Resolver></Target></Sesame>"""


def test_parse_sesame_reads_position_and_proper_motion():
    d = resolve.parse_sesame(SESAME_XML)
    assert d["name"] == "NAME Barnard's star"
    assert d["pmdec"] == pytest.approx(10362.394)
    assert d["ra_j2000"] == pytest.approx(269.45207696)


def test_parse_sesame_not_found():
    with pytest.raises(resolve.NotFound):
        resolve.parse_sesame("<Sesame><Target><INFO>*** Nothing found ***</INFO></Target></Sesame>")


def test_propagate_barnard_moves_about_10_arcsec_per_year():
    ra, dec = resolve.propagate(269.4520769586187, 4.69336496657667, -801.551, 10362.394, 26.0)
    moved_arcsec = math.hypot((ra - 269.4520769586187) * math.cos(math.radians(dec)), dec - 4.69336496657667) * 3600
    assert moved_arcsec == pytest.approx(10.39 * 26, rel=0.01)
    assert dec > 4.69336496657667  # Barnard's Star moves north


def test_visits_split_on_gaps_over_five_days():
    frames = [{"mjd": m, "detector": 1} for m in (100.0, 100.5, 103.0, 120.0, 121.0, 300.0)]
    out = spherex._add_visits(frames)
    assert [f["visit"] for f in out] == [0, 0, 0, 1, 1, 2]
    assert out[0]["date_iso"] == "1859-02-25T00:00:00Z"


def test_query_dedupes_dr1_over_qr3(monkeypatch):
    rows = [
        {"obs_id": "X_1", "obs_collection": "spherex_qr3", "energy_bandpassname": "SPHEREx-D3", "t_min": 1.0,
         "access_url": "qr3-url", "em_min": 1.6e-6, "em_max": 2.4e-6},
        {"obs_id": "X_1", "obs_collection": "spherex_dr1", "energy_bandpassname": "SPHEREx-D3", "t_min": 1.0,
         "access_url": "dr1-url", "em_min": 1.6e-6, "em_max": 2.4e-6},
        {"obs_id": "X_1", "obs_collection": "spherex_dr1", "energy_bandpassname": "SPHEREx-D6", "t_min": 1.0,
         "access_url": "d6-url", "em_min": 4.4e-6, "em_max": 5.0e-6},
    ]

    class FakeIrsa:
        @staticmethod
        def query_sia(pos, collection):
            return rows

    import astroquery.ipac.irsa as irsa_mod
    monkeypatch.setattr(irsa_mod, "Irsa", FakeIrsa)
    out = spherex._query(10.0, 20.0)
    assert [f["id"] for f in out] == ["X_1_D3", "X_1_D6"]
    assert out[0]["access_url"] == "dr1-url"


def test_target_grid_is_odd_and_centred():
    import cutouts
    w, shape = cutouts.target_wcs(133.7578, -7.2420, 0.1)
    assert shape == (59, 59)
    x, y = w.world_to_pixel_values(133.7578, -7.2420)
    assert (round(float(x), 6), round(float(y), 6)) == (29.0, 29.0)  # 0-based centre of 59
    assert w.wcs.cdelt[0] < 0 < w.wcs.cdelt[1]  # east left, north up


def test_mask_planes_read_from_header():
    from astropy.io import fits
    import cutouts
    h = fits.Header()
    h["MSKN0000"], h["MSKM0000"] = "TRANSIENT", 1
    h["MSKN0021"], h["MSKM0021"] = "SOURCE", 2097152
    planes = cutouts.mask_planes(h)
    assert planes == {"TRANSIENT": 1, "SOURCE": 2097152}
    assert "SOURCE" not in cutouts.BAD_PLANES and "OUTLIER" not in cutouts.BAD_PLANES
