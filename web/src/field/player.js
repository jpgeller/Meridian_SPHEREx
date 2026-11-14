// Time-lapse player: the SPHEREx frames of the current patch, in date order, plus the
// date operations (blink, add, subtract). Two stages:
//   1. sequence  – which images make up the time-lapse (built in sequence.js; Step 8 adds band modes)
//   2. operation – state.op: none (time-lapse) | blink | add | subtract, on dates chosen in state.t
// Every control is a command, so keyboard, gaze and the guide drive it the same way.
import { loadFrameList, bandsWithData } from './frames.js';
import { buildSequence, sequenceKey } from './sequence.js';
import { drawFrame, drawRGB, sharedStretch, rgbStretches } from './render.js';
import { addFrames, differenceSignificance, pickPair, pickForAdd } from './compare.js';

const SPEEDS = [1, 2, 4, 6, 10]; // frames per second
const BLINK_HZ = 2;
const DIFF_RANGE_SIGMA = 5; // difference images span ±5σ
const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const shortDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : '—';

export function createPlayer(stage, { store, commands }) {
  stage.innerHTML = `
    <div class="player">
      <div class="player-view">
        <div class="canvas-wrap">
          <canvas id="frame-canvas" role="img" aria-label="No frame loaded"></canvas>
          <svg class="target-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="4.5"/></svg>
        </div>
        <p id="player-msg" class="player-msg" role="status" aria-live="polite"></p>
      </div>
      <div class="player-bar" role="group" aria-label="Compare dates">
        <button type="button" data-op="none">Time-lapse <kbd>t</kbd></button>
        <button type="button" data-op="blink">Blink <kbd>b</kbd></button>
        <button type="button" data-op="add">Add <kbd>m</kbd></button>
        <button type="button" data-op="subtract">Difference <kbd>d</kbd></button>
        <span class="muted hint" id="op-hint"></span>
      </div>
      <div class="epochs" id="epochs" role="group" aria-label="Dates (select two to compare)"></div>
      <div class="player-bar">
        <button type="button" id="p-prev" aria-label="Previous frame">◀︎ <kbd>,</kbd></button>
        <button type="button" id="p-play" aria-label="Play">Play <kbd>Space</kbd></button>
        <button type="button" id="p-next" aria-label="Next frame"><kbd>.</kbd> ▶︎</button>
        <input type="range" id="p-scrub" min="0" max="0" value="0" aria-label="Frame" />
        <label class="inline">Speed
          <select id="p-speed">${SPEEDS.map((s) => `<option value="${s}" ${s === 2 ? 'selected' : ''}>${s} fps</option>`).join('')}</select>
        </label>
        <label class="inline"><input type="checkbox" id="p-visit" /> One per visit</label>
        <label class="inline">Colours
          <select id="p-cmap"><option value="grey">Grey</option><option value="inferno">Inferno</option></select>
        </label>
        <label class="inline"><input type="checkbox" id="p-ring" checked /> Mark target</label>
      </div>
      <p id="player-caption" class="player-caption"></p>
    </div>`;

  const $ = (s) => stage.querySelector(s);
  const canvas = $('#frame-canvas');
  const msg = $('#player-msg');
  const caption = $('#player-caption');
  const scrub = $('#p-scrub');
  const ring = stage.querySelector('.target-ring');
  const epochsEl = $('#epochs');

  const local = { speed: 2, perVisit: false, colormap: 'grey' };
  let seq = []; // the images of the current sequence (aligned frames)
  let stretch = null; // grey: one stretch; colour: three (one per channel)
  let kind = 'grey';
  let note = '';
  let loadToken = 0;
  let loadedKey = '';
  let playTimer = null;
  let blinkTimer = null;
  let blinkPhase = 0;
  const derived = new Map(); // memoised add/subtract results for the current sequence
  let shownFrame = null; // what is on the canvas now (for overlays)
  const showListeners = [];

  // --- controls -> commands --------------------------------------------------------
  $('#p-prev').addEventListener('click', () => commands.run('step_prev', {}, 'ui'));
  $('#p-next').addEventListener('click', () => commands.run('step_next', {}, 'ui'));
  $('#p-play').addEventListener('click', () => commands.run('toggle_play', {}, 'ui'));
  stage.querySelectorAll('[data-op]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_op', { op: b.dataset.op }, 'ui')),
  );
  scrub.addEventListener('input', () => store.set({ frameIndex: Number(scrub.value), playing: false }, 'ui'));
  $('#p-speed').addEventListener('change', (e) => {
    local.speed = Number(e.target.value);
    syncTimers(store.get());
  });
  $('#p-visit').addEventListener('change', (e) => {
    local.perVisit = e.target.checked;
    reload(store.get(), { force: true });
  });
  $('#p-cmap').addEventListener('change', (e) => {
    local.colormap = e.target.value;
    show(store.get());
  });
  $('#p-ring').addEventListener('change', (e) => (ring.style.display = e.target.checked ? '' : 'none'));

  function setMessage(text, actions = []) {
    msg.textContent = text;
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', a.run);
      msg.append(' ', b);
    }
  }

  // --- stage 1: build the sequence ---------------------------------------------------
  async function reload(s, { force = false } = {}) {
    const key = sequenceKey(s, local);
    if (key === loadedKey && !force) return;
    const firstLoad = loadedKey === '';
    loadedKey = key;
    const token = ++loadToken;
    const stale = () => token !== loadToken;
    seq = [];
    stretch = null;
    derived.clear();
    clearCanvas();
    setMessage('Finding SPHEREx images of this patch…');
    try {
      const list = await loadFrameList(s.ra, s.dec);
      if (stale()) return;
      const result = await buildSequence(list, s, local, {
        stale,
        progress: (done, total) => setMessage(`Loading ${total} image${total > 1 ? 's' : ''}… ${done}/${total}`),
      });
      if (stale()) return;
      if (!result.items.length) {
        const near = bandsWithData(list, s.band).slice(0, 3);
        setMessage(
          list.frames.length ? result.emptyMessage : 'SPHEREx has no images of this spot yet.',
          near.map((b) => ({ label: `Band ${b}`, run: () => commands.run('set_band', { band: b }, 'ui') })),
        );
        render(store.get());
        return;
      }
      seq = result.items;
      kind = result.kind ?? 'grey';
      note = result.failed ? ` · ${result.failed} image${result.failed > 1 ? 's' : ''} could not be loaded` : '';
      stretch = kind === 'rgb' ? rgbStretches(seq) : sharedStretch(seq);
      setMessage('');
      const st = store.get();
      const patch = {};
      if (st.frameIndex >= seq.length) patch.frameIndex = 0;
      // Selected dates belong to a sequence; keep them only for the first load (they may come from the URL).
      if (!firstLoad || st.t.some((i) => i >= seq.length)) patch.t = [];
      if (Object.keys(patch).length) store.set(patch, 'player');
      renderEpochs(store.get());
      render(store.get());
    } catch (err) {
      if (stale()) return;
      loadedKey = '';
      console.error('[player]', err); // details for developers; the screen gets a short message
      setMessage('Could not load the images (the SPHEREx archive may be busy).', [
        { label: 'Retry', run: () => reload(store.get(), { force: true }) },
      ]);
    }
  }

  // --- stage 2: what to draw for the current operation ------------------------------
  function current(s) {
    const n = seq.length;
    const i = ((s.frameIndex % n) + n) % n;
    if (s.op === 'blink' && n >= 2) {
      const [a, b] = pickPair(seq, s.t);
      const k = blinkPhase ? b : a;
      return { frame: seq[k], stretch, cmap: local.colormap, label: `Blink: ${blinkPhase ? 'B' : 'A'} · `, index: k };
    }
    if (s.op === 'add' && n >= 2) {
      const idx = pickForAdd(seq, s.t);
      const key = `add:${idx.join(',')}`;
      if (!derived.has(key)) {
        if (kind === 'rgb') {
          const channels = [0, 1, 2].map((c) => {
            const fs = idx.map((j) => seq[j].rgb[c]).filter(Boolean);
            return fs.length ? addFrames(fs) : null;
          });
          const sum = { ...seq[idx[0]], id: `add:${key}`, rgb: channels, meta: { ...seq[idx[0]].meta, date_end_iso: seq[idx.at(-1)].meta.date_end_iso } };
          derived.set(key, { frame: sum, stretch: rgbStretches([sum]) });
        } else {
          const sum = addFrames(idx.map((j) => seq[j]));
          derived.set(key, { frame: sum, stretch: sharedStretch([sum]) });
        }
      }
      const d = derived.get(key);
      return { ...d, cmap: local.colormap, label: `Added ${idx.length} dates · `, index: null };
    }
    if (s.op === 'subtract' && n >= 2 && kind !== 'rgb') {
      const [a, b] = pickPair(seq, s.t);
      const key = `sub:${a},${b}`;
      if (!derived.has(key)) {
        // later minus earlier: new/brighter = positive; offset removed, in units of noise
        // brightness-matched, in units of noise + 15% of local brightness (see compare.js)
        const diff = differenceSignificance(seq[a], seq[b]);
        derived.set(key, {
          frame: diff,
          stretch: { vmin: -DIFF_RANGE_SIGMA, vmax: DIFF_RANGE_SIGMA, kind: 'linear' },
          pair: [a, b],
        });
      }
      const d = derived.get(key);
      return { ...d, cmap: 'diverging', label: '', index: null };
    }
    return { frame: seq[i], stretch, cmap: local.colormap, label: '', index: i };
  }

  function describe(s, view) {
    const m = view.frame.meta;
    if (s.op === 'subtract' && view.pair) {
      const [a, b] = view.pair;
      return (
        `Difference: ${fmtDate(seq[b].meta.date_iso)} minus ${fmtDate(seq[a].meta.date_iso)}, brightness-matched, ±${DIFF_RANGE_SIGMA}σ ` +
        '(noise plus 15% of each star’s brightness, so small blur differences are ignored). ' +
        'Orange = brighter on the later date, blue = brighter on the earlier date. A moving object shows as a blue–orange pair.'
      );
    }
    const when = m.n_combined
      ? `${fmtDate(m.date_iso)} – ${fmtDate(m.date_end_iso)} (${m.n_combined} images)`
      : fmtDate(m.date_iso);
    const pos0 = view.index != null ? `Frame ${view.index + 1} of ${seq.length} · ` : '';
    if (m.mode === 'rgb') {
      const ch = (m.channels ?? []).map((c, k) => `${['red', 'green', 'blue'][k]} = ${c.label}${c.present ? '' : ' (no image this visit)'}`);
      const subNote = s.op === 'subtract' ? ' · Difference works on single-colour views; showing the colour image.' : '';
      return `${view.label}${pos0}${when} · Colour mix: ${ch.join(', ')}${subNote}`;
    }
    if (m.mode === 'custom') return `${view.label}${pos0}${when} · Formula: ${m.formula}`;
    if (m.mode === 'detector' && Number.isFinite(m.wl_min)) {
      return `${view.label}${pos0}${when} · Detector D${m.detector} summed, ${m.wl_min.toFixed(2)}–${m.wl_max.toFixed(2)} µm`;
    }
    const sat = m.saturated_px ? ` · ${m.saturated_px} saturated px` : '';
    const pos = view.index != null ? `Frame ${view.index + 1} of ${seq.length} · ` : '';
    const det = m.detector ? `detector D${m.detector} · ` : '';
    const wl = Number.isFinite(m.wavelength_um) ? `${m.wavelength_um.toFixed(3)} µm · ` : '';
    return `${view.label}${pos}${when} · ${det}${wl}${m.bad_pct ?? 0}% pixels masked${sat}`;
  }

  // --- drawing ---------------------------------------------------------------------
  function clearCanvas() {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    canvas.setAttribute('aria-label', 'No frame loaded');
    caption.textContent = '';
    epochsEl.innerHTML = '';
  }

  function show(s) {
    if (!seq.length || !stretch) return;
    const view = current(s);
    if (view.frame.rgb) drawRGB(canvas, view.frame, view.stretch);
    else drawFrame(canvas, view.frame, view.stretch, view.cmap);
    shownFrame = view.frame;
    const text = describe(s, view);
    caption.textContent = text + note;
    canvas.setAttribute('aria-label', `SPHEREx image. ${text}`);
    const n = seq.length;
    const i = ((s.frameIndex % n) + n) % n;
    scrub.max = String(n - 1);
    scrub.value = String(i);
    scrub.setAttribute('aria-valuetext', `Frame ${i + 1} of ${n}, ${fmtDate(seq[i].meta.date_iso)}`);
    epochsEl.querySelectorAll('[data-epoch]').forEach((b) =>
      b.classList.toggle('current', Number(b.dataset.epoch) === (view.index ?? -1)),
    );
    for (const fn of showListeners) fn(view);
  }

  function renderEpochs(s) {
    epochsEl.innerHTML = seq
      .map((f, i) => {
        const m = f.meta;
        const label = m.n_combined ? `${shortDate(m.date_iso)} (${m.n_combined})` : shortDate(m.date_iso);
        return `<button type="button" class="epoch" data-epoch="${i}" aria-pressed="${s.t.includes(i)}">${label}</button>`;
      })
      .join('');
    epochsEl.querySelectorAll('[data-epoch]').forEach((b) =>
      b.addEventListener('click', () => commands.run('toggle_epoch', { index: Number(b.dataset.epoch) }, 'ui')),
    );
  }

  function render(s) {
    const playBtn = $('#p-play');
    playBtn.firstChild.textContent = s.playing ? 'Pause ' : 'Play ';
    playBtn.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    const many = seq.length > 1;
    const timelapse = s.op === 'none';
    for (const id of ['#p-prev', '#p-play', '#p-next']) $(id).disabled = !many || !timelapse;
    scrub.disabled = !many || !timelapse;
    stage.querySelectorAll('[data-op]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.op === s.op));
      b.disabled = (b.dataset.op !== 'none' && !many) || (b.dataset.op === 'subtract' && kind === 'rgb');
    });
    $('#p-visit').disabled = s.mode !== 'single'; // other modes are already one per visit
    $('#op-hint').textContent =
      s.op === 'none' ? '' : s.op === 'add' ? 'Select 2+ dates below, or all are added.' : 'Select two dates below, or the first and last are used.';
    epochsEl.querySelectorAll('[data-epoch]').forEach((b) =>
      b.setAttribute('aria-pressed', String(s.t.includes(Number(b.dataset.epoch)))),
    );
    if (seq.length && s.frameIndex >= seq.length) {
      store.set({ frameIndex: s.frameIndex % seq.length }, 'player');
      return;
    }
    show(s);
    syncTimers(s);
  }

  function syncTimers(s) {
    clearInterval(playTimer);
    playTimer = null;
    const active = s.view === 'field' && seq.length > 1;
    if (active && s.playing && s.op === 'none') {
      playTimer = setInterval(() => {
        store.set({ frameIndex: (store.get().frameIndex + 1) % seq.length }, 'player');
      }, 1000 / local.speed);
    }
    const wantBlink = active && s.op === 'blink';
    if (wantBlink && !blinkTimer) {
      blinkTimer = setInterval(() => {
        blinkPhase ^= 1;
        show(store.get());
      }, 1000 / BLINK_HZ);
    } else if (!wantBlink && blinkTimer) {
      clearInterval(blinkTimer);
      blinkTimer = null;
      blinkPhase = 0;
    }
  }

  // --- state -> player ------------------------------------------------------------
  let reloadTimer = null;
  store.subscribe((s, changed) => {
    if (s.view !== 'field') {
      syncTimers(s);
      return;
    }
    if (['ra', 'dec', 'ffov', 'band', 'view', 'mode', 'rgb', 'formula'].some((k) => changed.includes(k))) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => reload(store.get()), 250); // panning/band scrubbing: wait until settled
    }
    if (changed.includes('t')) derived.clear();
    render(s);
  });
  if (store.get().view === 'field') reload(store.get());

  return {
    getSequence: () => seq,
    getStretch: () => stretch,
    getShownFrame: () => shownFrame,
    onShow: (fn) => showListeners.push(fn),
    elements: {
      view: stage.querySelector('.player-view'),
      canvasWrap: stage.querySelector('.canvas-wrap'),
      canvas,
      bar: stage.querySelectorAll('.player-bar')[1],
    },
  };
}
