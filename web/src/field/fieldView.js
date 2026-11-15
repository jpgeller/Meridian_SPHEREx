// The 2D field view: a panel over the sky (which stays mounted underneath). Step 3 is the
// shell: position, size control, open/close and focus handling. The player (Step 6),
// compare modes (7), band tools (8), context (9) and spectra (10) render into #field-stage.
import { FIELD_FOVS } from '../core/state.js';
import { detectorOf } from '../core/bands.js';
import { formatSexagesimal } from '../core/coords.js';

const fmt = (v, d) => Number(v).toFixed(d);

export function createFieldView(root, { store, commands, getWavelengths = () => null }) {
  root.innerHTML = `
    <section id="field" class="field" role="dialog" aria-modal="false" aria-labelledby="field-title" hidden>
      <header class="field-head">
        <h2 id="field-title" tabindex="-1">Time-lapse</h2>
        <p id="field-pos" class="muted"></p>
        <button type="button" id="field-close" class="field-close">Back to sky <kbd>Esc</kbd></button>
      </header>
      <div class="field-controls">
        <div role="radiogroup" aria-label="Field size" class="row wrap" id="field-sizes">
          ${FIELD_FOVS.map(
            (f) => `<button type="button" role="radio" data-ffov="${f}">${f < 1 ? `${f * 60}′` : `${f}°`}</button>`,
          ).join('')}
        </div>
        <div class="row wrap" role="group" aria-label="Infrared band">
          <button type="button" id="field-band-prev" aria-label="Shorter λ: previous band" aria-keyshortcuts="["><kbd>[</kbd> Shorter λ</button>
          <span id="field-band" class="band-readout"></span>
          <button type="button" id="field-band-next" aria-label="Longer λ: next band" aria-keyshortcuts="]">Longer λ <kbd>]</kbd></button>
          <span class="sep" aria-hidden="true"></span>
          <div role="radiogroup" aria-label="Band mode" class="row wrap" id="band-modes">
            <button type="button" role="radio" data-mode="single" title="One of the 102 bands">One band</button>
            <button type="button" role="radio" data-mode="detector" title="All 17 bands of this detector added: deeper">Whole detector</button>
            <button type="button" role="radio" data-mode="rgb" title="Three bands or detectors as red, green, blue">Colour mix</button>
            <button type="button" role="radio" data-mode="custom" title="Your own combination, e.g. D6 - D1">Formula</button>
          </div>
        </div>
        <form class="row wrap mode-extra" id="rgb-form" hidden aria-label="Colour mix channels">
          <label>Red <input id="rgb-r" size="4" /></label>
          <label>Green <input id="rgb-g" size="4" /></label>
          <label>Blue <input id="rgb-b" size="4" /></label>
          <button type="submit">Apply</button>
          <span class="muted hint">Detectors D1–D6 or bands 1–101 · e.g. D6, D4, D2</span>
        </form>
        <form class="row wrap mode-extra" id="formula-form" hidden aria-label="Band formula">
          <label for="formula-input">Formula</label>
          <input id="formula-input" size="22" placeholder="D6 - D1" spellcheck="false" autocomplete="off" />
          <button type="submit">Apply</button>
          <span class="muted hint">Use b1–b101, D1–D6, numbers, + − × ÷ and brackets</span>
        </form>
        <p class="muted hint">Wider fields catch faster-moving objects but load more slowly. <kbd>+</kbd>/<kbd>−</kbd> change the size.</p>
      </div>
      <div id="field-stage" class="field-stage"></div>
    </section>`;

  const panel = root.querySelector('#field');
  const title = root.querySelector('#field-title');
  root.querySelector('#field-close').addEventListener('click', () => commands.run('close_field', {}, 'ui'));
  root.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_mode', { mode: b.dataset.mode }, 'ui')),
  );
  root.querySelector('#rgb-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = (id) => {
      const v = root.querySelector(id).value.trim();
      return /^[dD][1-6]$/.test(v) ? v.toUpperCase() : Number(v);
    };
    commands.run('set_mode', { mode: 'rgb', rgb: ['#rgb-r', '#rgb-g', '#rgb-b'].map(val) }, 'ui');
  });
  root.querySelector('#formula-form').addEventListener('submit', (e) => {
    e.preventDefault();
    commands.run('set_mode', { mode: 'custom', formula: root.querySelector('#formula-input').value.trim() }, 'ui');
  });
  root.querySelector('#field-band-prev').addEventListener('click', () => commands.run('prev_band', {}, 'ui'));
  root.querySelector('#field-band-next').addEventListener('click', () => commands.run('next_band', {}, 'ui'));
  root.querySelectorAll('[data-ffov]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_field_fov', { fov: Number(b.dataset.ffov) }, 'ui')),
  );

  let wasOpen = false;
  function render(state) {
    const open = state.view === 'field';
    panel.hidden = !open;
    document.body.classList.toggle('field-open', open);
    root.querySelector('#field-pos').textContent =
      `${formatSexagesimal(state.ra, state.dec)}  ·  RA ${fmt(state.ra, 4)}°, Dec ${fmt(state.dec, 4)}°  ·  ${state.ffov * 60}′ wide`;
    root.querySelectorAll('[data-ffov]').forEach((b) =>
      b.setAttribute('aria-checked', String(Number(b.dataset.ffov) === state.ffov)),
    );
    root.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));
    const rgbForm = root.querySelector('#rgb-form');
    const fForm = root.querySelector('#formula-form');
    rgbForm.hidden = state.mode !== 'rgb';
    fForm.hidden = state.mode !== 'custom';
    ['#rgb-r', '#rgb-g', '#rgb-b'].forEach((id, k) => {
      const el = root.querySelector(id);
      if (document.activeElement !== el) el.value = String(state.rgb[k]);
    });
    const fi = root.querySelector('#formula-input');
    if (document.activeElement !== fi && state.formula) fi.value = state.formula;
    const { detector, channel } = detectorOf(state.band);
    const w = getWavelengths();
    root.querySelector('#field-band').textContent =
      `Band ${state.band} · D${detector} ch${channel}${w ? ` · ${w[state.band].toFixed(3)} µm` : ''}`;
    // Focus: into the panel when it opens, back to the page when it closes,
    // so keyboard and screen-reader users always know where they are.
    if (open && !wasOpen) title.focus();
    if (!open && wasOpen && panel.contains(document.activeElement)) document.activeElement.blur();
    wasOpen = open;
  }
  store.subscribe(render);
  window.addEventListener('meridian:wavelengths', () => render(store.get()));
  render(store.get());

  return { stage: root.querySelector('#field-stage') };
}
