// Minimal working controls. The final UI design is merged later; this panel only calls
// commands and reads state, so it can be restyled or replaced freely.
import { PRESETS } from '../sky/presets.js';
import { detectorOf, BAND_MIN, BAND_MAX } from '../core/bands.js';
import { COLOR_PRESETS, mixBands } from '../sky/colorViews.js';

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
        <button type="button" data-proj="SIN" title="The sky as a globe">3D sphere</button>
        <button type="button" data-proj="STG" title="As if standing inside the sky: shapes stay the same as they move">Planetarium</button>
        <button type="button" data-proj="AIT">Whole sky</button>
      </div>

      <label>Colours <span class="muted">(infrared has no real colour: these are translations)</span></label>
      <div class="row wrap" role="radiogroup" aria-label="Colour view">
        <button type="button" role="radio" data-color="grey" title="One band as brightness">Grey</button>
        <button type="button" role="radio" data-color="tint" title="One band, coloured like its detector on the ribbon">Tinted band</button>
        ${Object.entries(COLOR_PRESETS).map(([id, p]) => `<button type="button" role="radio" data-color="${id}" title="${p.note}">${p.label}</button>`).join('')}
        <button type="button" role="radio" data-color="custom" title="Pick three bands for red, green and blue">Your mix</button>
      </div>
      <form id="mix-form" class="row mix-form" hidden aria-label="Your colour mix">
        <label>R <input id="mix-r" type="number" min="1" max="101" /></label>
        <label>G <input id="mix-g" type="number" min="1" max="101" /></label>
        <label>B <input id="mix-b" type="number" min="1" max="101" /></label>
        <button type="submit">Apply</button>
      </form>
      <p id="color-note" class="muted color-note"></p>
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
  root.querySelectorAll('[data-color]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_color', { color: b.dataset.color }, 'ui')),
  );
  $('#mix-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const mix = ['#mix-r', '#mix-g', '#mix-b'].map((id) => Number($(id).value));
    commands.run('set_mix', { mix }, 'ui');
  });

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
    root.querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.color === state.color)));
    const mixed = mixBands(state);
    band.disabled = Boolean(mixed); // a colour mix uses its own three bands
    const mixForm = $('#mix-form');
    mixForm.hidden = state.color !== 'custom';
    ['#mix-r', '#mix-g', '#mix-b'].forEach((id, i) => {
      if (document.activeElement !== $(id)) $(id).value = String(state.mix[i]);
    });
    const wl2 = getWavelengths?.();
    const um = (b) => (wl2 ? `${wl2[b].toFixed(2)} µm` : `band ${b}`);
    $('#color-note').textContent = mixed
      ? `Red ${um(mixed[0])} · green ${um(mixed[1])} · blue ${um(mixed[2])}. The band slider is not used in colour mixes.`
      : state.color === 'tint'
        ? 'Each detector has its own tint (see the ribbon), so changing band changes the colour.'
        : 'Brightness of one band, no colour added.';
  }
  store.subscribe((state) => render(state));
  window.addEventListener('meridian:wavelengths', () => render(store.get()));
  render(store.get());
  return { render: () => render(store.get()) };
}
