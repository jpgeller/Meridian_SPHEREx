// Unit tests for the pure core modules.  Run: npm test   (uses node:test, no extra deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBand, stepBand, detectorOf } from '../src/core/bands.js';
import { createStore, DEFAULTS } from '../src/core/state.js';
import { parseCoordinates } from '../src/core/coords.js';
import { parseQuery, toQuery } from '../src/core/url.js';
import { createCommands } from '../src/core/commands.js';
import { registerDefaultCommands } from '../src/core/defaultCommands.js';

const quiet = (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
};

function setup(initial) {
  const store = createStore(initial);
  const events = [];
  const target = new EventTarget();
  target.addEventListener('meridian:command', (e) => events.push(e.detail));
  const commands = createCommands({ target });
  registerDefaultCommands(commands, store);
  return { store, commands, events };
}

test('bands: blank frames are skipped in the direction of travel', () => {
  assert.equal(normalizeBand(50, +1), 52);
  assert.equal(normalizeBand(51, -1), 49);
  assert.equal(normalizeBand(0), 1);
  assert.equal(normalizeBand(500), 101);
  assert.equal(stepBand(49, +1), 52);
  assert.equal(stepBand(52, -1), 49);
  assert.equal(stepBand(101, +1), 101);
  assert.equal(stepBand(1, -1), 1);
  assert.deepEqual(detectorOf(40), { detector: 3, channel: 7 });
});

test('state: invalid values are ignored, valid ones normalised', () => {
  const store = createStore();
  quiet(() => store.set({ view: 'nonsense', fov: -3, band: 'abc', layers: ['gaia', 'bogus'] }));
  assert.deepEqual(store.get(), { ...DEFAULTS });
  store.set({ ra: 370, dec: 95, fov: 1e6 });
  assert.equal(store.get().ra, 10);
  assert.equal(store.get().dec, 90);
  assert.equal(store.get().fov, 360);
});

test('state: subscribers get changed keys and source; no-op sets are silent', () => {
  const store = createStore();
  const calls = [];
  store.subscribe((s, changed, source) => calls.push([changed, source]));
  store.set({ band: 72 }, 'command');
  store.set({ band: 72 }, 'command');
  assert.deepEqual(calls, [[['band'], 'command']]);
});

test('coords: decimal and sexagesimal forms', () => {
  assert.deepEqual(parseCoordinates('133.795 -7.245'), { ra: 133.795, dec: -7.245 });
  assert.deepEqual(parseCoordinates('133.795, -7.245'), { ra: 133.795, dec: -7.245 });
  const w = parseCoordinates('08h55m10.831s -07d14m42.53s');
  assert.ok(Math.abs(w.ra - 133.795129) < 1e-5 && Math.abs(w.dec - -7.245147) < 1e-5);
  assert.deepEqual(parseCoordinates('08 55 10.831 -07 14 42.53'), w);
  assert.deepEqual(parseCoordinates('08:55:10.831 -07:14:42.53'), w);
  // Negative zero degrees keeps its sign
  assert.ok(parseCoordinates('00 00 00 -00 30 00').dec < 0);
  assert.equal(parseCoordinates("Barnard's Star"), null);
  assert.equal(parseCoordinates('400 10'), null);
});

test('url: round trip keeps state, defaults are omitted', () => {
  const store = createStore();
  store.set({ ra: 133.7951, dec: -7.2451, fov: 2, band: 72, proj: 'AIT', mode: 'rgb', rgb: [88, 72, 40], layers: ['gaia'] });
  const q = toQuery(store.get());
  assert.equal(q, 'ra=133.7951&dec=-7.2451&fov=2&band=72&proj=AIT&mode=rgb&rgb=88,72,40&layers=gaia');
  const store2 = createStore();
  store2.set(parseQuery(q).patch);
  assert.deepEqual(store2.get(), store.get());
  assert.equal(parseQuery('?name=WISE%200855').name, 'WISE 0855');
});

