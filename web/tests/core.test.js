// Unit tests for the pure core modules.  Run: npm test   (uses node:test, no extra deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBand, stepBand, detectorOf } from '../src/core/bands.js';
import { createStore, DEFAULTS } from '../src/core/state.js';
import { parseCoordinates, icrsToGalactic, galacticToIcrs, raToUrl, decToUrl, raFromUrl, decFromUrl } from '../src/core/coords.js';
import { parseQuery, toQuery } from '../src/core/url.js';
import { createCommands } from '../src/core/commands.js';
import { registerDefaultCommands } from '../src/core/defaultCommands.js';
import { levelToCuts, cutsToLevel, describeLevel } from '../src/sky/levels.js';

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
  store.set({ ra: 133.7577862, dec: -7.2420234 });
  assert.equal(store.get().ra, 133.75779); // 5 decimals, same as the API cache keys
  assert.equal(store.get().dec, -7.24202);
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

test('state: planetarium view is a valid projection', () => {
  const store = createStore();
  store.set({ proj: 'STG' });
  assert.equal(store.get().proj, 'STG');
});

test('url: round trip keeps state, defaults are omitted', () => {
  const store = createStore();
  store.set({ ra: 133.7951, dec: -7.2451, fov: 2, band: 72, proj: 'AIT', mode: 'rgb', rgb: ['D6', 72, 40], layers: ['gaia'] });
  const q = toQuery(store.get());
  assert.equal(q, 'ra=08h55m10.824s&dec=-7d14m42.36s&fov=2&band=72&proj=AIT&mode=rgb&rgb=D6,72,40&layers=gaia');
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
  // Zoomed in (the sky stops at 1.5°–3°): opens with the last field size, 6′ by default
  store.set({ fov: 2 });
  commands.run('open_field');
  assert.equal(store.get().ffov, 0.1);
  // In the field view, zoom steps through field sizes; the sky fov is untouched
  commands.run('zoom_out');
  assert.equal(store.get().ffov, 0.25);
  commands.run('zoom_in');
  commands.run('zoom_in');
  assert.equal(store.get().ffov, 0.05);
  assert.equal(store.get().fov, 2);
  commands.run('toggle_play');
  assert.equal(store.get().view, 'field');
  assert.equal(store.get().playing, true);
  commands.run('close_field');
  assert.equal(store.get().view, 'sky');
  assert.equal(store.get().playing, false);
});

test('colour views: valid presets and custom mixes; blank bands refused', () => {
  const store = createStore();
  assert.equal(store.get().color, 'tint');
  store.set({ color: 'dust' });
  assert.equal(store.get().color, 'dust');
  quiet(() => store.set({ color: 'neon', mix: [50, 46, 22] }));
  assert.equal(store.get().color, 'dust');
  assert.deepEqual(store.get().mix, [62, 46, 22]);
  store.set({ color: 'custom', mix: [87, 42, 22] });
  const q = toQuery(store.get());
  assert.match(q, /color=custom&.*mix=87,42,22|mix=87,42,22.*color=custom/);
  const s2 = createStore();
  s2.set(parseQuery(q).patch);
  assert.deepEqual(s2.get().mix, [87, 42, 22]);
});

test('brightness/contrast steps convert to display cuts and back', () => {
  assert.deepEqual(levelToCuts([0, 0]), [0, 255]);
  const [lo, hi] = levelToCuts([2, 0]);
  assert.ok(lo < 0 && hi < 255, 'brighter = window moves down');
  assert.deepEqual(cutsToLevel(levelToCuts([1.5, -2])), [1.5, -2]);
  assert.equal(describeLevel([0, 0]), '');
  assert.equal(describeLevel([2, -1]), 'brightness +2 · contrast −1');
});

test('ICRS <-> galactic: the Galactic centre and a round trip', () => {
  const [l, b] = icrsToGalactic([266.40499, -28.93617]); // Sgr A*
  assert.ok(Math.abs(((l + 180) % 360) - 180) < 0.01 && Math.abs(b) < 0.05, `${l}, ${b}`);
  const [ra, dec] = galacticToIcrs(icrsToGalactic([83.822, -5.391]));
  assert.ok(Math.abs(ra - 83.822) < 1e-9 && Math.abs(dec + 5.391) < 1e-9);
  // the value Aladin 3.8.2 reports for the Galactic centre in its galactic view (astropy: 90.81028, -57.85165)
  const [x, y] = galacticToIcrs([266.4168, -29.0078]);
  assert.ok(Math.abs(x - 90.81028) < 1e-4 && Math.abs(y + 57.85165) < 1e-4);
});

test('shortcuts work on a focused checkbox (Space still ticks it), not in text fields', async () => {
  const { startKeyboard } = await import('../src/core/keys.js');
  const ran = [];
  const commands = { list: () => [{ name: 'step_next', keys: ['.'] }, { name: 'toggle_play', keys: [' '] }], run: (n) => ran.push(n) };
  const listeners = [];
  const target = { addEventListener: (t, fn) => listeners.push(fn), removeEventListener() {} };
  startKeyboard(commands, { target });
  const press = (key, el) => listeners[0]({ key, target: el, preventDefault() {} });
  const box = { tagName: 'INPUT', type: 'checkbox', closest: (sel) => (sel.includes('checkbox') ? box : null) };
  const text = { tagName: 'INPUT', type: 'text', closest: () => null, blur() {} };
  press('.', box);
  press(' ', box);
  press('.', text);
  assert.deepEqual(ran, ['step_next']);
});

test('url coordinates: readable, exact round trip at 5 decimals, old degree links still work', () => {
  assert.equal(raToUrl(269.44627), '17h57m47.105s');
  assert.equal(decToUrl(4.7682), '4d46m05.52s');
  assert.equal(decToUrl(-29.0078), '-29d00m28.08s');
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  for (let i = 0; i < 20000; i++) {
    const ra = r5(Math.random() * 360);
    const dec = r5(Math.random() * 180 - 90);
    assert.equal(r5(raFromUrl(raToUrl(ra))) % 360, ra, `ra ${ra} -> ${raToUrl(ra)}`);
    assert.equal(r5(decFromUrl(decToUrl(dec))), dec, `dec ${dec} -> ${decToUrl(dec)}`);
  }
  assert.equal(raFromUrl('269.44627'), 269.44627);
  assert.equal(decFromUrl(' 4d46m05.52s'), decFromUrl('+4d46m05.52s')); // a '+' arrives as a space
  assert.equal(parseQuery('?ra=133.7951&dec=-7.2451').patch.ra, 133.7951);
  assert.ok(Number.isNaN(raFromUrl('nonsense')));
});
