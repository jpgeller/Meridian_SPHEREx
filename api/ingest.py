"""Warm the cache for the showcase targets, and keep it fresh.

    python -m ingest --targets showcase            # all five challenge targets (+ Milky Way centre listing)
    python -m ingest --targets "WISE 0855" barnard # some of them
    python -m ingest --refresh                     # forget frame lists older than 7 days (new SPHEREx data)
    python -m ingest --clean-full                  # delete full-file fallbacks (large, rarely needed)

Run from meridian/api with the venv. Safe to re-run: everything already cached is skipped.
What it precomputes per target (field 0.1 deg):
  * the frame list and per-frame wavelengths  (/api/frames/meta)
  * aligned cutouts: per visit at most one frame per band (what the player's detector and
    colour modes load), so every band mode opens instantly
  * the spectrum frames (2 per band)
  * WISE W2 epochs and Gaia DR3 stars for the context views
"""
from __future__ import annotations

import argparse
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import cache
import context
import cutouts
import resolve
import spectra
import spherex

FOV = 0.1
WORKERS = 2  # IRSA throttles parallel cutout traffic; bulk jobs stay gentle
BUSY_PAUSE_S = 120  # after a run of 503s, pause before trying again
BUSY_STREAK = 6

# Same targets as the web presets (web/src/sky/presets.js). Names go through /api/resolve's
# logic, so positions match what the browser asks for.
SHOWCASE = {
    "barnard": "Barnard's Star",
    "eps_ind_b": "eps Ind B",
    "wise_0855": "WISEA J085510.74-071442.5",
    "rw_aur": "RW Aur",
    "r_dra": "R Dra",
}


def round5(v: float) -> float:
    return round(v, 5)


MAX_PER_VISIT_DETECTOR = 4
# Single-band mode loads EVERY frame of the band (not one per visit): cache it for the band the app
# opens with (40, the default) and for 92 (D6, ~4.6 um, like WISE W2: the brown-dwarf band).
SINGLE_BANDS = (40, 92)
FOLD = {0: 1, 50: 49, 51: 52}  # blank HiPS frames fold onto neighbours, as displayBand() in web/src/field/frames.js


def per_visit_band(frames: list[dict], max_per_group: int = MAX_PER_VISIT_DETECTOR) -> list[dict]:
    """Mirror of web/src/field/sequence.js capPerVisitBand (keep both in sync)."""
    fold = FOLD
    seen, per_band = set(), []
    for f in sorted(frames, key=lambda f: -f["mjd"]):
        key = (f["visit"], fold.get(f.get("band"), f.get("band")))
        if key in seen:
            continue
        seen.add(key)
        per_band.append(f)
    groups: dict[tuple, list[dict]] = {}
    for f in per_band:
        groups.setdefault((f["visit"], f["detector"]), []).append(f)
    out = []
    for g in groups.values():
        g.sort(key=lambda f: fold.get(f.get("band"), f.get("band")))
        if len(g) <= max_per_group:
            out.extend(g)
        else:
            out.extend(g[round(i * (len(g) - 1) / (max_per_group - 1))] for i in range(max_per_group))
    return out


