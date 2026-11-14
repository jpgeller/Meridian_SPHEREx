"""Per-frame metadata without downloading images: the wavelength SPHEREx saw at a sky
position, read with two small HTTP Range requests per Level 2 file:

  * the start of the file  -> IMAGE header (celestial WCS with SIP + spectral WCS keys 'W')
  * the end of the file    -> the WCS-WAVE table (a coarse X/Y grid of wavelength, bandwidth)

SPHEREx uses a linear variable filter, so the wavelength changes across each detector:
the same star is seen at a different wavelength in every exposure. That is how one
detector covers 17 bands over successive exposures.
"""
from __future__ import annotations

import io
import re
import threading
import warnings

import httpx
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS, FITSFixedWarning

import cache

BLOCK = 2880
HEAD_BYTES = BLOCK * 14  # primary + IMAGE header (~22 kB today)
TAIL_BYTES = BLOCK * 4  # WCS-WAVE header + its small table
END_CARD = b"END" + b" " * 77
_WAVETAB_LOCK = threading.Lock()
_WAVETAB_MEM: dict[str, bytes] = {}


def _get_range(client: httpx.Client, url: str, rng: str) -> bytes:
    r = client.get(url, headers={"Range": f"bytes={rng}"})
    r.raise_for_status()
    if r.status_code != 206:
        raise RuntimeError("server ignored the Range request")
    return r.content


def _split_headers(buf: bytes) -> list[tuple[fits.Header, int]]:
    """Parse consecutive FITS headers in buf; returns (header, offset of its data)."""
    out, pos = [], 0
    while pos < len(buf):
        end = -1
        for i in range(pos, len(buf), 80):
            if buf[i : i + 80] == END_CARD:
                end = i
                break
        if end < 0:
            break
        hdr = fits.Header.fromstring(buf[pos : end + 80].decode("ascii"))
        data_start = ((end + 80 + BLOCK - 1) // BLOCK) * BLOCK
        out.append((hdr, data_start))
        pos = data_start
        break_after_image = hdr.get("EXTNAME") == "IMAGE"
        if break_after_image:
            break
    return out


def _image_header(client: httpx.Client, url: str) -> fits.Header:
    buf = _get_range(client, url, f"0-{HEAD_BYTES - 1}")
    for hdr, _ in _split_headers(buf):
        if hdr.get("EXTNAME") == "IMAGE":
            return hdr
    raise RuntimeError("IMAGE header not found in the first bytes")


def _wave_table(client: httpx.Client, url: str) -> fits.BinTableHDU:
    buf = _get_range(client, url, f"-{TAIL_BYTES}")
    # Find the WCS-WAVE extension header inside the tail (block aligned).
    for start in range(0, len(buf), BLOCK):
        if not buf[start:].startswith(b"XTENSION= 'BINTABLE'"):
            continue
        tail = buf[start:]
        end = tail.find(END_CARD)
        hdr = fits.Header.fromstring(tail[: end + 80].decode("ascii"))
        if hdr.get("EXTNAME") != "WCS-WAVE":
            continue
        data_start = ((end + 80 + BLOCK - 1) // BLOCK) * BLOCK
        nbytes = hdr["NAXIS1"] * hdr["NAXIS2"] + hdr.get("PCOUNT", 0)
        hdu = fits.BinTableHDU.fromstring(tail[: data_start + ((nbytes + BLOCK - 1) // BLOCK) * BLOCK])
        return hdu
    raise RuntimeError("WCS-WAVE table not found at the end of the file")


def _wave_table_cached(client: httpx.Client, url: str, detector: int) -> fits.BinTableHDU:
    """The table is identical for every exposure of a detector within a pipeline version
    (checked 14 Nov 2026), so fetch it once per (detector, version)."""
    m = re.search(r"-v(\d+)-", url)
    key = f"D{detector}|v{m.group(1) if m else 'x'}"
    # Many threads ask for the same table at once on a cold cache: one fetches, the rest wait.
    with _WAVETAB_LOCK:
        raw = _WAVETAB_MEM.get(key)
        if raw is None:
            p = cache.path_for("wavetab", key, ".fits")
            if p.exists():
                raw = p.read_bytes()
            else:
                hdu = _wave_table(client, url)
                buf = io.BytesIO()
                fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(buf)
                raw = buf.getvalue()
                cache.write_atomic(p, raw)
            _WAVETAB_MEM[key] = raw
    # A fresh HDU per call: astropy table objects are not safe to share between threads.
    with fits.open(io.BytesIO(raw), memmap=False) as h:
        return fits.BinTableHDU(data=h[1].data.copy(), header=h[1].header.copy())


def compute(client: httpx.Client, url: str, ra: float, dec: float) -> dict:
    hdr = _image_header(client, url)
    table = _wave_table_cached(client, url, int(hdr.get("DETECTOR", 0)))
    with warnings.catch_warnings():
        # SPHEREx headers use SIP without the -SIP suffix on some versions; that is expected.
        warnings.simplefilter("ignore", (FITSFixedWarning, AstropyWarning))
        cel = WCS(hdr)
        hdul = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(header=hdr), table])
        spec = WCS(hdr, fobj=hdul, key="W")
        x, y = cel.world_to_pixel(SkyCoord(ra, dec, unit="deg"))
        wl, bw = spec.pixel_to_world(x, y)
    nx, ny = hdr.get("NAXIS1", 2040), hdr.get("NAXIS2", 2040)
    x, y = float(x), float(y)
    return {
        "wavelength_um": round(float(wl.to_value("um")), 5),
        "bandwidth_um": round(float(bw.to_value("um")), 5),
        "x": round(x, 2),
        "y": round(y, 2),
        "inside": bool(0 <= x < nx and 0 <= y < ny),
        "edge_px": round(float(min(x, y, nx - 1 - x, ny - 1 - y)), 1),
        "mjd_avg": hdr.get("MJD-AVG"),
    }


def frame_meta(client: httpx.Client, frame: dict, ra: float, dec: float) -> dict:
    """Cached forever: a file's WCS and filter never change for a given processing version."""
    key = f"{frame['access_url']}|{ra:.5f},{dec:.5f}"
    hit = cache.get_json("framemeta", key)
    if hit is not None:
        return hit
    meta = compute(client, frame["access_url"], ra, dec)
    cache.put_json("framemeta", key, meta)
    return meta


def nearest_band(wavelength_um: float, cube_wavelengths: list[float]) -> int:
    """Cube band index (0..101) whose centre wavelength is closest."""
    return int(np.argmin(np.abs(np.asarray(cube_wavelengths) - wavelength_um)))
