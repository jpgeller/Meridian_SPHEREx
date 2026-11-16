// Time-lapse player: the SPHEREx frames of the current patch, in date order, plus two other ways
// to look at them. Two stages:
//   1. sequence  – which images make up the time-lapse (built in sequence.js; Step 8 adds band modes)
//   2. operation – state.op: none (time-lapse) | blink (two dates, flicking) | video (change video,
//      WISE 2010 -> SPHEREx 2026). Add, Difference and Motion trail were removed on 16 Nov 2026 to keep
//      the 2D view simple (Difference confused people; the video shows motion better than the trail).
// Every control is a command, so keyboard, external controllers and the guide drive it the same way.
import { loadFrameList, bandsWithData } from './frames.js';
import { buildSequence, sequenceKey } from './sequence.js';
import { drawFrame, drawRGB, sharedStretch, rgbStretches } from './render.js';
import { pickPair } from './compare.js';
import { resampleToGrid } from './trail.js';
import { buildModel, renderAt, bracket } from './changeModel.js';
import { loadWiseFrames, WISE_PIXEL_ARCSEC } from './wiseFrames.js';
import { groupByVisit } from './sequence.js';
import { showOf } from '../core/state.js';
import { sectionTitle } from '../ui/sectionIcons.js';
import { findNotInGaia } from './notInGaia.js';
import { formatRaDec } from '../core/coords.js';

const SPEEDS = [1, 2, 4, 6, 10]; // frames per second
const BLINK_HZ = 2;
const SPHEREX_PIXEL_ARCSEC = 6.15;
const VIDEO_SECONDS = 12; // the whole time line, 2010 → 2026, plays in this many seconds
// Play waits at most this long for WISE 2010–2024 and the motion catalogue, then starts with what it has
// (they join the video when they arrive). Without a limit, a slow archive left Play on the first image.
const VIDEO_WAIT_MS = 10000;
const VIDEO_HOLD = 0.45; // seconds to hold on each real image (optional: "Pause on real images")
const VIDEO_END_HOLD = 1; // seconds on the last image before the video loops
const VIDEO_STRETCH = { vmin: 0, vmax: 1, kind: 'linear' };
const mjdToIso = (mjd) => new Date((mjd - 40587) * 864e5).toISOString();
const monthYear = (mjd) => new Date((mjd - 40587) * 864e5).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
const year = (mjd) => new Date((mjd - 40587) * 864e5).getUTCFullYear();
const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const shortDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : '—';

