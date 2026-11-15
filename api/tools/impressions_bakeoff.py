"""Image-model bake-off for the deep-zoom artist's impressions (docs/AI_IMAGES_PLAN.md, step A1).

The same two tasks on each provider, on Epsilon Indi B:
  T1  L3 close-up from text (the brown dwarf Ba), N candidates.
  T2  L2 by outpainting: the provider's first L3 shrunk into the central 1/4 of a blank canvas, surroundings painted
      (the pair Ba + Bb). Measures how much the provider changed the centre, which must stay put for a seamless zoom.
Writes everything to api/cache/impressions_bakeoff/<stamp>/ with report.json, index.html (contact sheet) and a zoom
preview (L2 -> L3 cross-fade, as the app would play it) per provider.

  cd api
  ./.venv/bin/python tools/impressions_bakeoff.py --dry-run          # no network, no keys: shows the requests
  ./.venv/bin/python tools/impressions_bakeoff.py --check            # keys + model ids valid? costs nothing
  ./.venv/bin/python tools/impressions_bakeoff.py --n 2              # the bake-off (~4 images per provider)
  ./.venv/bin/python tools/impressions_bakeoff.py --providers bfl    # one provider only

Keys in api/.env (git-ignored): GEMINI_API_KEY, OPENAI_API_KEY, BFL_API_KEY. Model ids can be changed with
GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL, BFL_MODEL (defaults: what each provider's docs listed on 15 Nov 2026).
One request at a time (polite); nothing is sent to the browser.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np
import yaml
from PIL import Image

API_DIR = Path(__file__).resolve().parent.parent
PROMPTS = API_DIR / "impressions" / "prompts.yaml"
OUT_ROOT = API_DIR / "cache" / "impressions_bakeoff"

SIZE = 1024  # bake-off resolution (the real run uses 2048)
ZOOM = 4  # each level is the centre 1/ZOOM of the next wider one
GREY = (128, 128, 128)  # "paint here" fill for providers without a mask
TIMEOUT = httpx.Timeout(300.0, connect=20.0)

DEFAULT_MODELS = {
    "gemini": "gemini-nano-banana-2.1",
    "openai": "gpt-image-2",
    "bfl": "flux-3-image",  # T1 endpoint; T2 always uses /v1/flux-tools/outpainting-v1
}
ENV_MODEL = {"gemini": "GEMINI_IMAGE_MODEL", "openai": "OPENAI_IMAGE_MODEL", "bfl": "BFL_MODEL"}
ENV_KEY = {"gemini": "GEMINI_API_KEY", "openai": "OPENAI_API_KEY", "bfl": "BFL_API_KEY"}


# ---------------------------------------------------------------------------------------------------------------
# Pure helpers (tested in tests/test_impressions.py)


def load_env(path: Path) -> dict[str, str]:
    """KEY=value lines of a .env file (no shell expansion); missing file -> {}."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def load_prompts(target: str = "eps_ind_b", path: Path = PROMPTS) -> dict[str, str]:
    """Full prompts per level: style + level text; outpaint levels also get the keep-the-centre rule."""
    cfg = yaml.safe_load(path.read_text())
    levels = cfg["targets"][target]["levels"]
    style, rule = cfg["style"].strip(), cfg["outpaint_rule"].strip()
    deepest = max(levels, key=lambda k: int(k[1:]))
    return {lv: (f"{style} {text.strip()}" if lv == deepest else f"{rule} {text.strip()} {style}")
            for lv, text in levels.items()}


def centre_box(size: int = SIZE, zoom: int = ZOOM) -> tuple[int, int, int, int]:
    """(left, top, right, bottom) of the central 1/zoom square of a size x size canvas."""
    inner = size // zoom
    a = (size - inner) // 2
    return a, a, a + inner, a + inner


def make_canvas(close: Image.Image, size: int = SIZE, zoom: int = ZOOM, fill=GREY) -> Image.Image:
    """The closer picture shrunk into the centre of a `fill` canvas (what an outpaint model extends)."""
    box = centre_box(size, zoom)
    canvas = Image.new("RGB", (size, size), fill)
    canvas.paste(close.convert("RGB").resize((box[2] - box[0],) * 2, Image.LANCZOS), box[:2])
    return canvas


