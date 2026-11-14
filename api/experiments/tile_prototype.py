"""OPTIONAL (final version), not used by the app. See docs/BUILD_PLAN.md "Optional: sharp tile level".

Prototype: build ONE order-6 HiPS tile (512x512 at ~6.4"/px) for one SPHEREx band, with
per-pixel wavelength selection, and time every stage. Usage: python tile_proto.py RA DEC BAND"""
import io
import json
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor

from pathlib import Path
API = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, API)

import httpx
import numpy as np
import astropy.units as u
from astropy import log
from astropy.coordinates import SkyCoord, ICRS
from astropy.io import fits
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS, FITSFixedWarning
from astropy_healpix import HEALPix
from scipy.ndimage import map_coordinates

import framemeta
import spherex

log.setLevel("ERROR")
warnings.simplefilter("ignore", (FITSFixedWarning, AstropyWarning))
ra0, dec0, band = float(sys.argv[1]), float(sys.argv[2]), int(sys.argv[3])
OUT = sys.argv[4] if len(sys.argv) > 4 else "."
T = {}
t_all = time.time()

# --- the tile and its 262144 pixel centres --------------------------------------------
order, sub = 6, 9  # HiPS: tile order 6, 2^9 = 512 px per side -> pixel order 15
hp6 = HEALPix(nside=2**order, order="nested", frame=ICRS())
hp15 = HEALPix(nside=2**(order + sub), order="nested", frame=ICRS())
ipix = int(hp6.skycoord_to_healpix(SkyCoord(ra0, dec0, unit="deg")))
children = ipix * 4**sub + np.arange(4**sub, dtype=np.int64)
lon, lat = hp15.healpix_to_lonlat(children)
lon, lat = lon.to_value(u.deg), lat.to_value(u.deg)
print(f"tile order 6 #{ipix}: {len(children)} px, pixel {hp15.pixel_resolution.to_value(u.arcsec):.2f}\"")

# --- 1. every SPHEREx image overlapping the tile --------------------------------------
t = time.time()
from astroquery.ipac.irsa import Irsa
for attempt in range(6):
    try:
        tab = Irsa.query_sia(pos=(SkyCoord(ra0, dec0, unit="deg"), 0.7 * u.deg), collection=spherex.COLLECTIONS)
        break
    except Exception as err:
        print("   IRSA search retry", attempt + 1, type(err).__name__)
        time.sleep(10)
best = {}
for row in tab:
    det = int(str(row["energy_bandpassname"]).rsplit("D", 1)[-1])
    fid = f"{row['obs_id']}_D{det}"
    rank = spherex.COLLECTION_RANK[str(row["obs_collection"])]
    if fid not in best or rank < best[fid][0]:
        best[fid] = (rank, {"id": fid, "access_url": str(row["access_url"]), "detector": det, "mjd": float(row["t_min"])})
frames = [v[1] for v in best.values()]
T["1 search"] = time.time() - t
print(f"1) images overlapping the tile: {len(frames)}  ({T['1 search']:.1f}s)")

# --- 2. which tile pixels each image saw at this band's wavelength (headers only) -------
cube = spherex.cube_wavelengths()
lam = cube[band]
half = 0.5 * min(abs(cube[band + 1] - lam) if band < 101 else 1, abs(lam - cube[band - 1]) if band > 0 else 1)
sky = SkyCoord(lon, lat, unit="deg")
t = time.time()


def coverage(f):
    with httpx.Client(timeout=30, follow_redirects=True) as c:
        hdr = framemeta._image_header(c, f["access_url"])
        tab = framemeta._wave_table_cached(c, f["access_url"], int(hdr.get("DETECTOR", 0)))
    cel = WCS(hdr)
    hdul = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(header=hdr), tab])
    spec = WCS(hdr, fobj=hdul, key="W")
    x, y = cel.world_to_pixel(sky)
    inside = (x > 2) & (y > 2) & (x < hdr["NAXIS1"] - 3) & (y < hdr["NAXIS2"] - 3)
    if not inside.any():
        return f, None
    wl, _ = spec.pixel_to_world(x[inside], y[inside])
    keep = np.zeros(len(x), bool)
    keep[np.flatnonzero(inside)[np.abs(wl.to_value(u.um) - lam) <= half]] = True
    if not keep.any():
        return f, None
    return f, {"x": x, "y": y, "keep": keep}


