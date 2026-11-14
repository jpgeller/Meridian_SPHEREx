// Stage 1 of the player: which images make up the sequence for the current band mode.
//   single : every frame that saw this spot in the chosen band (optionally one per visit)
// Step 8 adds: detector (all bands of one detector, combined per visit), rgb, custom.
import { framesForBand, loadCutout, medianStack } from './frames.js';

export function sequenceKey(s, local) {
  return [s.ra.toFixed(5), s.dec.toFixed(5), s.ffov, s.band, s.mode, s.rgb.join('.'), s.formula, local.perVisit].join('|');
}

/** Load cutouts for `frames`, tolerating individual failures. */
export async function loadAll(frames, s, { stale, progress }) {
  let done = 0;
  progress?.(0, frames.length);
  const results = await Promise.allSettled(
    frames.map((f) =>
      loadCutout(f, s.ra, s.dec, s.ffov).finally(() => {
        if (!stale?.()) progress?.(++done, frames.length);
      }),
    ),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (frames.length && !ok.length) throw new Error(results[0].reason?.message ?? 'no image could be loaded');
  return { ok, failed: results.length - ok.length };
}

export function groupByVisit(cutouts, combine = medianStack) {
  const byVisit = new Map();
  for (const c of cutouts) {
    const v = c.meta.visit;
    if (!byVisit.has(v)) byVisit.set(v, []);
    byVisit.get(v).push(c);
  }
  return [...byVisit.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => combine(group));
}

/**
 * Returns { items: aligned frames in date order, failed, emptyMessage }.
 * `list` is the /api/frames/meta response for this position.
 */
export async function buildSequence(list, s, local, hooks) {
  const frames = framesForBand(list, s.band);
  if (!frames.length) {
    return { items: [], failed: 0, emptyMessage: `No SPHEREx image saw this spot in band ${s.band}. Nearby bands with images:` };
  }
  const { ok, failed } = await loadAll(frames, s, hooks);
  return { items: local.perVisit ? groupByVisit(ok) : ok, failed };
}
