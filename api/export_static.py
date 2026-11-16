"""Write the five challenge targets as static files, so the website shows them with no API at all.

    python -m export_static            # from meridian/api, after `python -m ingest --targets showcase`

Every answer the web app asks for at these five places (/api/resolve, /api/frames/meta, every cached
cutout, WISE, Gaia, moving objects, the Gaia SED and the spectrum at the target) is requested from the
real API in-process and saved under web/public/data/api/, with an index.json mapping each request to its
file. web/src/core/staticApi.js answers those requests from the files before the network is tried.
Keys must match the browser's exactly: apiKey() here and in staticApi.js are the same rule.

Only cutouts already in the cache are written (ingest's set: every mode the player loads at the
default 0.1° field). Re-run after ingest to pick up new SPHEREx visits; the output is rewritten.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlsplit

from fastapi.testclient import TestClient

import cutouts
import ingest
import resolve
import spherex
from main import app

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "data" / "api"
FOV = ingest.FOV  # the 2D view's default field (state.js ffov)
SPECTRUM_ROUND_NEW = 40  # web/src/field/spectrum.js ROUND_NEW
KEEP_HEADERS = ("x-width", "x-height", "x-meta")
EXT = {"application/json": ".json", "image/png": ".png", "application/octet-stream": ".f32"}


def api_key(url: str) -> str:
    """'/api/cutout?ra=1&id=x' -> 'cutout?id=x&ra=1': path after /api/, parameters decoded and sorted."""
    parts = urlsplit(url)
    path = parts.path.split("/api/", 1)[1]
    params = sorted(parse_qsl(parts.query, keep_blank_values=True))
    return path + ("?" + "&".join(f"{k}={v}" for k, v in params) if params else "")


def fmt(v: float, n: int) -> str:
    """JavaScript's v.toFixed(n) for the coordinates the app sends."""
    return f"{v:.{n}f}"


class Exporter:
    def __init__(self):
        self.client = TestClient(app)
        self.index: dict[str, list] = {}
        self.bytes = 0
        self.failed: list[str] = []

    def get(self, url: str):
        key = api_key(url)
        if key in self.index:
            return None
        r = self.client.get(url)
        if r.status_code != 200:
            self.failed.append(f"{r.status_code} {url}")
            return None
        ctype = r.headers.get("content-type", "").split(";")[0]
        name = hashlib.sha1(key.encode()).hexdigest()[:20] + EXT.get(ctype, ".bin")
        headers = {h.title(): r.headers[h] for h in KEEP_HEADERS if h in r.headers}
        if headers:
            # a cutout's X-Width/X-Height/X-Meta travel inside its file, keeping index.json small:
            # 4-byte little-endian length, the headers as JSON, then the body (staticApi.js unpacks it)
            head = json.dumps(headers, separators=(",", ":")).encode()
            body = len(head).to_bytes(4, "little") + head + r.content
        else:
            body = r.content
        (OUT / name).write_bytes(body)
        self.index[key] = [name, ctype] + ([1] if headers else [])
        self.bytes += len(body)
        return r

    def target(self, label: str, name: str) -> None:
        r = self.get(f"/api/resolve?name={quote(name, safe='')}")
        pos = r.json() if r is not None else resolve.resolve(name)
        ra, dec = ingest.round5(pos["ra"]), ingest.round5(pos["dec"])
        q = f"ra={fmt(ra, 5)}&dec={fmt(dec, 5)}"
        qf = f"{q}&fov={FOV}"
        n0 = len(self.index)
        meta = self.get(f"/api/frames/meta?{q}")
        frames = meta.json()["frames"] if meta is not None else []
        n_cut = 0
        for f in frames:
            if f.get("inside") and not f.get("error") and cutouts.is_processed(f, ra, dec, FOV):
                self.get(f"/api/cutout?id={quote(f['id'], safe='')}&{q}&fov={FOV}&ext=image&v=5")
                n_cut += 1
        wise = self.get(f"/api/context/wise?{qf}&band=2")
        for wf in (wise.json()["frames"] if wise is not None else []):
            self.get(wf["url"])
        self.get(f"/api/context/gaia?{qf}")
        self.get(f"/api/context/movers?{qf}")
        p = f"ra={fmt(ra, 6)}&dec={fmt(dec, 6)}"
        self.get(f"/api/context/gaia_sed?{p}&mjd=61041")
        # spectrum.js asks with max_new=0 first, then max_new=40 until complete: save the complete answer
        spec = f"/api/spectrum?{p}&ra0={fmt(ra, 5)}&dec0={fmt(dec, 5)}&fov={FOV}"
        self.get(f"{spec}&max_new=0")
        for _ in range(20):
            r = self.client.get(f"{spec}&max_new={SPECTRUM_ROUND_NEW}")
            if r.status_code != 200 or r.json().get("complete"):
                break
        self.index.pop(api_key(f"{spec}&max_new={SPECTRUM_ROUND_NEW}"), None)
        self.get(f"{spec}&max_new={SPECTRUM_ROUND_NEW}")
        print(f"  {label:<10} {ra:.5f} {dec:+.5f}  {n_cut} cutouts, {len(self.index) - n0} files", flush=True)


def main() -> int:
    cutouts.ALLOW_FULL_FALLBACK = False
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    ex = Exporter()
    for label, name in ingest.SHOWCASE.items():
        ex.target(label, name)
    index = {"version": 1, "fov": FOV, "targets": list(ingest.SHOWCASE), "entries": dict(sorted(ex.index.items()))}
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(f"wrote {len(ex.index)} files, {ex.bytes / 1e6:.1f} MB, to {OUT}")
    for line in ex.failed:
        print(f"  ! {line}")
    return 1 if ex.failed else 0


if __name__ == "__main__":
    sys.exit(main())
