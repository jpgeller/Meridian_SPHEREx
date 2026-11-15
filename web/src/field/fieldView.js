// The 2D field view: a panel over the sky (which stays mounted underneath). Step 3 is the
// shell: position, size control, open/close and focus handling. The player (Step 6),
// compare modes (7), band tools (8), context (9) and spectra (10) render into #field-stage.
import { FIELD_FOVS } from '../core/state.js';
import { detectorOf, CHANNELS_PER_DETECTOR } from '../core/bands.js';
import { DETECTOR_COLOURS } from '../sky/colorViews.js';
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
        <div class="row field-size-row">
          <div role="radiogroup" aria-label="Field size (wider fields catch faster-moving objects but load more slowly; + and − keys)" class="row" id="field-sizes">
            ${FIELD_FOVS.map(
              (f) => `<button type="button" role="radio" data-ffov="${f}">${f < 1 ? `${f * 60}′` : `${f}°`}</button>`,
            ).join('')}
          </div>
        </div>
        <div class="row field-band-row">
          <div class="field-dets" role="radiogroup" aria-label="Wavelength range: detectors D1 (shortest) to D6 (longest)">
            ${[1, 2, 3, 4, 5, 6]
              .map(
                (d) => `<button type="button" role="radio" class="det" data-fdet="${d}" style="--det: ${DETECTOR_COLOURS[d - 1]}">
                  <span class="det-name"><span class="sr-only">Detector </span>D${d}</span><span class="det-range" data-frange="${d}"></span></button>`,
              )
              .join('')}
          </div>
          <button type="button" id="band-more-toggle" class="band-more-toggle" aria-expanded="false" aria-controls="band-more">More bands</button>
        </div>
        <div class="row wrap" id="band-more" hidden role="group" aria-label="More band options">
          <button type="button" id="field-band-prev" aria-keyshortcuts="["><kbd>[</kbd> Previous band</button>
          <span id="field-band" class="band-readout"></span>
          <button type="button" id="field-band-next" aria-keyshortcuts="]">Next band <kbd>]</kbd></button>
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
  root.querySelectorAll('[data-fdet]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_detector', { detector: Number(b.dataset.fdet) }, 'ui')),
  );
  // the 102 single bands, colour mixes and formulas: folded away (most people only need D1–D6)
  const more = root.querySelector('#band-more');
  const moreToggle = root.querySelector('#band-more-toggle');
  moreToggle.addEventListener('click', () => {
    more.hidden = !more.hidden;
    moreToggle.setAttribute('aria-expanded', String(!more.hidden));
    moreToggle.textContent = more.hidden ? 'More bands' : 'Fewer bands';
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
    root.querySelectorAll('[data-fdet]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.fdet) === detector)));
    root.querySelectorAll('[data-frange]').forEach((el) => {
      const d = Number(el.dataset.frange);
      const lo = w?.[(d - 1) * CHANNELS_PER_DETECTOR];
      const hi = w?.[d * CHANNELS_PER_DETECTOR - 1];
      el.textContent = lo && hi ? `${lo.toFixed(2)}–${hi.toFixed(2)} µm` : '';
    });
    // a colour mix or formula is chosen in "More band options": keep it open while one is on
    if (state.mode === 'rgb' || state.mode === 'custom') {
      root.querySelector('#band-more').hidden = false;
      root.querySelector('#band-more-toggle').setAttribute('aria-expanded', 'true');
      root.querySelector('#band-more-toggle').textContent = 'Fewer bands';
    }
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