def make_mask(size: int = SIZE, zoom: int = ZOOM) -> Image.Image:
    """OpenAI-style edit mask: transparent (alpha 0) = paint here, opaque centre = keep."""
    mask = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    box = centre_box(size, zoom)
    mask.paste((0, 0, 0, 255), box)
    return mask


def centre_change(result: Image.Image, close: Image.Image, size: int = SIZE, zoom: int = ZOOM) -> float:
    """Mean absolute difference (0-255) between the result's centre and the closer picture shrunk into it.
    0 = untouched; ~3 = invisible; >10 = the zoom will visibly jump."""
    box = centre_box(size, zoom)
    got = np.asarray(result.convert("RGB").resize((size, size), Image.LANCZOS).crop(box), float)
    want = np.asarray(close.convert("RGB").resize((box[2] - box[0],) * 2, Image.LANCZOS), float)
    return round(float(np.abs(got - want).mean()), 2)


def paste_centre(result: Image.Image, close: Image.Image, size: int = SIZE, zoom: int = ZOOM,
                 feather: int = 12) -> Image.Image:
    """The result with the exact closer picture put back in its centre, blended over `feather` px at the edge
    (what the real pipeline keeps, so the zoom never jumps)."""
    out = result.convert("RGB").resize((size, size), Image.LANCZOS)
    box = centre_box(size, zoom)
    inner = box[2] - box[0]
    small = close.convert("RGB").resize((inner, inner), Image.LANCZOS)
    ramp = (np.minimum(np.arange(inner), np.arange(inner)[::-1]) + 1) / max(feather, 1)
    alpha = np.clip(np.minimum.outer(ramp, ramp), 0, 1)
    base = np.asarray(out.crop(box), float)
    mixed = base * (1 - alpha[..., None]) + np.asarray(small, float) * alpha[..., None]
    out.paste(Image.fromarray(mixed.round().astype(np.uint8)), box[:2])
    return out


_MAGIC = (b"\x89PNG", b"\xff\xd8\xff", b"RIFF", b"GIF8")


def find_images(obj) -> list[bytes]:
    """Every base64 image anywhere in a JSON response (each provider nests it differently)."""
    found: list[bytes] = []

    def walk(o):
        if isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
        elif isinstance(o, str) and len(o) > 200:
            try:
                raw = base64.b64decode(o, validate=True)
            except Exception:
                return
            if raw.startswith(_MAGIC):
                found.append(raw)

    walk(obj)
    return found


def to_b64_png(im: Image.Image) -> str:
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def zoom_frames(wide: Image.Image, close: Image.Image, n: int = 36, size: int = 512, zoom: int = ZOOM) -> list[Image.Image]:
    """The app's planned dive from `wide` into `close`: continuous zoom into the centre, cross-fading to the closer
    picture in the last third (so detail arrives as the old picture runs out of pixels)."""
    W = wide.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
    C = close.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
    frames = []
    for i in range(n):
        t = i / (n - 1)
        span = SIZE / zoom ** t  # visible width in wide-picture pixels
        a = (SIZE - span) / 2
        fw = W.crop((a, a, a + span, a + span)).resize((size, size), Image.BICUBIC)
        # the close picture covers the central SIZE/zoom of the wide one
        cspan = span * zoom  # same view in close-picture pixels
        b = (SIZE - cspan) / 2
        if cspan <= SIZE:
            fc = C.crop((b, b, b + cspan, b + cspan)).resize((size, size), Image.BICUBIC)
            w = min(1.0, max(0.0, (t - 0.66) / 0.34))
            fw = Image.blend(fw, fc, w)
        frames.append(fw)
    return frames


# ---------------------------------------------------------------------------------------------------------------
# Providers


@dataclass
class Call:
    task: str
    seconds: float
    usage: dict = field(default_factory=dict)
    note: str = ""


