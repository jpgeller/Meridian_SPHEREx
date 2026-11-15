// Sky controls, laid out in the shell's regions (ui/shell.js). Every control only calls a
// command and reads state, so the look can change without touching the logic.
import { PRESETS } from '../sky/presets.js';
import { detectorOf, BAND_MIN, BAND_MAX, DETECTORS, CHANNELS_PER_DETECTOR } from '../core/bands.js';
import { COLOR_PRESETS, DETECTOR_COLOURS, mixBands } from '../sky/colorViews.js';
import { createShell } from './shell.js';
import { createFacePanel } from './facePanel.js';
import { createReadout } from './readout.js';

const html = String.raw;
const DETECTOR_IDS = Array.from({ length: DETECTORS }, (_, i) => i + 1);
// Middle channel of a detector (never one of the blank frames 0, 50, 51).
const middleBand = (d) => (d - 1) * CHANNELS_PER_DETECTOR + Math.floor(CHANNELS_PER_DETECTOR / 2);

export function createControls(root, { store, commands, getWavelengths }) {
  const shell = createShell(root);

  shell.top.innerHTML = html`
    <h1 class="title">Meridian <span class="muted">· SPHEREx sky</span></h1>
    <form id="search" role="search" data-guide="search">
      <label for="search-input" class="sr-only">Go to a name or coordinates</label>
      <input id="search-input" type="text" autocomplete="off" spellcheck="false"
             placeholder="Barnard's Star · 08h55m10.8s -07d14m42s" />
      <button type="submit">Go</button>
    </form>`;

  shell.toggle.innerHTML = html`
    <button type="button" id="panel-toggle" class="panel-toggle" aria-expanded="true" aria-controls="side-panel"
            data-guide="panel-toggle" aria-keyshortcuts="p" title="Show or hide the controls (key P)">
      <span class="pt-icon" aria-hidden="true"></span><span class="pt-text">Controls</span>
    </button>`;

  shell.left.innerHTML = html`
    <div id="face-slot" data-guide="face-panel" hidden></div>
    <section class="card" data-guide="presets">
      <h2 class="card-title">Places</h2>
      <div class="grid-4 preset-grid" role="group" aria-label="Places">
        ${PRESETS.map((p) => `<button type="button" class="big" data-preset="${p.id}" title="${p.note}">${p.label}</button>`).join('')}
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">View</h2>
      <div class="grid-2" role="group" aria-label="View type">
        <button type="button" class="big" data-proj="SIN" title="The sky as a globe">3D sphere</button>
        <button type="button" class="big" data-proj="STG" title="As if standing inside the sky: shapes stay the same as they move">Planetarium</button>
      </div>
    </section>

    <section class="card" data-guide="colour-views">
      <h2 class="card-title">Colours <span class="muted">· infrared translated</span></h2>
      <div class="grid-3" role="radiogroup" aria-label="Colour view">
        <button type="button" class="big" role="radio" data-color="grey" title="One band as brightness">Grey</button>
        <button type="button" class="big" role="radio" data-color="tint" title="One band, coloured like its detector on the ribbon">Tinted band</button>
        ${Object.entries(COLOR_PRESETS).map(([id, p]) => `<button type="button" class="big" role="radio" data-color="${id}" title="${p.note}">${p.label}</button>`).join('')}
        <button type="button" class="big" role="radio" data-color="custom" title="Pick three bands for red, green and blue">Your mix</button>
      </div>
      <form id="mix-form" class="row mix-form" hidden aria-label="Your colour mix">
        <label>R <input id="mix-r" type="number" min="1" max="101" /></label>
        <label>G <input id="mix-g" type="number" min="1" max="101" /></label>
        <label>B <input id="mix-b" type="number" min="1" max="101" /></label>
        <button type="submit">Apply</button>
      </form>
      <p id="color-note" class="note"></p>
    </section>`;

  createReadout(shell.readout, { store });
  // folded by default so the side panel fits without scrolling (scrolling is hard with gaze); one look opens it
  createFacePanel(root.querySelector('#face-slot'), { commands, open: false });

  shell.dock.innerHTML = html`
    <div class="dock-head">
      <label for="band">Infrared band</label>
      <span id="band-label" class="muted"></span>
    </div>
    <div class="ribbon" role="group" aria-label="Detectors, short to long wavelength" data-guide="band-ribbon">
      ${DETECTOR_IDS.map(
        (d) => html`<button type="button" class="det" data-detector="${d}" data-guide="band-d${d}"
            style="--det: ${DETECTOR_COLOURS[d - 1]}">
            <span class="det-name"><span class="sr-only">Detector </span>D${d}</span>
            <span class="det-range" data-range="${d}"></span>
            <span class="det-ticks" aria-hidden="true">${'<i></i>'.repeat(CHANNELS_PER_DETECTOR)}</span>
          </button>`,
      ).join('')}
    </div>
    <input id="band" type="range" min="${BAND_MIN}" max="${BAND_MAX}" step="1" />`;

  const $ = (sel) => root.querySelector(sel);
  const input = $('#search-input');
  const band = $('#band');
  let panelOpen = true; // layout only, not view state: it stays out of the store and the URL

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
  root.querySelectorAll('[data-detector]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_band', { band: middleBand(Number(b.dataset.detector)) }, 'ui')),
  );
  root.querySelectorAll('[data-proj]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_projection', { proj: b.dataset.proj }, 'ui')),
  );
  commands.register('focus_search', () => input.focus(), { label: 'Search', keys: ['/'] });
  commands.register(
    'toggle_panel',
    ({ open } = {}) => {
      panelOpen = typeof open === 'boolean' ? open : !panelOpen;
      renderPanel();
      return panelOpen;
    },
    { label: 'Show / hide the controls panel', keys: ['p'], args: { open: 'optional, true or false' } },
  );
  $('#panel-toggle').addEventListener('click', () => commands.run('toggle_panel', {}, 'ui'));
  root.querySelectorAll('[data-color]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_color', { color: b.dataset.color }, 'ui')),
  );
  root.querySelectorAll('[data-cmd]').forEach((b) =>
    b.addEventListener('click', () => commands.run(b.dataset.cmd, {}, 'ui')),
  );
  $('#mix-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const mix = ['#mix-r', '#mix-g', '#mix-b'].map((id) => Number($(id).value));
    commands.run('set_mix', { mix }, 'ui');
  });

  // --- state -> UI ------------------------------------------------------------------
  function renderPanel() {
    $('#panel-toggle').setAttribute('aria-expanded', String(panelOpen));
    $('#side-panel').hidden = !panelOpen;
    document.body.classList.toggle('panel-closed', !panelOpen);
  }

  function renderRibbon(state, w) {
    const { detector, channel } = detectorOf(state.band);
    root.querySelectorAll('[data-detector]').forEach((b) => {
      const d = Number(b.dataset.detector);
      const on = d === detector;
      b.setAttribute('aria-pressed', String(on));
      b.querySelectorAll('.det-ticks i').forEach((t, i) => t.classList.toggle('on', on && i === channel - 1));
    });
    root.querySelectorAll('[data-range]').forEach((el) => {
      const d = Number(el.dataset.range);
      const lo = w?.[(d - 1) * CHANNELS_PER_DETECTOR];
      const hi = w?.[d * CHANNELS_PER_DETECTOR - 1];
      // the visible text is the button's name ("Detector" is screen-reader only), so the name
      // always contains what is on screen (WCAG 2.5.3, and gaze/voice users say what they see)
      el.textContent = lo && hi ? `${lo.toFixed(2)}–${hi.toFixed(2)} µm` : '';
    });
  }

  function render(state) {
    band.value = state.band;
    const { detector, channel } = detectorOf(state.band);
    const w = getWavelengths?.();
    const wl = w ? ` · ${w[state.band].toFixed(3)} µm` : '';
    $('#band-label').textContent = `${state.band} · D${detector} ch${channel}${wl}`;
    band.setAttribute('aria-valuetext', `Band ${state.band}, detector ${detector}${wl.replace(' · ', ', ')}`);
    renderRibbon(state, w);
    root.querySelectorAll('[data-proj]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.proj === state.proj)),
    );
    root.querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.color === state.color)));
    const mixed = mixBands(state);
    const mixForm = $('#mix-form');
    mixForm.hidden = state.color !== 'custom';
    ['#mix-r', '#mix-g', '#mix-b'].forEach((id, i) => {
      if (document.activeElement !== $(id)) $(id).value = String(state.mix[i]);
    });
    const um = (b) => (w ? `${w[b].toFixed(2)} µm` : `band ${b}`);
    $('#color-note').hidden = !mixed; // only the mix needs explaining; the panel stays short enough for gaze
    $('#color-note').textContent = mixed
      ? `Red ${um(mixed[0])} · green ${um(mixed[1])} · blue ${um(mixed[2])}. Moving the band slider leaves the mix and shows that band.`
      : state.color === 'tint'
        ? 'Each detector has its own tint (see the ribbon), so changing band changes the colour.'
        : 'Brightness of one band, no colour added.';
  }
  store.subscribe((state) => render(state));
  window.addEventListener('meridian:wavelengths', () => render(store.get()));
  render(store.get());
  renderPanel();
  return { render: () => render(store.get()) };
}
