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


def test_movers_merge_keeps_gaia_and_drops_catwise_duplicates():
    import movers
    gaia = {"id": "g", "catalog": "Gaia DR3", "ra": 10.0, "dec": 0.0, "pmra": -800.0, "pmdec": 10000.0}
    cw_dup = {"id": "c1", "catalog": "CatWISE2020", "ra": 10.0 + 3 / 3600, "dec": 0.0, "pmra": -790.0, "pmdec": 9900.0, "pm_err_mas": 50}
    cw_other = {"id": "c2", "catalog": "CatWISE2020", "ra": 10.05, "dec": 0.0, "pmra": 400.0, "pmdec": 0.0, "pm_err_mas": 40}
    out = movers.merge_movers([cw_dup, cw_other, gaia])
    assert [m["id"] for m in out] == ["g", "c2"]  # fastest first; the CatWISE copy of the Gaia star is gone


def test_photometry_reports_a_saturated_core_instead_of_missing_data():
    import numpy as np
    import spectra
    img = np.zeros((31, 31))
    img[13:18, 13:18] = np.inf  # clipped core
    out = spectra._photometry(img, np.ones_like(img), 15.0, 15.0)
    assert out == {"flag": "saturated_core"}


def test_cutout_meta_header_never_contains_nan():
    import json, math
    from main import _finite
    out = json.dumps(_finite({"wavelength_um": math.nan, "x": [1.0, math.inf], "ok": 2.5}), allow_nan=False)
    assert json.loads(out) == {"wavelength_um": None, "x": [1.0, None], "ok": 2.5}


def test_frame_list_falls_back_to_an_older_copy_when_irsa_is_down(monkeypatch, tmp_path):
    """IRSA 502s (15 Nov 2026): an expired frame list is served instead of an error."""
    import cache
    import spherex

    monkeypatch.setattr(cache, "ROOT", tmp_path, raising=False)
    old = {"ra": 1.0, "dec": 2.0, "n_frames": 1, "n_visits": 1, "visits": [], "frames": [{"id": "x"}]}
    monkeypatch.setattr(cache, "get_json", lambda kind, key, ttl_s=None: None if ttl_s else old)

    def down(*a, **k):
        raise RuntimeError("502 Proxy Error")

    monkeypatch.setattr(spherex, "_query", down)
    got = spherex.frames_at(1.0, 2.0)
    assert got["stale"] is True and got["frames"] == [{"id": "x"}]
    monkeypatch.setattr(cache, "get_json", lambda kind, key, ttl_s=None: None)
    import pytest

    with pytest.raises(RuntimeError):
        spherex.frames_at(1.0, 2.0)


def test_gaia_vizier_parser(monkeypatch):
    """The VizieR mirror's TSV becomes the same rows as ESA's (Barnard's Star, checked 15 Nov 2026)."""
    import context

    tsv = (
        "#INFO\n\nSource\tRA_ICRS\tDE_ICRS\tpmRA\tpmDE\tPlx\tGmag\tBP-RP\n"
        " \tdeg\tdeg\tmas/yr\tmas/yr\tmas\tmag\tmag\n"
        "---\t---\t---\t---\t---\t---\t---\t---\n"
        "4472832130942575872\t269.44850252544\t+04.73942005111\t -801.551\t10362.394\t 546.9759\t 8.193974\t 2.833697\n"
        "381260815198909824\t010.68938748635\t+41.22120852351\t \t \t \t21.442245\t \n"
    )

    class R:
        text = tsv

        def raise_for_status(self):
            pass

    monkeypatch.setattr(context.httpx, "get", lambda *a, **k: R())
    rows = context._gaia_vizier("http://x", 269.4, 4.7, 0.1)
    assert rows[0]["source_id"] == "4472832130942575872"
    assert abs(rows[0]["pmdec"] - 10362.394) < 1e-6 and abs(rows[0]["g_mag"] - 8.193974) < 1e-6
    assert rows[1]["pmra"] is None and rows[1]["bp_rp"] is None


def test_env_file_loader(tmp_path, monkeypatch):
    import main
    f = tmp_path / ".env"
    f.write_text('# comment\nMERIDIAN_T1="quoted value"\nexport MERIDIAN_T2=plain\nMERIDIAN_T3=\nMERIDIAN_T4=keep\n')
    monkeypatch.delenv("MERIDIAN_T1", raising=False)
    monkeypatch.delenv("MERIDIAN_T2", raising=False)
    monkeypatch.setenv("MERIDIAN_T4", "already set")
    assert main.load_env_file(f) == ["MERIDIAN_T1", "MERIDIAN_T2"]
    import os
    assert os.environ["MERIDIAN_T1"] == "quoted value" and os.environ["MERIDIAN_T2"] == "plain"
    assert os.environ["MERIDIAN_T4"] == "already set"  # the real environment wins
    assert main.load_env_file(tmp_path / "missing") == []
    monkeypatch.delenv("MERIDIAN_T1")
    monkeypatch.delenv("MERIDIAN_T2")