class Provider:
    name = ""

    def __init__(self, key: str, model: str, dry: bool = False):
        self.key, self.model, self.dry = key, model, dry
        self.client = httpx.Client(timeout=TIMEOUT)
        self.calls: list[Call] = []

    def _show(self, method: str, url: str, body) -> None:
        def short(o):
            if isinstance(o, dict):
                return {k: short(v) for k, v in o.items()}
            if isinstance(o, list):
                return [short(v) for v in o]
            if isinstance(o, str) and len(o) > 120:
                return o[:60] + f"...<{len(o)} chars>"
            if isinstance(o, (bytes, bytearray)):
                return f"<{len(o)} bytes>"
            if isinstance(o, tuple):
                return f"<file {o[0]}>"
            return o
        print(f"  {method} {url}\n  {json.dumps(short(body), indent=2)}")

    def check(self) -> str: ...
    def generate(self, prompt: str, n: int) -> list[Image.Image]: ...
    def outpaint(self, close: Image.Image, prompt: str) -> list[Image.Image]: ...


class Gemini(Provider):
    name = "gemini"
    BASE = "https://generativelanguage.googleapis.com/v1beta"

    def _headers(self):
        return {"x-goog-api-key": self.key, "Content-Type": "application/json"}

    def check(self) -> str:
        r = self.client.get(f"{self.BASE}/models/{self.model}", headers=self._headers())
        return f"HTTP {r.status_code}" + ("" if r.is_success else f": {r.text[:300]}")

    def _ask(self, task: str, prompt: str, image: Image.Image | None = None) -> list[Image.Image]:
        # Interactions API (Gemini docs, Nov 2026); falls back to generateContent if this account/model rejects it.
        parts = [{"type": "text", "text": prompt}]
        if image is not None:
            parts.append({"type": "image", "mime_type": "image/png", "data": to_b64_png(image)})
        body = {"model": self.model, "input": parts,
                "response_format": {"type": "image", "mime_type": "image/png", "aspect_ratio": "1:1", "image_size": "1K"}}
        url = f"{self.BASE}/interactions"
        if self.dry:
            self._show("POST", url, body)
            return []
        t0 = time.time()
        r = self.client.post(url, headers={**self._headers(), "Api-Revision": "2026-05-20"}, json=body)
        note = "interactions"
        if r.status_code in (400, 404):
            gparts = [{"text": prompt}]
            if image is not None:
                gparts.append({"inline_data": {"mime_type": "image/png", "data": to_b64_png(image)}})
            gbody = {"contents": [{"parts": gparts}],
                     "generationConfig": {"responseModalities": ["IMAGE"],
                                          "imageConfig": {"aspectRatio": "1:1", "imageSize": "1K"}}}
            r = self.client.post(f"{self.BASE}/models/{self.model}:generateContent", headers=self._headers(), json=gbody)
            note = "generateContent (interactions refused)"
        r.raise_for_status()
        data = r.json()
        imgs = find_images(data)
        self.calls.append(Call(task, round(time.time() - t0, 1), data.get("usage") or data.get("usageMetadata") or {}, note))
        if not imgs:
            raise RuntimeError(f"no image in Gemini response: {json.dumps(data)[:400]}")
        return [Image.open(io.BytesIO(imgs[-1]))]

    def generate(self, prompt, n):
        out = []
        for _ in range(n):  # one picture per request
            out += self._ask("T1", prompt)
        return out

    def outpaint(self, close, prompt):
        canvas = make_canvas(close)
        hint = " The grey area around the centre is empty: replace all of it."
        return self._ask("T2", prompt + hint, canvas)