test('commands: set_band updates state and emits meridian:command', () => {
  const { store, commands, events } = setup();
  const r = commands.run('set_band', { band: 72 }, 'test');
  assert.equal(r.ok, true);
  assert.equal(store.get().band, 72);
  assert.deepEqual(events.at(-1), { name: 'set_band', args: { band: 72 }, source: 'test', ok: true });
});

test('commands: next/prev band skip blanks; zoom and pan move the view', () => {
  const { store, commands } = setup({ band: 49, ra: 100, dec: 0, fov: 8 });
  commands.run('next_band');
  assert.equal(store.get().band, 52);
  commands.run('prev_band');
  assert.equal(store.get().band, 49);
  commands.run('zoom_in');
  assert.ok(Math.abs(store.get().fov - 8 / 1.5) < 1e-9);
  commands.run('pan_left'); // east = +RA
  assert.ok(store.get().ra > 100);
  commands.run('pan_up');
  assert.ok(store.get().dec > 0);
});

test('commands: fly_to with coordinates; names fail cleanly until Step 2', () => {
  const { store, commands } = setup();
  assert.equal(commands.run('fly_to', { target: '08h55m10.831s -07d14m42.53s' }).ok, true);
  assert.ok(Math.abs(store.get().ra - 133.7951) < 1e-3);
  const err = console.error;
  console.error = () => {};
  const r = commands.run('fly_to', { target: 'Sirius' });
  console.error = err;
  assert.equal(r.ok, false);
});

test('commands: async commands emit when they settle, and failures are reported', async () => {
  const { commands, events } = setup();
  commands.register('slow_ok', async () => 42);
  commands.register('slow_fail', async () => { throw new Error('nope'); });
  const a = commands.run('slow_ok');
  assert.equal(a.pending, true);
  assert.equal(await a.value, 42);
  const err = console.error;
  console.error = () => {};
  const b = commands.run('slow_fail');
  await assert.rejects(b.value, /nope/);
  console.error = err;
  assert.deepEqual(events.slice(-2).map((e) => [e.name, e.ok]), [['slow_ok', true], ['slow_fail', false]]);
  assert.equal(events.at(-1).error, 'nope');
});

test('commands: unknown commands are rejected; list() describes every command', () => {
  const { commands } = setup();
  assert.equal(quiet(() => commands.run('launch_rocket')).ok, false);
  const names = commands.list().map((c) => c.name);
  for (const n of ['pan_left', 'zoom_in', 'fly_to', 'set_band', 'open_field', 'toggle_layer', 'select_point']) {
    assert.ok(names.includes(n), n);
  }
  // Every key is bound to exactly one command.
  const keys = commands.list().flatMap((c) => c.keys);
  assert.equal(new Set(keys).size, keys.length);
});

test('commands: toggle_layer and field commands', () => {
  const { store, commands } = setup();
  commands.run('toggle_layer', { layer: 'gaia' });
  assert.deepEqual(store.get().layers, ['gaia']);
  commands.run('toggle_layer', { layer: 'gaia' });
  assert.deepEqual(store.get().layers, []);
  // Too wide: refused with a helpful message
  const err = console.error;
  console.error = () => {};
  const wide = commands.run('open_field');
  console.error = err;
  assert.equal(wide.ok, false);
  assert.match(wide.error, /Zoom in/);
  // Zoomed in to 0.3°: opens with the nearest field size
  store.set({ fov: 0.3 });
  commands.run('open_field');
  assert.equal(store.get().ffov, 0.25);
  // In the field view, zoom steps through field sizes; the sky fov is untouched
  commands.run('zoom_out');
  assert.equal(store.get().ffov, 0.5);
  commands.run('zoom_in');
  commands.run('zoom_in');
  assert.equal(store.get().ffov, 0.1);
  assert.equal(store.get().fov, 0.3);
  commands.run('toggle_play');
  assert.equal(store.get().view, 'field');
  assert.equal(store.get().playing, true);
  commands.run('close_field');
  assert.equal(store.get().view, 'sky');
  assert.equal(store.get().playing, false);
});