export function createPlayer(stage, { store, commands }) {
  stage.innerHTML = `
    <div class="player" data-guide="time-player">
      <!-- two columns (64 px targets do not fit under the image): the image, its time line and caption
           on the left; every control on the right (main.js also moves the size and band buttons there) -->
      <div class="player-left">
      <div class="player-view">
        <div class="canvas-wrap">
          <canvas id="frame-canvas" role="img" aria-label="No frame loaded"></canvas>
          <svg class="target-ring" viewBox="0 0 100 100" aria-hidden="true" style="display: none"><!-- off by default: Display options → Mark target --><circle cx="50" cy="50" r="4.5"/></svg>
          <svg class="video-marks" id="video-marks" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"></svg>
          <svg class="nogaia-marks" id="nogaia-marks" viewBox="0 0 100 100" aria-hidden="true"></svg>
          <span class="video-badge" id="video-badge" hidden></span>
        </div>
        <p id="player-msg" class="player-msg" role="status" aria-live="polite"></p>
        <div class="player-loading" id="player-loading" hidden>
          <span class="pl-text" id="pl-text" role="status" aria-live="polite"></span>
          <div class="pl-bar" id="pl-bar" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100"><div class="pl-fill" id="pl-fill"></div></div>
        </div>
      </div>
      <div class="video-line" id="video-line" data-guide="video-line" hidden aria-hidden="true">
        <span id="video-from"></span><div class="video-track" id="video-track"><div class="video-head" id="video-head"></div></div><span id="video-to"></span>
      </div>
      <p id="player-caption" class="player-caption"></p>
      </div>
      <div class="player-right">
      <section class="fsec" aria-labelledby="fsec-view">
      ${sectionTitle('fsec-view', 'view', 'View', 'What to show. Time-lapse plays the real images in date order. Change video slides smoothly between them and marks moving objects. Blink flips between two dates. Side by side with WISE / Gaia put a WISE image or a picture drawn from the Gaia catalogue next to SPHEREx. Not in Gaia lists sources SPHEREx sees that Gaia does not (candidates, not discoveries).')}
      <div class="player-bar" role="radiogroup" aria-label="What to show" data-guide="show-modes">
        <button type="button" role="radio" data-show="timelapse" data-guide="op-none">Time-lapse <kbd>t</kbd></button>
        <button type="button" role="radio" data-show="video" data-guide="op-video">Change video <kbd>v</kbd></button>
        <button type="button" role="radio" data-show="blink" data-guide="op-blink">Blink two dates <kbd>b</kbd></button>
        <button type="button" role="radio" data-show="wise" data-guide="op-wise" aria-label="Side by side with WISE" aria-keyshortcuts="w"><span class="lbl-long">Side by side with</span><span class="lbl-short">Beside</span> WISE <kbd>w</kbd></button>
        <button type="button" role="radio" data-show="gaia" data-guide="op-gaia" aria-label="Side by side with Gaia"><span class="lbl-long">Side by side with</span><span class="lbl-short">Beside</span> Gaia</button>
        <button type="button" role="radio" data-show="nogaia" data-guide="op-nogaia">Not in Gaia <kbd>n</kbd></button>
      </div>
      <div class="player-bar video-options" role="group" aria-label="Change video options">
        <span class="row wrap" id="video-marks-wrap" hidden>
          <button type="button" role="switch" aria-checked="true" id="video-marks-on">Mark moving objects</button>
          <button type="button" role="switch" aria-checked="false" id="video-hold">Pause on real images</button>
        </span>
        <span id="trail-wise-wrap" hidden><button type="button" role="switch" aria-checked="true" id="trail-wise">Include WISE 2010–2024</button></span>
        <span class="muted hint" id="op-hint"></span>
      </div>
      </section>
      <section class="fsec" aria-labelledby="fsec-measure">
      ${sectionTitle('fsec-measure', 'measure', 'Measure', "Measure the target's light under the image. Spectrum: its brightness in SPHEREx's 102 colours (click the image to measure another spot). SED with Gaia: Gaia's visible light and SPHEREx's infrared on one graph, aligned where both see the same light, with a temperature from a blackbody fit. Press again to close.")}
      <div class="player-bar measure-row" role="group" aria-label="Measure">
        <button type="button" data-measure="spectrum" data-guide="measure-spectrum" aria-pressed="false">Spectrum <kbd>s</kbd></button>
        <button type="button" data-measure="sed" data-guide="measure-sed" aria-pressed="false">SED with Gaia <kbd>e</kbd></button>
      </div>
      </section>
      <section class="fsec" id="fsec-dates-sec" aria-labelledby="fsec-dates">
      ${sectionTitle('fsec-dates', 'dates', 'Dates', 'The dates SPHEREx photographed this patch (in brackets: how many images that visit). Press one to jump to it; in Blink, pick the two dates to compare.')}
      <div class="epochs" id="epochs" data-guide="dates" role="group" aria-label="Dates (select two to compare)"></div>
      </section>
      <section class="fsec" aria-labelledby="fsec-playback">
      ${sectionTitle('fsec-playback', 'playback', 'Playback', 'Step back and forward one image (keys , and .), play or pause (Space), or drag the slider. Display options: speed, one image per visit, colours, and a ring on the target.')}
      <div class="player-bar">
        <button type="button" id="p-prev" data-guide="frame-prev" aria-label="Previous frame">◀︎ <kbd>,</kbd></button>
        <button type="button" id="p-play" data-guide="play" aria-keyshortcuts="Space">Play <kbd>Space</kbd></button>
        <button type="button" id="p-next" data-guide="frame-next" aria-label="Next frame"><kbd>.</kbd> ▶︎</button>
        <button type="button" id="p-more" aria-expanded="false" aria-controls="p-more-row">Display options</button>
        <input type="range" id="p-scrub" data-guide="frame-slider" min="0" max="0" value="0" aria-label="Frame" />
      </div>
      <div class="player-bar" id="p-more-row" hidden role="group" aria-label="Display options">
        <button type="button" id="p-speed" title="Press to change">Speed: 2 fps</button>
        <button type="button" role="switch" aria-checked="false" id="p-visit">One per visit</button>
        <button type="button" id="p-cmap" title="Press to change">Colours: grey</button>
        <button type="button" role="switch" aria-checked="false" id="p-ring">Mark target</button>
      </div>
      </section>
      </div>
    </div>`;

  const $ = (s) => stage.querySelector(s);
  const canvas = $('#frame-canvas');
  const msg = $('#player-msg');
  const caption = $('#player-caption');
  const scrub = $('#p-scrub');
  const ring = stage.querySelector('.target-ring');
  const epochsEl = $('#epochs');

  const local = { speed: 2, perVisit: false, colormap: 'grey', trailWise: true, videoMarks: true, videoHold: false };
  let seq = []; // the images of the current sequence (aligned frames)
  let stretch = null; // grey: one stretch; colour: three (one per channel)
  let kind = 'grey';
  let note = '';
  let loadToken = 0;
  let loading = false; // building a sequence (the guide stays quiet meanwhile)
  let loadedKey = '';
  let playTimer = null;
  let blinkTimer = null;
  let blinkPhase = 0;
  const derived = new Map(); // memoised results (change-video models) for the current sequence
  let shownFrame = null; // what is on the canvas now (for overlays)
  const wise = { key: '', frames: null, error: '', loading: false }; // WISE epochs for the change video
  const movers = { key: '', list: null, error: '', loading: false }; // catalogue movers for the video
  const gaiaCat = { key: '', list: null, error: '', loading: false }; // Gaia DR3 stars, for "Not in Gaia"
  const vid = { mjd: null, hold: 0, raf: 0, last: 0, out: null, loop: 0, tick: null, waitStart: null, waitDone: false }; // change-video playhead
  const showListeners = [];

  // --- controls -> commands --------------------------------------------------------
  $('#p-prev').addEventListener('click', () => commands.run('step_prev', {}, 'ui'));
  $('#p-next').addEventListener('click', () => commands.run('step_next', {}, 'ui'));
  $('#p-play').addEventListener('click', () => commands.run('toggle_play', {}, 'ui'));
  stage.querySelectorAll('[data-show]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_show', { show: b.dataset.show }, 'ui')),
  );
  scrub.addEventListener('input', () => {
    const st = store.get();
    if (st.op === 'video') {
      const model = videoModel(st);
      if (model) {
        vid.mjd = model.t0 + (Number(scrub.value) / 1000) * (model.t1 - model.t0);
        vid.hold = 0;
      }
      if (st.playing) store.set({ playing: false }, 'ui');
      else show(st);
      return;
    }
    store.set({ frameIndex: Number(scrub.value), playing: false }, 'ui');
  });
  // , and . in the change video jump between the real images (see step_next in defaultCommands.js)
  window.addEventListener('meridian:video-step', (e) => {
    const st = store.get();
    const model = st.op === 'video' ? videoModel(st) : null;
    if (!model) return;
    const { k, u } = bracket(model.mjds, vid.mjd ?? model.t0);
    const n = model.mjds.length;
    const target = e.detail.dir > 0 ? (k + 1) % n : u > 0 ? k : (k - 1 + n) % n;
    vid.mjd = model.mjds[target];
    vid.hold = 0;
    show(st);
  });
  // On/off options are switch buttons and choices are buttons that step through them: eye control
  // presses buttons, and checkboxes and drop-down lists cannot be made 64 px targets.
  const onSwitch = (id, fn) =>
    $(id).addEventListener('click', (e) => {
      const on = e.currentTarget.getAttribute('aria-checked') !== 'true';
      e.currentTarget.setAttribute('aria-checked', String(on));
      fn(on);
    });
  const onCycle = (id, values, label, fn) =>
    $(id).addEventListener('click', (e) => {
      const next = values[(values.indexOf(fn.current()) + 1) % values.length];
      e.currentTarget.textContent = label(next);
      fn(next);
    });
  onSwitch('#video-hold', (on) => {
    local.videoHold = on;
    vid.hold = 0;
  });
  onSwitch('#video-marks-on', (on) => {
    local.videoMarks = on;
    show(store.get());
  });
  onSwitch('#trail-wise', (on) => {
    local.trailWise = on;
    show(store.get());
  });
  const setSpeed = (v) => {
    local.speed = v;
    syncTimers(store.get());
  };
  setSpeed.current = () => local.speed;
  onCycle('#p-speed', SPEEDS, (v) => `Speed: ${v} fps`, setSpeed);
  onSwitch('#p-visit', (on) => {
    local.perVisit = on;
    reload(store.get(), { force: true });
  });
  const setCmap = (v) => {
    local.colormap = v;
    show(store.get());
  };
  setCmap.current = () => local.colormap;
  onCycle('#p-cmap', ['grey', 'inferno'], (v) => `Colours: ${v}`, setCmap);
  onSwitch('#p-ring', (on) => (ring.style.display = on ? '' : 'none'));
  $('#p-more').addEventListener('click', (e) => {
    const row = $('#p-more-row');
    row.hidden = !row.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!row.hidden));
  });

  // A loading bar over the image: fraction 0..1, or null for "busy, no count".
  const loadingEl = $('#player-loading');
  function setProgress(text, fraction = null) {
    loadingEl.hidden = false;
    $('#pl-text').textContent = text;
    const bar = $('#pl-bar');
    bar.classList.toggle('is-busy', fraction == null);
    $('#pl-fill').style.width = fraction == null ? '' : `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    if (fraction == null) bar.removeAttribute('aria-valuenow');
    else bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  }
  function hideProgress() {
    loadingEl.hidden = true;
  }

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
    loading = true;
    seq = [];
    stretch = null;
    vid.waitDone = false; // a new patch: the video waits for its catalogues again (up to VIDEO_WAIT_MS)
    derived.clear();
    clearCanvas();
    setMessage('');
    setProgress('Finding SPHEREx images of this patch…');
    render(store.get()); // Play stays pressable while loading
    try {
      const list = await loadFrameList(s.ra, s.dec);
      if (stale()) return;
      const result = await buildSequence(list, s, local, {
        stale,
        progress: (done, total) => setProgress(`Loading ${total} image${total > 1 ? 's' : ''}… ${done}/${total}`, total ? done / total : null),
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
      if (store.get().playing) store.set({ playing: false }, 'player'); // nothing to play: the button reads Play again
      setMessage('Could not load the images (the SPHEREx archive may be busy).', [
        { label: 'Retry', run: () => reload(store.get(), { force: true }) },
      ]);
    } finally {
      if (!stale()) {
        loading = false;
        hideProgress();
        render(store.get());
      }
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
    if (s.op === 'video' && n >= 2 && kind !== 'rgb') return videoView(s);
    if (s.op === 'nogaia' && kind !== 'rgb') return notInGaiaView(s);
    return { frame: seq[i], stretch, cmap: local.colormap, label: '', index: i };
  }

  // The change video's WISE part: the 2010–2024 WISE epochs, resampled with the SPHEREx visits onto
  // WISE's finer 2.75" grid, so the time line spans ~16 years and nearby stars visibly move.
  function wantWise(s) {
    const key = `${s.ra.toFixed(5)},${s.dec.toFixed(5)}|${s.ffov}`;
    if (wise.key !== key) Object.assign(wise, { key, frames: null, error: '', loading: false });
    if (!wise.frames && !wise.error && !wise.loading) {
      wise.loading = true;
      loadWiseFrames(s.ra, s.dec, s.ffov)
        .then((frames) => (wise.key === key ? (wise.frames = frames) : null))
        .catch((err) => (wise.key === key ? (wise.error = err.message) : null))
        .finally(() => {
          if (wise.key !== key) return;
          wise.loading = false;
          derived.clear();
          const st = store.get();
          if (st.op === 'video') show(st);
        });
    }
    return wise.frames;
  }

  function wantMovers(s) {
    const key = `${s.ra.toFixed(5)},${s.dec.toFixed(5)}|${s.ffov}`;
    if (movers.key !== key) Object.assign(movers, { key, list: null, error: '', loading: false });
    if (!movers.list && !movers.error && !movers.loading) {
      movers.loading = true;
      fetch(`/api/context/movers?ra=${s.ra.toFixed(5)}&dec=${s.dec.toFixed(5)}&fov=${s.ffov}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`motion catalogues unavailable (${r.status})`);
          const body = await r.json();
          if (movers.key === key) movers.list = body;
        })
        .catch((err) => (movers.key === key ? (movers.error = err.message) : null))
        .finally(() => {
          if (movers.key !== key) return;
          movers.loading = false;
          derived.clear();
          const st = store.get();
          if (st.op === 'video') show(st);
        });
    }
    return movers.list;
  }

  /** SPHEREx visits (+ WISE epochs if wanted and loaded) on one grid. */
  function alignedFrames(s) {
    // one image per visit (medians), so a crowded visit doesn't outweigh the others
    const visits = seq.every((f) => f.meta.visit != null && !f.meta.n_combined) ? groupByVisit(seq) : seq;
    const wiseFrames = local.trailWise ? wantWise(s) : null;
    if (!wiseFrames?.length) return { frames: visits, visits, wiseFrames: null, scale: SPHEREX_PIXEL_ARCSEC };
    // same patch of sky as the SPHEREx frames, on WISE's 2.75" pixels
    const k = SPHEREX_PIXEL_ARCSEC / WISE_PIXEL_ARCSEC;
    const size = Math.round(visits[0].w * k);
    const frames = [...wiseFrames.map((f) => resampleToGrid(f, size, 1)), ...visits.map((f) => resampleToGrid(f, size, k))];
    return { frames, visits, wiseFrames, scale: WISE_PIXEL_ARCSEC };
  }

  // --- change video: real images with model frames in between (changeModel.js) ---------
  function videoModel(s) {
    const cat = wantMovers(s);
    const { frames, visits, wiseFrames, scale } = alignedFrames(s);
    const key = `video:${wiseFrames ? 'wise' : 'spherex'}:${seq.length}:${cat ? 'movers' : movers.loading ? 'wait' : 'none'}`;
    if (!derived.has(key)) {
      const model = buildModel(frames, cat?.movers ?? [], { ra0: s.ra, dec0: s.dec, scale }, cat?.epoch_mjd ?? 61041);
      model.nWise = wiseFrames?.length ?? 0;
      model.nSpherex = visits.length;
      derived.set(key, { model });
    }
    return derived.get(key).model;
  }

  function videoView(s) {
    const model = videoModel(s);
    // A new model: when WISE arrives the time line grows back to 2010, so start again from there;
    // otherwise (the motion catalogue arrived) keep the current date.
    if (vid.model && model.t0 < vid.model.t0 - 1) vid.mjd = null;
    vid.model = model;
    if (vid.mjd == null || vid.mjd < model.t0 || vid.mjd > model.t1) vid.mjd = model.t0;
    if (!vid.out || vid.out.length !== model.w * model.h) vid.out = new Float32Array(model.w * model.h);
    // (A "Steady background" option, a still average background with only the movers changing, was removed
    // on 16 Nov 2026: in patches without a fast mover it froze the whole video.)
    const data = renderAt(model, vid.mjd, vid.out);
    const { k, u } = bracket(model.mjds, vid.mjd);
    const real = u === 0 ? model.frames[k] : null;
    const frame = {
      id: `video:${vid.mjd}`,
      data,
      w: model.w,
      h: model.h,
      meta: { ...(real ?? model.frames[k]).meta, date_iso: mjdToIso(vid.mjd) },
      video: { model, k, u, real },
    };
    return { frame, stretch: VIDEO_STRETCH, cmap: local.colormap, label: '', index: null };
  }

  const missionOf = (f) => f.meta.mission ?? 'SPHEREx';
  function describeVideo(view) {
    const { model, k, real } = view.frame.video;
    const f = model.frames;
    const between = f[k + 1]
      ? `between the real ${missionOf(f[k])} image of ${monthYear(model.mjds[k])} and the ${missionOf(f[k + 1])} image of ${monthYear(model.mjds[k + 1])}`
      : '';
    let when;
    const waiting = !store.get().playing && vid.mjd === model.t0;
    const prompt = waiting ? 'Press Play (Space) to start the video. ' : '';
    if (real) when = `Real image ${k + 1} of ${f.length}: ${missionOf(real)} · ${fmtDate(real.meta.date_iso ?? mjdToIso(real.meta.mjd))}`;
    else when = `Model frame ~${monthYear(vid.mjd)}, ${between}`;
    const how =
      "In-between frames are a model: everything cross-fades, and each moving object's own image slides along its " +
        'straight-line motion. Each image is scaled on its own, and WISE (2.75″ pixels) is sharper than SPHEREx (6.15″), so stars shimmer between images.';
    const t = model.tracks;
    const moving = t.length
      ? `Moving: ${t
          .map((m) => `${m.catalog} object at ${m.arcsecPerYear.toFixed(1)}″/yr (${m.path === 'catalogue' ? 'Gaia motion, seen in the images' : 'motion fitted to the images'})`)
          .join(', ')}. Cyan ring = where the model puts it, dotted line = its path.`
      : movers.loading
        ? 'Looking up moving objects…'
        : movers.error
          ? `No motion catalogue (${movers.error}): frames only cross-fade.`
          : 'No fast-moving object confirmed in this patch: frames only cross-fade.';
    let wiseNote = '';
    if (local.trailWise && !model.nWise) {
      wiseNote = wise.loading ? ' Loading WISE 2010–2024…' : wise.error ? ` WISE not available here (${wise.error}).` : '';
    }
    const glare = local.trailWise ? (wise.frames?.saturated ?? 0) : 0;
    if (glare) {
      wiseNote += ` ${glare} WISE image${glare > 1 ? 's' : ''} left out: a bright star's glare fills ${glare > 1 ? 'them' : 'it'} at this field size (try a wider field).`;
    }
    return (
      `${prompt}${when}. ${moving} ${how}${wiseNote}`
    );
  }

  function renderVideoLine(video) {
    const line = $('#video-line');
    line.hidden = !video;
    $('#video-badge').hidden = !video;
    const marks = $('#video-marks');
    if (!video) {
      marks.innerHTML = '';
      return;
    }
    const { model, real } = video;
    // each fitted mover: its whole path (dotted) and a ring where the model puts it now
    const toPct = (p) => [((p.x + 0.5) / model.w) * 100, ((model.h - 0.5 - p.y) / model.h) * 100];
    marks.innerHTML = local.videoMarks
      ? model.tracks
          .map((t) => {
            const [ax, ay] = toPct(t.at(model.t0));
            const [bx, by] = toPct(t.at(model.t1));
            const [cx, cy] = toPct(t.at(vid.mjd));
            const r = Math.max(2.5, ((Math.min(t.radius, 10) + 2) / model.w) * 100);
            return `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" class="path"/><circle cx="${cx}" cy="${cy}" r="${r}" class="now"/>`;
          })
          .join('')
      : '';
    const span = model.t1 - model.t0 || 1;
    const track = $('#video-track');
    const ticksKey = model.mjds.join(',');
    if (track.dataset.ticks !== ticksKey) {
      track.dataset.ticks = ticksKey;
      track.querySelectorAll('.video-tick').forEach((t) => t.remove());
      model.frames.forEach((f) => {
        const tick = document.createElement('span');
        tick.className = `video-tick ${missionOf(f) === 'WISE' ? 'wise' : 'spherex'}`;
        tick.style.left = `${((f.meta.mjd - model.t0) / span) * 100}%`;
        track.append(tick);
      });
    }
    $('#video-head').style.left = `${((vid.mjd - model.t0) / span) * 100}%`;
    $('#video-from').textContent = String(year(model.t0));
    $('#video-to').textContent = String(year(model.t1));
    const badge = $('#video-badge');
    const isReal = Boolean(real);
    badge.textContent = isReal ? `REAL · ${missionOf(real)} · ${monthYear(real.meta.mjd)}` : `MODEL · ${monthYear(vid.mjd)}`;
    badge.classList.toggle('real', isReal);
  }

  // One playback loop at a time: each start gets an id and older loops stop (two loops would
  // double the speed). Time follows the real clock, so slow or throttled frames make the video
  // jumpier, never slower or frozen (capped at 0.5 s per frame, e.g. after switching tabs).
  function startVideoLoop() {
    const id = ++vid.loop;
    vid.last = 0;
    const tick = (now) => videoTick(now, id);
    vid.raf = requestAnimationFrame(tick);
    vid.tick = tick;
  }

  // --- "Not in Gaia": the deep image with the sources Gaia has no star for ---------------------
  function wantGaia(s) {
    const key = `${s.ra.toFixed(5)},${s.dec.toFixed(5)}|${s.ffov}`;
    if (gaiaCat.key !== key) Object.assign(gaiaCat, { key, list: null, error: '', loading: false });
    if (!gaiaCat.list && !gaiaCat.error && !gaiaCat.loading) {
      gaiaCat.loading = true;
      fetch(`/api/context/gaia?ra=${s.ra.toFixed(5)}&dec=${s.dec.toFixed(5)}&fov=${s.ffov}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`Gaia unavailable (${r.status})`);
          const body = await r.json();
          if (gaiaCat.key === key) gaiaCat.list = body.sources ?? [];
        })
        .catch((err) => (gaiaCat.key === key ? (gaiaCat.error = err.message) : null))
        .finally(() => {
          if (gaiaCat.key !== key) return;
          gaiaCat.loading = false;
          derived.clear();
          const st = store.get();
          if (st.op === 'nogaia') show(st);
        });
    }
    return gaiaCat.list;
  }

  function notInGaiaView(s) {
    const gaia = wantGaia(s);
    const key = `nogaia:${seq.length}:${gaia ? 'gaia' : 'wait'}`;
    if (!derived.has(key)) {
      const result = gaia ? findNotInGaia(seq, gaia, { ra0: s.ra, dec0: s.dec, scale: SPHEREX_PIXEL_ARCSEC }) : null;
      derived.set(key, { result });
    }
    const { result } = derived.get(key);
    // the deep image once found (the median of every image), else the first image while Gaia loads
    const frame = result
      ? { id: `nogaia:${seq.length}`, data: result.deep.data, w: result.deep.w, h: result.deep.h, meta: { ...seq[0].meta } }
      : seq[0];
    return { frame, stretch, cmap: local.colormap, label: '', index: null, nogaia: result ?? { pending: true } };
  }

  function renderNotInGaia(res, w, h) {
    const marks = $('#nogaia-marks');
    if (!res || res.pending) {
      marks.innerHTML = '';
      return;
    }
    const pct = (x, y) => [((x + 0.5) / w) * 100, ((h - 0.5 - y) / h) * 100];
    const matched = res.matched
      .map((m) => {
        const [x, y] = pct(m.x, m.y);
        return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.6" class="gaia"/>`;
      })
      .join('');
    const cands = res.candidates
      .map((c) => {
        const [x, y] = pct(c.x, c.y);
        const d = 4;
        return (
          `<rect x="${(x - d).toFixed(2)}" y="${(y - d).toFixed(2)}" width="${2 * d}" height="${2 * d}" class="cand" transform="rotate(45 ${x.toFixed(2)} ${y.toFixed(2)})"/>` +
          `<text x="${(x + d + 1.5).toFixed(2)}" y="${(y - d).toFixed(2)}" class="cand-n">${c.n}</text>`
        );
      })
      .join('');
    marks.innerHTML = matched + cands;
  }

  function describeNotInGaia(s, view) {
    const res = view.nogaia;
    const band = view.frame.meta?.mode === 'detector' ? `detector D${view.frame.meta.detector}` : `band ${s.band}`;
    if (res.pending) {
      return gaiaCat.error
        ? `Not in Gaia: the Gaia catalogue is not available right now (${gaiaCat.error}).`
        : 'Not in Gaia: loading the Gaia DR3 stars of this patch…';
    }
    const n = seq.length;
    const head =
      `Not in Gaia · deep image: the median of ${n} SPHEREx image${n > 1 ? 's' : ''} (${band}). ` +
      `${res.sources.length} source${res.sources.length === 1 ? '' : 's'} found; ${res.matched.length} match a Gaia DR3 star (blue circles), ` +
      `moved to ${monthYear(res.mjd)} with its motion. `;
    const list = res.candidates.length
      ? `${res.candidates.length} with no Gaia star (orange, numbered): ` +
        res.candidates
          .map(
            (c) =>
              `${c.n}: ${Object.values(formatRaDec(c.ra, c.dec)).join(' ')}, ${c.snr.toFixed(0)}σ, in ${c.seen} of ${c.ofFrames} single images` +
              (c.nearestGaiaArcsec != null ? `, nearest Gaia star ${c.nearestGaiaArcsec.toFixed(0)}″ (G ${c.gaiaG?.toFixed(1) ?? '?'})` : '') +
              (Math.hypot(c.x - (view.frame.w - 1) / 2, c.y - (view.frame.h - 1) / 2) < 1.5 ? ' (your target)' : ''),
          )
          .join('; ') +
        '. '
      : 'Every source here has a Gaia star: nothing Gaia cannot see stands out in this band. ';
    const why =
      'Gaia sees visible light, so cold, red or dusty things (brown dwarfs, young stars in dust, galaxies) can be missing from it. ' +
      'These are candidates, not discoveries: noise, glare, galaxies and blends with a nearby star also end up here. ' +
      (res.chance > 0.3 ? `Crowded field: a Gaia star sits by chance within ${res.matchArcsec}″ of ${Math.round(res.chance * 100)}% of spots, so some real ones are hidden. ` : '') +
      (/^D[5-6]/.test(band.replace('detector ', '')) || s.band >= 70 ? '' : 'Cold objects show best in the long bands: try D5 or D6.');
    return head + list + why;
  }

  /** What the change video still waits for (shown on the loading bar). */
  function videoWaitingFor() {
    const out = [];
    if (local.trailWise && wise.loading) out.push('WISE images 2010–2024');
    if (movers.loading) out.push('the moving-object catalogues');
    return out;
  }

  function videoTick(now, id) {
    if (id !== vid.loop) return; // a newer loop took over
    vid.raf = 0;
    const st = store.get();
    if (!(st.op === 'video' && st.view === 'field' && st.playing && seq.length)) {
      if (vid.waitStart != null) {
        vid.waitStart = null;
        if (!loading) hideProgress();
      }
      return;
    }
    const dt = vid.last ? Math.min(0.5, (now - vid.last) / 1000) : 0;
    vid.last = now;
    const model = videoModel(st);
    const waitingFor = videoWaitingFor();
    if (waitingFor.length && !vid.waitDone) {
      // wait on the first image until WISE 2010–2024 and the motion catalogue are in, at most VIDEO_WAIT_MS
      vid.waitStart ??= now;
      const waited = now - vid.waitStart;
      if (waited < VIDEO_WAIT_MS) {
        vid.mjd = null;
        show(st);
        // a busy bar, not a fill: the wait ends when the data arrive, which can be any moment
        const left = Math.ceil((VIDEO_WAIT_MS - waited) / 1000);
        setProgress(`Getting the change video ready: ${waitingFor.join(' and ')}… (starts in ${left} s at most)`, null);
        vid.raf = requestAnimationFrame(vid.tick);
        return;
      }
      vid.waitDone = true; // start now; what is still loading joins when it arrives
    }
    if (vid.waitStart != null) {
      vid.waitStart = null;
      hideProgress();
    }
    if (vid.hold > 0) {
      vid.hold -= dt;
    } else {
      const { k } = bracket(model.mjds, vid.mjd ?? model.t0);
      const next = model.mjds[k + 1];
      let t = (vid.mjd ?? model.t0) + (dt * (model.t1 - model.t0)) / VIDEO_SECONDS;
      if (next == null) {
        t = model.t0; // loop
      } else if (t >= next) {
        const last = k + 1 === model.mjds.length - 1;
        if (local.videoHold || last) {
          t = next; // land exactly on the real image and hold it (always a moment at the end)
          vid.hold = last ? VIDEO_END_HOLD : VIDEO_HOLD;
        }
      }
      vid.mjd = t;
    }
    show(st);
    vid.raf = requestAnimationFrame(vid.tick);
  }

  function describe(s, view) {
    const m = view.frame.meta;
    if (view.frame.video) return describeVideo(view);
    if (view.nogaia) return describeNotInGaia(s, view);
    const when = m.n_combined
      ? `${fmtDate(m.date_iso)} – ${fmtDate(m.date_end_iso)} (${m.n_combined} images)`
      : fmtDate(m.date_iso);
    const pos0 = view.index != null ? `Frame ${view.index + 1} of ${seq.length} · ` : '';
    if (m.mode === 'rgb') {
      const ch = (m.channels ?? []).map((c, k) => `${['red', 'green', 'blue'][k]} = ${c.label}${c.present ? '' : ' (no image this visit)'}`);
      return `${view.label}${pos0}${when} · Colour mix: ${ch.join(', ')}`;
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
    if (view.frame.video) {
      const { model } = view.frame.video;
      scrub.max = '1000';
      scrub.value = String(Math.round(((vid.mjd - model.t0) / (model.t1 - model.t0 || 1)) * 1000));
      scrub.setAttribute('aria-valuetext', `${monthYear(vid.mjd)}`);
    } else {
      scrub.max = String(n - 1);
      scrub.value = String(i);
      scrub.setAttribute('aria-valuetext', `Frame ${i + 1} of ${n}, ${fmtDate(seq[i].meta.date_iso)}`);
    }
    epochsEl.querySelectorAll('[data-epoch]').forEach((b) =>
      b.classList.toggle('current', Number(b.dataset.epoch) === (view.index ?? -1)),
    );
    renderVideoLine(view.frame.video);
    renderNotInGaia(view.nogaia, view.frame.w, view.frame.h);
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
    // no aria-label: the name is what is on screen ("Play Space" / "Pause Space")
    const many = seq.length > 1;
    const timelapse = s.op === 'none' || s.op === 'video'; // the video plays, pauses and steps too
    // While the images load, Play and the views stay pressable: Play then starts by itself once they are in
    // (a disabled Play looked broken, 15 Nov 2026). Only a loaded patch with a single image disables them.
    const few = !many && !loading;
    for (const id of ['#p-prev', '#p-next']) $(id).disabled = !many || !timelapse;
    playBtn.disabled = few || !timelapse;
    scrub.disabled = !many || !timelapse;
    const chosen = showOf(s);
    stage.querySelectorAll('[data-show]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.show === chosen));
      b.disabled = (['video', 'blink'].includes(b.dataset.show) && few) || (['video', 'nogaia'].includes(b.dataset.show) && kind === 'rgb');
    });
    // the options row only has content in the video (its options) or blink (its hint)
    $('.video-options').hidden = !['video', 'blink'].includes(s.op);
    epochsEl.hidden = s.op === 'video' || s.op === 'nogaia'; // the video has its own time line; "Not in Gaia" uses every date
    $('#fsec-dates-sec').hidden = epochsEl.hidden;
    $('#trail-wise-wrap').hidden = s.op !== 'video';
    $('#video-marks-wrap').hidden = s.op !== 'video';
    $('#p-visit').disabled = s.mode !== 'single'; // other modes are already one per visit
    // Blink's instruction rides in the Dates title (a row of its own did not fit small screens)
    $('#op-hint').textContent = '';
    $('#fsec-dates .fsec-text').textContent = s.op === 'blink' ? 'Dates · pick two' : 'Dates'; // (else first and last)
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
    if (active && s.op === 'video' && s.playing && !vid.raf) {
      startVideoLoop();
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
    // The video waits on its first image (2010) until Play is pressed: starting by itself made the
    // button read "Pause", so pressing it to start the video stopped it (16 Nov 2026).
    if (changed.includes('op') && s.op === 'video') vid.mjd = null;
    render(s);
  });
  if (store.get().view === 'field') reload(store.get());

  return {
    getSequence: () => seq,
    getStretch: () => stretch,
    getShownFrame: () => shownFrame,
    getVideoModel: () => vid.model ?? null, // tests and debugging
    onShow: (fn) => showListeners.push(fn),
    // For the guide's target registry (guide/registry.js): where the shown image sits on the sky.
    // Aligned frames (the change video with WISE) cover the same patch on finer pixels, hence the ratio.
    getGeometry: () => {
      if (!shownFrame || !seq.length) return null;
      const s = store.get();
      const iso = shownFrame.meta?.date_iso;
      const mjd = iso ? Date.parse(iso) / 864e5 + 40587 : shownFrame.meta?.mjd;
      const scale = SPHEREX_PIXEL_ARCSEC * (seq[0].w / (shownFrame.w || seq[0].w));
      return { ra0: s.ra, dec0: s.dec, scale, w: shownFrame.w, h: shownFrame.h, mjd };
    },
    isLoading: () => loading, // the frames of a new sequence are still loading (guide attention, U6)
    getMovers: () => movers.list, // { movers: [{ id, ra, dec, pmra, pmdec, ... }], epoch_mjd } or null
    elements: {
      view: stage.querySelector('.player-view'),
      canvasWrap: stage.querySelector('.canvas-wrap'),
      canvas,
      bar: stage.querySelectorAll('.player-bar')[1],
      right: stage.querySelector('.player-right'), // the controls column
    },
  };
}
