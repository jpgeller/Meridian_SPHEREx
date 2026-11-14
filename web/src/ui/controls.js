// Minimal working controls. The final UI design is merged later; this panel only calls
// commands and reads state, so it can be restyled or replaced freely.
import { PRESETS } from '../sky/presets.js';
import { detectorOf, BAND_MIN, BAND_MAX } from '../core/bands.js';

const html = String.raw;

export function createControls(root, { store, commands, getWavelengths }) {
  root.innerHTML = html`
    <section class="panel" id="controls" aria-label="Sky controls">
      <h1 class="title">Meridian <span class="muted">· SPHEREx sky</span></h1>

      <form id="search" role="search">
        <label for="search-input">Go to a name or coordinates</label>
        <div class="row">
          <input id="search-input" type="text" autocomplete="off" spellcheck="false"
                 placeholder="Barnard's Star · 08h55m10.8s -07d14m42s" />
          <button type="submit">Go</button>
        </div>
      </form>

      <div class="row wrap" role="group" aria-label="Places">
        ${PRESETS.map((p) => `<button type="button" data-preset="${p.id}" title="${p.note}">${p.label}</button>`).join('')}
      </div>

      <label for="band">Infrared band <span id="band-label" class="muted"></span></label>
      <input id="band" type="range" min="${BAND_MIN}" max="${BAND_MAX}" step="1" />
      <div class="ribbon" aria-hidden="true"></div>

      <div class="row" role="group" aria-label="View type">
        <button type="button" data-proj="SIN">3D sphere</button>
        <button type="button" data-proj="AIT">Whole sky</button>
      </div>
    </section>`;

  const $ = (sel) => root.querySelector(sel);
  const input = $('#search-input');
  const band = $('#band');

  // --- user -> commands -----------------------------------------------------------
  $('#search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const target = input.value.trim();
    if (!target) return;
    const r = commands.run('fly_to', { target }, 'ui');
    try {
      await r.value;
      input.blur(); // hand the keyboard back to the sky (arrows, +/-, Enter)
    } catch {
      /* the status line shows the error via the meridian:command event */
    }
  });
  root.querySelectorAll('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => commands.run('go_preset', { id: b.dataset.preset }, 'ui')),
  );
  band.addEventListener('input', () => commands.run('set_band', { band: Number(band.value) }, 'ui'));
  root.querySelectorAll('[data-proj]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_projection', { proj: b.dataset.proj }, 'ui')),
  );
  commands.register('focus_search', () => input.focus(), { label: 'Search', keys: ['/'] });

  // --- state -> UI ------------------------------------------------------------------
  function render(state) {
    band.value = state.band;
    const { detector, channel } = detectorOf(state.band);
    const w = getWavelengths?.();
    const wl = w ? ` · ${w[state.band].toFixed(3)} µm` : '';
    $('#band-label').textContent = `${state.band} · D${detector} ch${channel}${wl}`;
    band.setAttribute('aria-valuetext', `Band ${state.band}, detector ${detector}${wl.replace(' · ', ', ')}`);
    root.querySelectorAll('[data-proj]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.proj === state.proj)),
    );
  }
  store.subscribe((state) => render(state));
  render(store.get());
  return { render: () => render(store.get()) };
}
