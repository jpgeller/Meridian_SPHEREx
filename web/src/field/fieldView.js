// The 2D field view: a panel over the sky (which stays mounted underneath). Step 3 is the
// shell: position, size control, open/close and focus handling. The player (Step 6),
// compare modes (7), band tools (8), context (9) and spectra (10) render into #field-stage.
import { FIELD_FOVS } from '../core/state.js';
import { detectorOf } from '../core/bands.js';

const fmt = (v, d) => Number(v).toFixed(d);

function sexagesimal(ra, dec) {
  const h = ra / 15;
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = ((h - hh) * 60 - mm) * 60;
  const sign = dec < 0 ? '−' : '+';
  const d = Math.abs(dec);
  const dd = Math.floor(d), dm = Math.floor((d - dd) * 60), ds = ((d - dd) * 60 - dm) * 60;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(hh)}h${p(mm)}m${ss.toFixed(1).padStart(4, '0')}s ${sign}${p(dd)}°${p(dm)}′${ds.toFixed(0).padStart(2, '0')}″`;
}

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
          <button type="button" id="field-band-prev" aria-label="Previous band"><kbd>[</kbd> Shorter λ</button>
          <span id="field-band" class="band-readout"></span>
          <button type="button" id="field-band-next" aria-label="Next band">Longer λ <kbd>]</kbd></button>
        </div>
        <p class="muted hint">Wider fields catch faster-moving objects but load more slowly. <kbd>+</kbd>/<kbd>−</kbd> change the size.</p>
      </div>
      <div id="field-stage" class="field-stage"></div>
    </section>`;

  const panel = root.querySelector('#field');
  const title = root.querySelector('#field-title');
  root.querySelector('#field-close').addEventListener('click', () => commands.run('close_field', {}, 'ui'));
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
      `${sexagesimal(state.ra, state.dec)}  ·  RA ${fmt(state.ra, 4)}°, Dec ${fmt(state.dec, 4)}°  ·  ${state.ffov * 60}′ wide`;
    root.querySelectorAll('[data-ffov]').forEach((b) =>
      b.setAttribute('aria-checked', String(Number(b.dataset.ffov) === state.ffov)),
    );
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
  render(store.get());

  return { stage: root.querySelector('#field-stage') };
}