with ThreadPoolExecutor(16) as pool:
    cov = [(f, c) for f, c in pool.map(coverage, frames) if c is not None]
T["2 headers+wavelength"] = time.time() - t
covered = np.zeros(len(children), int)
for _, c in cov:
    covered += c["keep"]
print(f"2) images that saw part of the tile at band {band} ({lam:.3f} um): {len(cov)}  ({T['2 headers+wavelength']:.1f}s)")
print(f"   tile pixels covered: {np.mean(covered > 0):.1%}; median images per covered pixel: {np.median(covered[covered > 0]):.0f}")

# --- 3. download only the needed part of each contributing image ------------------------
t = time.time()
nbytes = [0]


def fetch(fc):
    f, c = fc
    xs, ys = c["x"][c["keep"]], c["y"][c["keep"]]
    x0, x1, y0, y1 = int(xs.min()) - 3, int(xs.max()) + 4, int(ys.min()) - 3, int(ys.max()) + 4
    # cutout around the bounding box centre, big enough for the box (6.15"/px)
    hdr_c = None
    with httpx.Client(timeout=30, follow_redirects=True) as cl:
        hdr_c = framemeta._image_header(cl, f["access_url"])
    w = WCS(hdr_c)
    cen = w.pixel_to_world((x0 + x1) / 2, (y0 + y1) / 2)
    size = max(x1 - x0, y1 - y0) * 6.15 / 3600 * 1.05
    url = f"{f['access_url']}?center={cen.ra.deg},{cen.dec.deg}d&size={size:.4f}"
    for wait in (0, 3, 6, 12):
        time.sleep(wait)
        r = httpx.get(url, timeout=90, follow_redirects=True)
        if r.status_code == 200:
            break
    if r.status_code != 200:
        return None
    nbytes[0] += len(r.content)
    with fits.open(io.BytesIO(r.content)) as h:
        img = h["IMAGE"].data.astype(float) - h["ZODI"].data.astype(float)
        flags = h["FLAGS"].data
        img[(flags & (1 | 64 | 512 | 1024 | 4)) != 0] = np.nan
        wc = WCS(h["IMAGE"].header)
    px, py = wc.world_to_pixel(sky[c["keep"]])
    vals = map_coordinates(img, [py, px], order=1, mode="constant", cval=np.nan)
    return c["keep"], vals


with ThreadPoolExecutor(4) as pool:
    got = [g for g in pool.map(fetch, cov) if g is not None]
T["3 download+sample"] = time.time() - t
print(f"3) downloaded {len(got)}/{len(cov)} cutouts, {nbytes[0] / 1e6:.0f} MB  ({T['3 download+sample']:.1f}s)")

# --- 4. combine (median per pixel) -----------------------------------------------------
t = time.time()
stack = np.full((len(got), len(children)), np.nan)
for i, (keep, vals) in enumerate(got):
    stack[i, keep] = vals
with np.errstate(all="ignore"):
    tile = np.nanmedian(stack, axis=0)
T["4 combine"] = time.time() - t
T["total"] = time.time() - t_all
print(f"4) combined ({T['4 combine']:.1f}s). Pixels with data: {np.isfinite(tile).mean():.1%}")
print("TIMES " + json.dumps({k: round(v, 1) for k, v in T.items()}))


# --- picture of the tile (nested -> x,y by de-interleaving bits, as HiPS does) ---------
def deinterleave(n):
    x = y = 0
    for b in range(sub):
        x |= ((n >> (2 * b)) & 1) << b
        y |= ((n >> (2 * b + 1)) & 1) << b
    return x, y


idx = np.arange(4**sub)
xs = np.zeros_like(idx)
ys = np.zeros_like(idx)
for b in range(sub):
    xs |= ((idx >> (2 * b)) & 1) << b
    ys |= ((idx >> (2 * b + 1)) & 1) << b
img = np.full((512, 512), np.nan)
img[ys, xs] = tile
good = np.isfinite(img)
lo, hi = np.percentile(img[good], [1, 99.7])
v = np.clip((img - lo) / (hi - lo), 0, 1)
v = np.arcsinh(10 * v) / np.arcsinh(10)
from PIL import Image
Image.fromarray((np.nan_to_num(v) * 255).astype(np.uint8)).save(f"{OUT}/tile_b{band}.png")
print("saved", f"{OUT}/tile_b{band}.png")
