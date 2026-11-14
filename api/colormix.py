"""False-colour mixes of the SPHEREx all-sky map.

Infrared has no colours of its own. A mix paints three of the 102 bands red, green and blue
(longest wavelength in red), like Hubble/JWST colour images. Each tile of a virtual HiPS
"/api/hips/mix/R-G-B" is made from IRSA's three band tiles and cached, so Aladin shows the
result as an ordinary colour map.

Why not three blended layers in the browser: Aladin 3.8.2 keys layer settings by survey
address and its additive blending did not combine layers in our tests (15 Nov 2026).
"""
from __future__ import annotations

import asyncio
import io
import re

import httpx
import numpy as np
from PIL import Image

import cache

SPHEREX_HIPS = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
BLANK = {0, 50, 51}
TILE_PATH = re.compile(r"^Norder(\d)/(Dir\d+/Npix\d+|Allsky)\.png$")
VERSION = "v1"

_props_text: str | None = None
_client: httpx.AsyncClient | None = None


def parse_mix(mix: str) -> tuple[int, int, int]:
    """'62-46-22' -> (62, 46, 22). Blank cube frames are rejected (IRSA has no tiles)."""
    parts = mix.split("-")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise ValueError("mix must look like 62-46-22 (red-green-blue bands)")
    bands = tuple(int(p) for p in parts)
    if any(b < 0 or b > 101 or b in BLANK for b in bands):
        raise ValueError("bands must be 1-101, excluding blank frames 50 and 51")
    return bands  # type: ignore[return-value]


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=30.0, follow_redirects=True,
                                    limits=httpx.Limits(max_connections=24))
    return _client


async def properties(bands: tuple[int, int, int]) -> str:
    global _props_text
    if _props_text is None:
        r = await client().get(f"{SPHEREX_HIPS}/properties")
        r.raise_for_status()
        _props_text = r.text
    r_, g, b = bands
    out = []
    for line in _props_text.splitlines():
        key = line.split("=", 1)[0].strip()
        if key.startswith(("hips_cube", "data_cube", "custom_tile", "hips_service_url", "hips_pixel_cut",
                           "hips_pixel_function", "hips_data_range", "em_min", "em_max")):
            continue  # a mix is a plain colour image, not a cube
        if key == "creator_did":
            line = f"creator_did          = ivo://meridian/spherex_mix_{r_}_{g}_{b}"
        elif key == "obs_title":
            line = f"obs_title            = SPHEREx DR1 colour mix (R={r_}, G={g}, B={b})"
        elif key == "dataproduct_type":
            line = "dataproduct_type     = image"
        elif key == "hips_tile_format":
            line = "hips_tile_format     = png"
        out.append(line)
    return "\n".join(out) + "\n"


async def _band_tile(path: str, band: int) -> np.ndarray | None:
    """One IRSA band tile as a 2D uint8 array (cached), or None if IRSA has none."""
    key = f"{path}|{band}"
    p = cache.path_for("hipsband", key, ".png")
    if p.exists():
        data = p.read_bytes()
    else:
        url = f"{SPHEREX_HIPS}/{path[:-4]}_{band}.png"
        for attempt in range(3):
            try:
                r = await client().get(url)
                break
            except httpx.HTTPError:
                if attempt == 2:
                    raise
                await asyncio.sleep(1 + attempt)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        data = r.content
        cache.write_atomic(p, data)
    return np.asarray(Image.open(io.BytesIO(data)).convert("L"))


async def tile(bands: tuple[int, int, int], path: str) -> bytes | None:
    if not TILE_PATH.match(path):
        raise ValueError("bad tile path")
    key = f"{'-'.join(map(str, bands))}|{path}|{VERSION}"
    out = cache.path_for("hipsmix", key, ".png")
    if out.exists():
        return out.read_bytes()
    chans = await asyncio.gather(*(_band_tile(path, b) for b in bands))
    if all(c is None for c in chans):
        return None
    shape = next(c.shape for c in chans if c is not None)
    rgb = np.zeros((*shape, 3), dtype=np.uint8)
    for i, c in enumerate(chans):
        if c is not None:
            rgb[..., i] = c
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, format="PNG", optimize=False)
    cache.write_atomic(out, buf.getvalue())
    return buf.getvalue()