class OpenAI(Provider):
    name = "openai"
    BASE = "https://api.openai.com/v1"

    def _headers(self):
        return {"Authorization": f"Bearer {self.key}"}

    def check(self) -> str:
        r = self.client.get(f"{self.BASE}/models/{self.model}", headers=self._headers())
        msg = f"HTTP {r.status_code}" + ("" if r.is_success else f": {r.text[:300]}")
        lst = self.client.get(f"{self.BASE}/models", headers=self._headers())
        if lst.is_success:
            ids = sorted(m["id"] for m in lst.json().get("data", []) if "image" in m["id"])
            msg += f"; image models on this account: {', '.join(ids)}"
        return msg

    def generate(self, prompt, n):
        body = {"model": self.model, "prompt": prompt, "size": f"{SIZE}x{SIZE}", "quality": "high", "n": n,
                "output_format": "png"}
        url = f"{self.BASE}/images/generations"
        if self.dry:
            self._show("POST", url, body)
            return []
        t0 = time.time()
        r = self.client.post(url, headers=self._headers(), json=body)
        r.raise_for_status()
        data = r.json()
        self.calls.append(Call("T1", round(time.time() - t0, 1), data.get("usage", {})))
        return [Image.open(io.BytesIO(base64.b64decode(d["b64_json"]))) for d in data["data"]]

    def outpaint(self, close, prompt):
        canvas, mask = make_canvas(close), make_mask()
        fields = {"model": self.model, "prompt": prompt, "size": f"{SIZE}x{SIZE}", "quality": "high", "n": "1",
                  "output_format": "png"}
        url = f"{self.BASE}/images/edits"
        files = {"image[]": ("canvas.png", png_bytes(canvas), "image/png"),
                 "mask": ("mask.png", png_bytes(mask), "image/png")}
        if self.dry:
            self._show("POST (multipart)", url, {**fields, **files})
            return []
        t0 = time.time()
        r = self.client.post(url, headers=self._headers(), data=fields, files=files)
        if r.status_code == 400 and "image" in r.text:  # older multipart name
            files["image"] = files.pop("image[]")
            r = self.client.post(url, headers=self._headers(), data=fields, files=files)
        r.raise_for_status()
        data = r.json()
        self.calls.append(Call("T2", round(time.time() - t0, 1), data.get("usage", {})))
        return [Image.open(io.BytesIO(base64.b64decode(d["b64_json"]))) for d in data["data"]]


class BFL(Provider):
    name = "bfl"
    BASE = "https://api.bfl.ai/v1"

    def _headers(self):
        return {"x-key": self.key, "Content-Type": "application/json"}

    def check(self) -> str:
        r = self.client.get(f"{self.BASE}/credits", headers=self._headers())
        return f"HTTP {r.status_code}: {r.text[:200]}"

    def _run(self, task: str, path: str, body: dict) -> Image.Image | None:
        url = f"{self.BASE}/{path}"
        if self.dry:
            self._show("POST", url, body)
            return None
        t0 = time.time()
        r = self.client.post(url, headers=self._headers(), json=body)
        r.raise_for_status()
        job = r.json()
        while True:  # poll (results are kept ~10 min; we download at once)
            time.sleep(1.5)
            p = self.client.get(job["polling_url"], headers=self._headers())
            p.raise_for_status()
            res = p.json()
            status = res.get("status")
            if status == "Ready":
                img = self.client.get(res["result"]["sample"])
                img.raise_for_status()
                break
            if status not in ("Pending", "Processing", "Queued", "Task not found"):
                raise RuntimeError(f"BFL {path}: {status}: {json.dumps(res)[:300]}")
            if time.time() - t0 > 300:
                raise TimeoutError(f"BFL {path}: no result after 300 s")
        self.calls.append(Call(task, round(time.time() - t0, 1),
                               {k: job.get(k) for k in ("cost", "input_mp", "output_mp")}, "cost in credits (1 = $0.01)"))
        return Image.open(io.BytesIO(img.content))

    def generate(self, prompt, n):
        # grounding off: FLUX 3 would otherwise search the web for reference pictures (plan rule 5: no existing artwork)
        body = {"prompt": prompt, "width": SIZE, "height": SIZE, "grounding": False}
        out = [self._run("T1", self.model, body) for _ in range(n)]
        return [im for im in out if im is not None]

    def outpaint(self, close, prompt):
        box = centre_box()
        small = close.convert("RGB").resize((box[2] - box[0],) * 2, Image.LANCZOS)
        body = {"input_image": to_b64_png(small), "width": SIZE, "height": SIZE, "prompt": prompt, "mode": "high",
                "output_format": "png"}  # offsets null = centred
        im = self._run("T2", "flux-tools/outpainting-v1", body)
        return [im] if im is not None else []


PROVIDERS = {"gemini": Gemini, "openai": OpenAI, "bfl": BFL}


# ---------------------------------------------------------------------------------------------------------------


