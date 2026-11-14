// Stage 1 of the player: which images make up the sequence for the current band mode.
//   single   : every frame that saw this spot in the chosen band (optionally one per visit)
//   detector : every frame of the band's detector (~17 bands), averaged per visit -> deeper
//   rgb      : three channels (bands or detectors), each averaged per visit -> colour image
//   custom   : a formula of bands/detectors (e.g. D6 - D1), evaluated per visit
// Grey items are aligned frames { id, data, w, h, meta }; colour items are
// { id, rgb: [frame|null x3], w, h, meta }.
import { framesForBand, displayBand, loadCutout, medianStack } from './frames.js';
import { addFrames } from './compare.js';
import { parseFormula, evaluateFormula, FormulaError } from './formula.js';
import { detectorOf } from '../core/bands.js';

export function sequenceKey(s, local) {
  return [s.ra.toFixed(5), s.dec.toFixed(5), s.ffov, s.band, s.mode, s.rgb.join('.'), s.formula, local.perVisit].join('|');
}

const usable = (f) => f.inside && !f.error && f.band != null;

/** Frame filter for a channel token: a band number or 'D1'..'D6'. */
export function selectorFor(token) {
  if (typeof token === 'string' && /^D[1-6]$/.test(token)) {
    const d = Number(token[1]);
    return { key: token, label: `D${d}`, match: (f) => usable(f) && f.detector === d };
  }
  const b = Number(token);
  return { key: `b${b}`, label: `band ${b}`, match: (f) => usable(f) && displayBand(f.band) === b };
}

/** Load cutouts for `frames`, tolerating individual failures. */
export async function loadAll(frames, s, { stale, progress } = {}) {
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

/** Map visit -> cutouts, visits in date order. */
export function byVisit(cutouts) {
  const m = new Map();
  for (const c of [...cutouts].sort((a, b) => a.meta.mjd - b.meta.mjd)) {
    const v = c.meta.visit;
    if (!m.has(v)) m.set(v, []);
    m.get(v).push(c);
  }
  return m;
}

export function groupByVisit(cutouts, combine = medianStack) {
  return [...byVisit(cutouts).values()].map(combine);
}

/** Mean of a visit's frames with wavelength range metadata. */
function combineVisit(frames) {
  const sum = addFrames(frames);
  const wls = frames.map((f) => f.meta.wavelength_um);
  sum.meta.wl_min = Math.min(...wls);
  sum.meta.wl_max = Math.max(...wls);
  return sum;
}

function unionFrames(list, selectors) {
  const seen = new Map();
  for (const f of list.frames) if (selectors.some((sel) => sel.match(f))) seen.set(f.id, f);
  return [...seen.values()];
}

/**
 * Returns { items, failed, emptyMessage, kind } for the current mode.
 * `list` is the /api/frames/meta response for this position.
 */
export async function buildSequence(list, s, local, hooks) {
  if (s.mode === 'detector') {
    const d = detectorOf(s.band).detector;
    const sel = selectorFor(`D${d}`);
    const frames = list.frames.filter(sel.match);
    if (!frames.length) return { items: [], failed: 0, emptyMessage: `No detector D${d} images of this spot. Nearby bands with images:` };
    const { ok, failed } = await loadAll(frames, s, hooks);
    const items = groupByVisit(ok, combineVisit).map((f) => ({ ...f, meta: { ...f.meta, detector: d, mode: 'detector' } }));
    return { items, failed, kind: 'grey' };
  }

  if (s.mode === 'rgb') {
    const sels = s.rgb.map(selectorFor);
    const frames = unionFrames(list, sels);
    if (!frames.length) return { items: [], failed: 0, emptyMessage: 'None of the colour channels has images of this spot.' };
    const { ok, failed } = await loadAll(frames, s, hooks);
    const items = [];
    for (const visitFrames of byVisit(ok).values()) {
      const channels = sels.map((sel) => {
        const fs = visitFrames.filter((c) => sel.match(c.meta));
        return fs.length ? combineVisit(fs) : null;
      });
      const present = channels.filter(Boolean);
      if (!present.length) continue;
      const first = visitFrames[0];
      items.push({
        id: `rgb:${first.meta.visit}`,
        rgb: channels,
        w: first.w,
        h: first.h,
        meta: {
          ...first.meta,
          mode: 'rgb',
          date_iso: visitFrames[0].meta.date_iso,
          date_end_iso: visitFrames.at(-1).meta.date_iso,
          n_combined: present.reduce((n, c) => n + (c.meta.n_combined ?? 1), 0),
          channels: sels.map((sel, i) => ({ label: sel.label, present: Boolean(channels[i]) })),
          detector: null,
          wavelength_um: NaN,
          bad_pct: Math.max(...present.map((c) => c.meta.bad_pct ?? 0)),
        },
      });
    }
    return { items, failed, kind: 'rgb' };
  }

  if (s.mode === 'custom') {
    let parsed;
    try {
      parsed = parseFormula(s.formula);
    } catch (err) {
      if (err instanceof FormulaError) return { items: [], failed: 0, emptyMessage: `Formula problem: ${err.message}.` };
      throw err;
    }
    const sels = parsed.inputs.map((inp) => selectorFor(inp.kind === 'detector' ? inp.key : inp.value));
    const frames = unionFrames(list, sels);
    if (!frames.length) return { items: [], failed: 0, emptyMessage: 'No images here for the bands in this formula.' };
    const { ok, failed } = await loadAll(frames, s, hooks);
    const items = [];
    for (const visitFrames of byVisit(ok).values()) {
      const images = {};
      let complete = true;
      for (const sel of sels) {
        const fs = visitFrames.filter((c) => sel.match(c.meta));
        if (!fs.length) {
          complete = false;
          break;
        }
        images[sel.key] = combineVisit(fs).data;
      }
      if (!complete) continue; // a visit must have every input to evaluate the formula
      const first = visitFrames[0];
      items.push({
        id: `formula:${first.meta.visit}`,
        data: evaluateFormula(parsed, images, first.w * first.h),
        w: first.w,
        h: first.h,
        meta: {
          ...first.meta,
          mode: 'custom',
          formula: s.formula,
          date_iso: first.meta.date_iso,
          date_end_iso: visitFrames.at(-1).meta.date_iso,
          detector: null,
          wavelength_um: NaN,
        },
      });
    }
    if (!items.length) return { items: [], failed, emptyMessage: 'No single visit has images for every band in this formula.' };
    return { items, failed, kind: 'grey' };
  }

  // single band
  const frames = framesForBand(list, s.band);
  if (!frames.length) {
    return { items: [], failed: 0, emptyMessage: `No SPHEREx image saw this spot in band ${s.band}. Nearby bands with images:` };
  }
  const { ok, failed } = await loadAll(frames, s, hooks);
  return { items: local.perVisit ? groupByVisit(ok) : ok, failed, kind: 'grey' };
}
