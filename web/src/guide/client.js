// Guide API client (UI plan, U7): asks POST /api/guide (Claude, on the server) for a script.
//
//   gatherFacts({ state, target, player?, spectrum?, wavelengths? }) -> facts   (pure, small)
//        Real numbers already loaded in the page: band/detector/wavelength, the preset's note,
//        the time-lapse frames (count, dates, wavelengths, ″/px), fast movers and the Gaia/CatWISE
//        match of the target, the spectrum's blends. Never gaze positions or anything about the person.
//   buildRequest({ trigger, target, state, facts, commands, ids }) -> the POST body
//   askGuide(body, { fetchFn?, timeoutMs?, signal? }) -> Promise<{ steps } | { fallback: true, reason }>
//        Never rejects: network error, HTTP error, timeout (9 s), abort, the server's fallback marker or an
//        empty/odd reply all come back as { fallback: true, reason }, and the caller plays its local
//        fallback script (fallback.js). The runner re-validates the steps (runner.js validateScript).

import { presetById } from '../sky/presets.js';
import { detectorOf } from '../core/bands.js';

export const CLIENT_TIMEOUT_MS = 9000; // the server gives the model 8 s
const MAX_DATES = 12;
const MAX_MOVERS = 5;
const MATCH_ARCSEC = 10; // a mover this close to the field centre is "the target"

const r = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : undefined);
const day = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : undefined);
const STATE_KEYS = ['view', 'ra', 'dec', 'fov', 'ffov', 'proj', 'band', 'mode', 'rgb', 'formula', 'color', 'op', 'frameIndex', 'playing', 'layers'];

/** A target as { id, name } (from an id string, an object, or nothing). */
export function describeTarget(target) {
  const t = typeof target === 'string' ? { id: target } : target ?? {};
  const id = typeof t.id === 'string' ? t.id : null;
  const preset = id && /^(sky|field):/.test(id) ? presetById(id.split(':')[1]) : null;
  const name = t.name || preset?.label || null;
  return id || name ? { ...(id ? { id } : {}), ...(name ? { name } : {}) } : null;
}

const sepArcsec = (ra, dec, ra0, dec0) => Math.hypot((ra - ra0) * Math.cos((dec0 * Math.PI) / 180), dec - dec0) * 3600;

/** The small fact sheet the model explains from (see the header). */
export function gatherFacts({ state = {}, target = null, player = null, spectrum = null, wavelengths = null } = {}) {
  const facts = {};
  const t = describeTarget(target);
  const preset = t?.id && /^(sky|field):/.test(t.id) ? presetById(t.id.split(':')[1]) : null;
  if (preset) facts.preset = { label: preset.label, note: preset.note };

  if (Number.isInteger(state.band)) {
    const { detector, channel } = detectorOf(state.band);
    facts.band = { band: state.band, detector: `D${detector}`, channel, wavelength_um: r(wavelengths?.[state.band], 3) };
  }

  if (state.view === 'field' && player) {
    const seq = player.getSequence?.() ?? [];
    if (seq.length) {
      const wl = seq.map((f) => f.meta?.wavelength_um).filter(Number.isFinite);
      const geom = player.getGeometry?.();
      const i = Math.min(Math.max(0, state.frameIndex ?? 0), seq.length - 1);
      facts.timelapse = {
        frames: seq.length,
        dates: seq.slice(0, MAX_DATES).map((f) => day(f.meta?.date_iso)).filter(Boolean),
        first: day(seq[0].meta?.date_iso),
        last: day(seq.at(-1).meta?.date_iso),
        shown: { index: i, date: day(seq[i].meta?.date_iso) },
        ...(wl.length ? { wavelength_um: [r(Math.min(...wl), 3), r(Math.max(...wl), 3)] } : {}),
        ...(geom?.scale ? { arcsec_per_px: r(geom.scale, 2) } : {}),
        field_deg: state.ffov,
      };
    } else facts.timelapse = { frames: 0 };

    const cat = player.getMovers?.();
    if (cat && Array.isArray(cat.movers)) {
      const list = cat.movers
        .map((m) => ({
          name: m.id,
          catalog: m.catalog,
          pm_mas_yr: r(Math.hypot(m.pmra ?? 0, m.pmdec ?? 0), 0),
          mag: r(m.mag, 1),
          mag_band: m.band,
          sep_arcsec: r(sepArcsec(m.ra, m.dec, state.ra, state.dec), 1),
        }))
        .sort((a, b) => a.sep_arcsec - b.sep_arcsec);
      facts.movers = {
        count: list.length,
        nearest: list.slice(0, MAX_MOVERS),
        epoch: 'positions at 2026.0',
        ...(Array.isArray(cat.notes) && cat.notes.length ? { notes: cat.notes.slice(0, 3).map((n) => String(n).slice(0, 200)) } : {}),
      };
      const match = list.find((m) => m.sep_arcsec <= MATCH_ARCSEC);
      facts.target_match = match ? { name: match.name, catalog: match.catalog, pm_mas_yr: match.pm_mas_yr, sep_arcsec: match.sep_arcsec } : null;
    }

    const spec = spectrum?.getLast?.();
    const sameField = spec?.field && Math.abs(spec.field.ra - state.ra) < 1e-4 && Math.abs(spec.field.dec - state.dec) < 1e-4;
    if (spec && sameField) {
      facts.spectrum = {
        points: spec.points?.length ?? 0,
        complete: Boolean(spec.complete),
        units: spec.units,
        blends: (spec.blends ?? []).slice(0, 3).map((b) => ({ g_mag: r(b.g_mag, 1), sep_arcsec: r(b.sep_arcsec, 1) })),
      };
    }
  }
  return facts;
}

/** The POST body. `commands` = commands.list() (stubs are left out), `ids` = registry ids in the page. */
export function buildRequest({ trigger, target, state = {}, facts = {}, commands = [], ids = [] }) {
  const s = {};
  for (const k of STATE_KEYS) if (state[k] !== undefined) s[k] = state[k];
  return {
    trigger: trigger === 'colors' ? 'colours' : trigger,
    target: describeTarget(target),
    state: s,
    facts,
    commands: commands.filter((c) => c && !c.stub).map((c) => c.name),
    ids: [...new Set(ids.filter((i) => typeof i === 'string'))].slice(0, 200),
  };
}

/** POST the body; never rejects (see the header). */
export async function askGuide(body, { fetchFn = globalThis.fetch, timeoutMs = CLIENT_TIMEOUT_MS, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(new Error('aborted'));
  signal?.addEventListener?.('abort', onAbort);
  try {
    if (signal?.aborted) return { fallback: true, reason: 'aborted' };
    const res = await fetchFn('/api/guide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { fallback: true, reason: `HTTP ${res.status}` };
    const data = await res.json();
    if (data?.fallback) return { fallback: true, reason: String(data.reason ?? 'server fallback') };
    if (!Array.isArray(data?.steps) || !data.steps.length) return { fallback: true, reason: 'empty reply' };
    return { steps: data.steps, ...(data.cached ? { cached: true } : {}) };
  } catch (err) {
    const reason = signal?.aborted ? 'aborted' : ctrl.signal.aborted ? 'timeout' : `network: ${err?.message ?? err}`;
    return { fallback: true, reason };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
