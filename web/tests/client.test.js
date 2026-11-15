// Guide API client (guide/client.js, UI plan U7), with fetch mocked. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { askGuide, buildRequest, describeTarget, gatherFacts } from '../src/guide/client.js';

const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('askGuide: a valid reply gives its steps, and posts JSON to /api/guide', async () => {
  let seen = null;
  const steps = [{ say: 'Hi.', actions: [{ circle: 'sky:barnard' }] }];
  const fetchFn = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ steps, source: 'claude' }) };
  };
  const out = await askGuide({ trigger: 'object' }, { fetchFn });
  assert.deepEqual(out, { steps });
  assert.equal(seen.url, '/api/guide');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { trigger: 'object' });
});

test('askGuide: every failure becomes { fallback: true } (never rejects)', async () => {
  const marker = await askGuide({}, { fetchFn: reply(200, { steps: [], fallback: true, reason: 'no API key on the server' }) });
  assert.deepEqual(marker, { fallback: true, reason: 'no API key on the server' });
  assert.equal((await askGuide({}, { fetchFn: reply(200, { steps: [] }) })).reason, 'empty reply');
  assert.equal((await askGuide({}, { fetchFn: reply(200, null) })).fallback, true);
  assert.equal((await askGuide({}, { fetchFn: reply(404, { detail: 'Not Found' }) })).reason, 'HTTP 404');
  const down = await askGuide({}, { fetchFn: async () => Promise.reject(new TypeError('Failed to fetch')) });
  assert.equal(down.fallback, true);
  assert.match(down.reason, /network/);
  const badJson = await askGuide({}, { fetchFn: async () => ({ ok: true, status: 200, json: async () => JSON.parse('{oops') }) });
  assert.equal(badJson.fallback, true);
});

// a fetch that only settles when aborted
const hanging = async (url, { signal }) =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));

test('askGuide: times out, and can be cancelled', async () => {
  const t0 = Date.now();
  assert.deepEqual(await askGuide({}, { fetchFn: hanging, timeoutMs: 30 }), { fallback: true, reason: 'timeout' });
  assert.ok(Date.now() - t0 < 1000);
  const ctrl = new AbortController();
  const p = askGuide({}, { fetchFn: hanging, signal: ctrl.signal });
  ctrl.abort();
  assert.deepEqual(await p, { fallback: true, reason: 'aborted' });
  assert.deepEqual(await askGuide({}, { fetchFn: hanging, signal: AbortSignal.abort() }), { fallback: true, reason: 'aborted' });
});

test('describeTarget / buildRequest: names from presets, stubs left out, only view state sent', () => {
  assert.deepEqual(describeTarget('sky:barnard'), { id: 'sky:barnard', name: "Barnard's Star" });
  assert.deepEqual(describeTarget({ id: 'field:mover:0', name: 'Gaia DR3 1' }), { id: 'field:mover:0', name: 'Gaia DR3 1' });
  assert.equal(describeTarget(undefined), null);
  const body = buildRequest({
    trigger: 'colors',
    target: 'sky:barnard',
    state: { view: 'sky', band: 40, level: [1, 2], ra: 269.45, secret: 'x' },
    commands: [{ name: 'set_band', args: {} }, { name: 'focus_search', stub: true }],
    ids: ['band-d6', 'band-d6', 'sky:barnard', 7],
  });
  assert.equal(body.trigger, 'colours');
  assert.deepEqual(body.state, { view: 'sky', band: 40, ra: 269.45 });
  assert.deepEqual(body.commands, ['set_band']);
  assert.deepEqual(body.ids, ['band-d6', 'sky:barnard']);
});

test('gatherFacts: band, preset, time-lapse, movers with a target match, spectrum blends', () => {
  const state = { view: 'field', ra: 269.45, dec: 4.74, ffov: 0.1, band: 92, frameIndex: 1 };
  const wavelengths = Array.from({ length: 102 }, (_, k) => 0.75 + k * 0.042);
  const player = {
    getSequence: () => [
      { meta: { date_iso: '2025-05-01T10:00:00', wavelength_um: 4.61 } },
      { meta: { date_iso: '2025-11-02T10:00:00', wavelength_um: 4.65 } },
    ],
    getGeometry: () => ({ scale: 6.15 }),
    getMovers: () => ({
      epoch_mjd: 61041,
      notes: ['CatWISE duplicates merged'],
      movers: [
        { id: 'Gaia DR3 far', catalog: 'Gaia DR3', ra: 269.47, dec: 4.74, pmra: 30, pmdec: 40, mag: 15.2, band: 'G' },
        { id: 'Gaia DR3 4472832130942575872', catalog: 'Gaia DR3', ra: 269.4501, dec: 4.7401, pmra: -801.6, pmdec: 10362.4, mag: 8.19, band: 'G' },
      ],
    }),
  };
  const spectrum = { getLast: () => ({ field: { ra: 269.45, dec: 4.74 }, points: [1, 2, 3], complete: true, units: 'mJy', blends: [{ g_mag: 16.34, sep_arcsec: 3.31 }] }) };
  const f = gatherFacts({ state, target: 'field:target', player, spectrum, wavelengths });
  assert.deepEqual(f.band, { band: 92, detector: 'D6', channel: 8, wavelength_um: 4.614 });
  assert.equal(f.timelapse.frames, 2);
  assert.deepEqual(f.timelapse.dates, ['2025-05-01', '2025-11-02']);
  assert.deepEqual(f.timelapse.shown, { index: 1, date: '2025-11-02' });
  assert.deepEqual(f.timelapse.wavelength_um, [4.61, 4.65]);
  assert.equal(f.movers.count, 2);
  assert.equal(f.movers.nearest[0].name, 'Gaia DR3 4472832130942575872');
  assert.equal(f.target_match.pm_mas_yr, 10393);
  assert.deepEqual(f.spectrum.blends, [{ g_mag: 16.3, sep_arcsec: 3.3 }]);
  assert.ok(JSON.stringify(f).length < 2000, 'facts stay small');
  // the sky view: no field facts; a preset target brings its note
  const sky = gatherFacts({ state: { view: 'sky', band: 40 }, target: 'sky:barnard', player, spectrum });
  assert.equal(sky.preset.label, "Barnard's Star");
  assert.equal(sky.timelapse, undefined);
  assert.equal(sky.band.wavelength_um, undefined);
  // a spectrum of another field is not used
  const moved = gatherFacts({ state: { ...state, ra: 10 }, target: 'field:target', player, spectrum });
  assert.equal(moved.spectrum, undefined);
});