def write_report(out: Path, rows: list[dict]) -> None:
    (out / "report.json").write_text(json.dumps(rows, indent=2))
    html = ["<!doctype html><meta charset=utf-8><title>Impressions bake-off</title>",
            "<style>body{background:#0b0d14;color:#dde;font:14px system-ui;margin:24px}img{width:256px;height:256px;"
            "margin:4px;border:1px solid #333}h2{margin-top:32px}td{vertical-align:top;padding:4px 10px}</style>",
            "<h1>Artist's impressions bake-off: Epsilon Indi B</h1>",
            "<p>T1 = L3 close-up from text. T2 = L2 outpainted around that L3 (raw, then with the exact centre put back). "
            "Centre change: mean |difference| 0-255 in the kept square; under ~3 is invisible.</p>"]
    for row in rows:
        html.append(f"<h2>{row['provider']} · {row['model']}</h2>")
        if row.get("error"):
            html.append(f"<p style='color:#f88'>Error: {row['error']}</p>")
        for k in ("T1", "T2_raw", "T2_fixed", "zoom"):
            if row.get(k):
                html.append(f"<div><b>{k}</b><br>" + "".join(f"<img src='{p}'>" for p in row[k]) + "</div>")
        html.append("<table>" + "".join(f"<tr><td>{c['task']}</td><td>{c['seconds']} s</td><td>{json.dumps(c['usage'])}</td>"
                                        f"<td>{c['note']}</td></tr>" for c in row.get("calls", [])) + "</table>")
        if "centre_change" in row:
            html.append(f"<p>Centre change: <b>{row['centre_change']}</b></p>")
    (out / "index.html").write_text("\n".join(html))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--providers", default="gemini,openai,bfl")
    ap.add_argument("--n", type=int, default=2, help="L3 candidates per provider")
    ap.add_argument("--check", action="store_true", help="validate keys and model ids only (no cost)")
    ap.add_argument("--dry-run", action="store_true", help="print the requests; no network, no keys needed")
    args = ap.parse_args(argv)

    env = {**load_env(API_DIR / ".env"), **os.environ}
    prompts = load_prompts("eps_ind_b")
    names = [p.strip() for p in args.providers.split(",") if p.strip()]
    missing = [ENV_KEY[n] for n in names if not env.get(ENV_KEY[n]) and not args.dry_run]
    if missing:
        print(f"Missing in api/.env: {', '.join(missing)}. Add them, or run with --providers for the others.")
        return 2

    out = OUT_ROOT / datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    rows = []
    for name in names:
        model = env.get(ENV_MODEL[name]) or DEFAULT_MODELS[name]
        prov = PROVIDERS[name](env.get(ENV_KEY[name], "<key>"), model, dry=args.dry_run)
        print(f"\n== {name} ({model})")
        if args.check:
            try:
                print("  " + prov.check())
            except httpx.HTTPError as e:
                print(f"  network error: {e}")
            continue
        row: dict = {"provider": name, "model": model}
        rows.append(row)
        d = out / name
        try:
            l3 = prov.generate(prompts["L3"], args.n)
            if args.dry_run:
                # exercise T2 with a stand-in close-up so the request shape is shown too
                prov.outpaint(Image.new("RGB", (SIZE, SIZE), (90, 20, 60)), prompts["L2"])
                continue
            d.mkdir(parents=True, exist_ok=True)
            row["T1"] = []
            for i, im in enumerate(l3):
                im.save(d / f"L3_{i}.png")
                row["T1"].append(f"{name}/L3_{i}.png")
            l2 = prov.outpaint(l3[0], prompts["L2"])
            if l2:
                l2[0].save(d / "L2_raw.png")
                fixed = paste_centre(l2[0], l3[0])
                fixed.save(d / "L2_fixed.png")
                row["T2_raw"], row["T2_fixed"] = [f"{name}/L2_raw.png"], [f"{name}/L2_fixed.png"]
                row["centre_change"] = centre_change(l2[0], l3[0])
                frames = zoom_frames(fixed, l3[0])
                frames[0].save(d / "zoom.gif", save_all=True, append_images=frames[1:] + frames[::-1], duration=70, loop=0)
                row["zoom"] = [f"{name}/zoom.gif"]
        except (httpx.HTTPError, RuntimeError, TimeoutError, KeyError) as e:
            detail = getattr(getattr(e, "response", None), "text", "")[:400]
            row["error"] = f"{type(e).__name__}: {e} {detail}".strip()
            print("  " + row["error"])
        finally:
            row["calls"] = [c.__dict__ for c in prov.calls]
    if not args.check and not args.dry_run:
        out.mkdir(parents=True, exist_ok=True)
        write_report(out, rows)
        print(f"\nReport: {out / 'index.html'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
