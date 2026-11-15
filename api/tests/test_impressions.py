"""Offline tests for the impressions bake-off helpers (tools/impressions_bakeoff.py)."""
import base64
import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import impressions_bakeoff as ib  # noqa: E402


def _close():
    rng = np.random.default_rng(1)
    return Image.fromarray(rng.integers(0, 255, (512, 512, 3), dtype=np.uint8))


def test_centre_box_is_the_central_quarter():
    assert ib.centre_box(1024, 4) == (384, 384, 640, 640)


def test_canvas_holds_the_close_picture_in_the_centre_and_grey_around():
    c = ib.make_canvas(_close())
    a = np.asarray(c)
    assert c.size == (1024, 1024)
    assert tuple(a[0, 0]) == ib.GREY and tuple(a[1023, 1023]) == ib.GREY
    assert ib.centre_change(c, _close()) == 0.0  # the centre is exactly the shrunk close-up


def test_mask_is_transparent_where_to_paint():
    m = np.asarray(ib.make_mask())
    assert m[0, 0, 3] == 0 and m[512, 512, 3] == 255
    assert (m[..., 3] == 255).sum() == 256 * 256


def test_paste_centre_restores_the_centre_on_a_repainted_result():
    repainted = Image.new("RGB", (1024, 1024), (10, 200, 30))
    assert ib.centre_change(repainted, _close()) > 50
    fixed = ib.paste_centre(repainted, _close(), feather=1)
    assert ib.centre_change(fixed, _close()) < 1.0


def test_find_images_digs_out_nested_base64_images_only():
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (1, 2, 3)).save(buf, "PNG")
    png = base64.b64encode(buf.getvalue() + b"\0" * 300).decode()
    text = base64.b64encode(b"x" * 400).decode()
    resp = {"steps": [{"content": [{"type": "text", "text": text}, {"type": "image", "data": png}]}], "usage": {}}
    found = ib.find_images(resp)
    assert len(found) == 1 and found[0].startswith(b"\x89PNG")


def test_prompts_compose_style_and_keep_the_centre_rule():
    p = ib.load_prompts("eps_ind_b")
    assert set(p) == {"L2", "L3"}
    assert "brown dwarf" in p["L3"] and "No text" in p["L3"] and "Keep the central square" not in p["L3"]
    assert p["L2"].startswith("This picture is the centre") and "No text" in p["L2"]
    for text in p.values():  # plan rule 5: no artist or agency named
        assert not any(w in text for w in ("NASA", "ESA", "ESO", "NOIRLab", "in the style of artist"))


def test_load_env_reads_simple_lines(tmp_path):
    f = tmp_path / ".env"
    f.write_text("# comment\nA=1\nB = 'two'\n\nC=\"x=y\"\n")
    assert ib.load_env(f) == {"A": "1", "B": "two", "C": "x=y"}
    assert ib.load_env(tmp_path / "missing") == {}


def test_zoom_frames_start_wide_and_end_on_the_close_picture():
    wide = ib.paste_centre(Image.new("RGB", (1024, 1024), (0, 0, 0)), _close(), feather=1)
    frames = ib.zoom_frames(wide, _close(), n=6, size=128)
    assert len(frames) == 6 and frames[0].size == (128, 128)
    last = np.asarray(frames[-1], float)
    want = np.asarray(_close().resize((128, 128), Image.BICUBIC), float)
    assert np.abs(last - want).mean() < 8