def warm_target(label: str, name: str) -> dict:
    t0 = time.time()
    pos = resolve.resolve(name)
    ra, dec = round5(pos["ra"]), round5(pos["dec"])
    print(f"\n== {label}: {name} -> {ra:.5f}, {dec:.5f}", flush=True)
    meta = spherex.frames_with_meta(ra, dec, wait=True)  # bring an expired list up to date first
    # the same frames the web app can use (sequence.js `usable` / frames.js framesForBand): a frame
    # without a band would take a slot in the per-detector spread and shift which frames are picked
    frames = [f for f in meta["frames"] if f.get("inside") and not f.get("error") and f.get("band") is not None]
    # Pick exactly as the player does for each mode. Neighbouring detectors overlap in wavelength,
    # so a D5 frame can share a band number with a D6 one: picking over all detectors at once
    # takes different frames from detector mode, which only looks at its own detector.
    wanted = {f["id"]: f for f in per_visit_band(frames)}
    for d in range(1, 7):  # detector mode
        wanted.update({f["id"]: f for f in per_visit_band([f for f in frames if f["detector"] == d])})
    # the default colour mix (state.js rgb: D6, D4, D2)
    wanted.update({f["id"]: f for f in per_visit_band([f for f in frames if f["detector"] in (6, 4, 2)])})
    for f in frames:
        if FOLD.get(f["band"], f["band"]) in SINGLE_BANDS:
            wanted[f["id"]] = f
    for f in spectra._select(frames, spectra.PER_BAND):
        wanted[f["id"]] = f
    todo = [f for f in wanted.values() if not cutouts.is_processed(f, ra, dec, FOV)]
    print(f"   {meta['n_frames']} frames, {meta['n_visits']} visits; {len(wanted)} cutouts wanted, {len(todo)} to fetch", flush=True)
    done = failed = 0
    streak = 0  # consecutive "service busy" answers
    import threading
    lock = threading.Lock()

    def one(f):
        nonlocal streak
        for attempt in range(3):
            try:
                cutouts.process(f, ra, dec, FOV)
                with lock:
                    streak = 0
                return True
            except cutouts.CutoutBusy:
                with lock:
                    streak += 1
                    pause = streak >= BUSY_STREAK
                if pause:
                    print(f"   IRSA cutout service busy; pausing {BUSY_PAUSE_S}s", flush=True)
                    time.sleep(BUSY_PAUSE_S)
                    with lock:
                        streak = 0
            except Exception as err:
                print(f"   ! {f['id']}: {err}", flush=True)
                return False
        print(f"   ! {f['id']}: still busy, skipped (rerun ingest later)", flush=True)
        return False

    t_start = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for ok in pool.map(one, todo):
            done += 1
            failed += not ok
            if done % 20 == 0 or done == len(todo):
                rate = done / max(time.time() - t_start, 1)
                eta = (len(todo) - done) / rate / 60 if rate else 0
                print(f"   cutouts {done}/{len(todo)} (~{eta:.0f} min left)", flush=True)
    try:
        w = context.wise_frames(ra, dec, FOV, 2)
        for f in w["frames"]:
            context.wise_frame_png(ra, dec, FOV, 2, f["index"])
        n_wise = len(w["frames"])
    except Exception as err:
        print(f"   ! WISE: {err}", flush=True)
        n_wise = 0
    try:
        n_gaia = context.gaia_sources(ra, dec, FOV)["n"]
    except Exception as err:
        print(f"   ! Gaia: {err}", flush=True)
        n_gaia = 0
    try:  # moving objects for the change video (Gaia DR3 + CatWISE2020)
        import movers
        n_movers = len(movers.field_movers(ra, dec, FOV)["movers"])
    except Exception as err:
        print(f"   ! movers: {err}", flush=True)
        n_movers = 0
    took = time.time() - t0
    print(f"   done in {took:.0f}s: WISE epochs {n_wise}, Gaia stars {n_gaia}, movers {n_movers}, failed cutouts {failed}", flush=True)
    return {"target": label, "ra": ra, "dec": dec, "cutouts": len(wanted), "failed": failed, "wise": n_wise, "gaia": n_gaia}


def refresh(max_age_days: float = 7) -> int:
    """Delete cached frame lists older than max_age_days, so new SPHEREx data shows up."""
    n = 0
    limit = time.time() - max_age_days * 86400
    for p in (cache.ROOT / "frames").rglob("*.json"):
        if p.stat().st_mtime < limit:
            p.unlink()
            n += 1
    return n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--targets", nargs="*", help='"showcase" or keys/names: barnard, wise_0855, "R Dra" ...')
    ap.add_argument("--refresh", action="store_true", help="forget frame lists older than 7 days")
    ap.add_argument("--clean-full", action="store_true", help="delete full-file fallbacks from the cache")
    args = ap.parse_args(argv)
    cutouts.ALLOW_FULL_FALLBACK = False  # bulk job: wait for the cutout service, never pull full files
    if not (args.targets or args.refresh or args.clean_full):
        ap.print_help()
        return 1
    if args.refresh:
        print(f"forgot {refresh()} frame lists older than 7 days")
    if args.clean_full:
        full = cache.ROOT / "full"
        size = sum(p.stat().st_size for p in full.rglob("*") if p.is_file()) if full.exists() else 0
        shutil.rmtree(full, ignore_errors=True)
        print(f"deleted full-file fallbacks ({size / 1e9:.1f} GB)")
    if args.targets:
        keys = list(SHOWCASE) if args.targets == ["showcase"] else args.targets
        results = []
        for k in keys:
            try:
                results.append(warm_target(k, SHOWCASE.get(k, k)))
            except Exception as err:  # one target failing (e.g. a name-lookup timeout) must not stop the rest
                print(f"   ! {k}: {err}  (rerun ingest to retry)", flush=True)
                results.append({"target": k, "ra": float("nan"), "dec": float("nan"), "cutouts": 0, "failed": -1, "wise": 0, "gaia": 0})
        print("\nsummary:")
        for r in results:
            print(f"  {r['target']:<10} {r['ra']:.5f} {r['dec']:+.5f}  cutouts {r['cutouts']:>4} (failed {r['failed']})  WISE {r['wise']:>2}  Gaia {r['gaia']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
