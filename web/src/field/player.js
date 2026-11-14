// Time-lapse player: the SPHEREx frames of the current patch and band, in date order.
// Reads position/size/band/frameIndex/playing from the store; user actions are commands
// (play, pause, step_next, step_prev, set_band) so keyboard, gaze and the guide all work.
import { loadFrameList, framesForBand, bandsWithData, loadCutout, medianStack } from './frames.js';
import { drawFrame, sharedStretch } from './render.js';

const SPEEDS = [1, 2, 4, 6, 10]; // frames per second
const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

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

  const local = { speed: 2, perVisit: false, colormap: 'grey' };
  let seq = []; // loaded frames for the current key
  let stretch = null;
  let loadToken = 0;
  let loadedKey = '';
  let timer = null;

  // --- controls -> commands --------------------------------------------------------
  $('#p-prev').addEventListener('click', () => commands.run('step_prev', {}, 'ui'));
  $('#p-next').addEventListener('click', () => commands.run('step_next', {}, 'ui'));
  $('#p-play').addEventListener('click', () => commands.run('toggle_play', {}, 'ui'));
  scrub.addEventListener('input', () => store.set({ frameIndex: Number(scrub.value), playing: false }, 'ui'));
  $('#p-speed').addEventListener('change', (e) => {
    local.speed = Number(e.target.value);
    syncTimer(store.get());
  });
  $('#p-visit').addEventListener('change', (e) => {
    local.perVisit = e.target.checked;
    loadedKey = '';
    reload(store.get());
  });
  $('#p-cmap').addEventListener('change', (e) => {
    local.colormap = e.target.value;
    show(store.get());
  });
  $('#p-ring').addEventListener('change', (e) => (ring.style.display = e.target.checked ? '' : 'none'));

  // --- loading -----------------------------------------------------------------------
  const keyOf = (s) => `${s.ra.toFixed(5)},${s.dec.toFixed(5)}|${s.ffov}|${s.band}|${local.perVisit}`;

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

  async function reload(s) {
    const key = keyOf(s);
    if (key === loadedKey) return;
    loadedKey = key;
    const token = ++loadToken;
    const stale = () => token !== loadToken;
    seq = [];
    stretch = null;
    clearCanvas();
    setMessage('Finding SPHEREx images of this patch…');
    try {
      const list = await loadFrameList(s.ra, s.dec);
      if (stale()) return;
      const frames = framesForBand(list, s.band);
      if (!frames.length) {
        const near = bandsWithData(list, s.band).slice(0, 3);
        setMessage(
          list.frames.length
            ? `No SPHEREx image saw this spot in band ${s.band}. Nearby bands with images:`
            : 'SPHEREx has no images of this spot yet.',
          near.map((b) => ({ label: `Band ${b}`, run: () => commands.run('set_band', { band: b }, 'ui') })),
        );
        render(s);
        return;
      }
      setMessage(`Loading ${frames.length} image${frames.length > 1 ? 's' : ''}… 0/${frames.length}`);
      let done = 0;
      const results = await Promise.allSettled(
        frames.map((f) =>
          loadCutout(f, s.ra, s.dec, s.ffov).finally(() => {
            if (!stale()) setMessage(`Loading ${frames.length} images… ${++done}/${frames.length}`);
          }),
        ),
      );
      if (stale()) return;
      // Keep whatever loaded: one failed image must not hide the rest of the time-lapse.
      const cutouts = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const failed = results.length - cutouts.length;
      if (!cutouts.length) throw new Error(results[0].reason?.message ?? 'no image could be loaded');
      seq = local.perVisit ? groupByVisit(cutouts) : cutouts;
      stretch = sharedStretch(seq);
      setMessage('');
      caption.dataset.note = failed ? ` · ${failed} image${failed > 1 ? 's' : ''} could not be loaded` : '';
      if (store.get().frameIndex >= seq.length) store.set({ frameIndex: 0 }, 'player');
      render(store.get());
    } catch (err) {
      if (stale()) return;
      loadedKey = '';
      // Keep the message short: server details go to the console, not the screen.
      console.error('[player]', err);
      setMessage('Could not load the images (the SPHEREx archive may be busy).', [
        { label: 'Retry', run: () => reload(store.get()) },
      ]);
    }
  }

  function groupByVisit(cutouts) {
    const byVisit = new Map();
    for (const c of cutouts) {
      const v = c.meta.visit;
      if (!byVisit.has(v)) byVisit.set(v, []);
      byVisit.get(v).push(c);
    }
    return [...byVisit.values()].map(medianStack);
  }

  // --- drawing ---------------------------------------------------------------------
  function clearCanvas() {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.setAttribute('aria-label', 'No frame loaded');
    caption.textContent = '';
  }

  function show(s) {
    if (!seq.length || !stretch) return;
    const i = ((s.frameIndex % seq.length) + seq.length) % seq.length;
    const f = seq[i];
    drawFrame(canvas, f, stretch, local.colormap);
    const m = f.meta;
    const when = m.n_combined
      ? `${fmtDate(m.date_iso)} – ${fmtDate(m.date_end_iso)} (${m.n_combined} images)`
      : fmtDate(m.date_iso);
    const sat = m.saturated_px ? ` · ${m.saturated_px} saturated px` : '';
    const text = `Frame ${i + 1} of ${seq.length} · ${when} · detector D${m.detector} · ${m.wavelength_um.toFixed(3)} µm · ${m.bad_pct ?? 0}% pixels masked${sat}`;
    caption.textContent = text + (caption.dataset.note ?? '');
    canvas.setAttribute('aria-label', `SPHEREx image: ${text}`);
    scrub.max = String(seq.length - 1);
    scrub.value = String(i);
    scrub.setAttribute('aria-valuetext', `Frame ${i + 1} of ${seq.length}, ${when}`);
  }

  function render(s) {
    const playBtn = $('#p-play');
    playBtn.firstChild.textContent = s.playing ? 'Pause ' : 'Play ';
    playBtn.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    const many = seq.length > 1;
    for (const id of ['#p-prev', '#p-play', '#p-next']) $(id).disabled = !many;
    scrub.disabled = !many;
    if (seq.length && s.frameIndex >= seq.length) {
      store.set({ frameIndex: s.frameIndex % seq.length }, 'player');
      return;
    }
    show(s);
    syncTimer(s);
  }

  function syncTimer(s) {
    clearInterval(timer);
    timer = null;
    if (s.view === 'field' && s.playing && seq.length > 1) {
      timer = setInterval(() => {
        const st = store.get();
        store.set({ frameIndex: (st.frameIndex + 1) % seq.length }, 'player');
      }, 1000 / local.speed);
    }
  }

  // --- state -> player ------------------------------------------------------------
  let reloadTimer = null;
  store.subscribe((s, changed) => {
    if (s.view !== 'field') {
      syncTimer(s);
      return;
    }
    if (['ra', 'dec', 'ffov', 'band', 'view'].some((k) => changed.includes(k))) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => reload(store.get()), 250); // panning/band scrubbing: wait until settled
    }
    render(s);
  });
  if (store.get().view === 'field') reload(store.get());

  return { getSequence: () => seq, getStretch: () => stretch };
}
