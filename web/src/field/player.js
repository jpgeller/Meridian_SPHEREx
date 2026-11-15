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

const SPEEDS = [1, 2, 4, 6, 10]; // frames per second
const BLINK_HZ = 2;
const SPHEREX_PIXEL_ARCSEC = 6.15;
const VIDEO_SECONDS = 12; // the whole time line, 2010 → 2026, plays in this many seconds
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
          <svg class="target-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="4.5"/></svg>
          <svg class="video-marks" id="video-marks" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"></svg>
          <span class="video-badge" id="video-badge" hidden></span>
        </div>
        <p id="player-msg" class="player-msg" role="status" aria-live="polite"></p>
      </div>
      <div class="video-line" id="video-line" data-guide="video-line" hidden aria-hidden="true">
        <span id="video-from"></span><div class="video-track" id="video-track"><div class="video-head" id="video-head"></div></div><span id="video-to"></span>
      </div>
      <p id="player-caption" class="player-caption"></p>
      </div>
      <div class="player-right">
      <div class="player-bar" role="radiogroup" aria-label="What to show" data-guide="show-modes">
        <button type="button" role="radio" data-show="timelapse" data-guide="op-none">Time-lapse <kbd>t</kbd></button>
        <button type="button" role="radio" data-show="video" data-guide="op-video">Change video <kbd>v</kbd></button>
        <button type="button" role="radio" data-show="blink" data-guide="op-blink">Blink two dates <kbd>b</kbd></button>
        <button type="button" role="radio" data-show="wise" data-guide="op-wise">Side by side with WISE <kbd>w</kbd></button>
        <button type="button" role="radio" data-show="gaia" data-guide="op-gaia">Side by side with Gaia</button>
      </div>
      <div class="player-bar video-options" role="group" aria-label="Change video options">
        <span class="row wrap" id="video-marks-wrap" hidden>
          <button type="button" role="switch" aria-checked="true" id="video-marks-on">Mark moving objects</button>
          <button type="button" role="switch" aria-checked="true" id="video-steady">Steady background</button>
          <button type="button" role="switch" aria-checked="false" id="video-hold">Pause on real images</button>
        </span>
        <span id="trail-wise-wrap" hidden><button type="button" role="switch" aria-checked="true" id="trail-wise">Include WISE 2010–2024</button></span>
        <span class="muted hint" id="op-hint"></span>
      </div>
      <div class="epochs" id="epochs" data-guide="dates" role="group" aria-label="Dates (select two to compare)"></div>
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
        <button type="button" role="switch" aria-checked="true" id="p-ring">Mark target</button>
      </div>
      </div>
    </div>`;

  const $ = (s) => stage.querySelector(s);
  const canvas = $('#frame-canvas');
  const msg = $('#player-msg');
  const caption = $('#player-caption');
  const scrub = $('#p-scrub');
  const ring = stage.querySelector('.target-ring');
  const epochsEl = $('#epochs');

  const local = { speed: 2, perVisit: false, colormap: 'grey', trailWise: true, videoMarks: true, videoSteady: true, videoHold: false };
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
  const vid = { mjd: null, hold: 0, raf: 0, last: 0, out: null, loop: 0, tick: null }; // change-video playhead
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
  onSwitch('#video-steady', (on) => {
    local.videoSteady = on;
    show(store.get());
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
    } finally {
      if (!stale()) loading = false;
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
    const data = renderAt(model, vid.mjd, vid.out, { steady: local.videoSteady });
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
    if (local.videoSteady) when = `~${monthYear(vid.mjd)}${real ? `, moving objects from the real ${missionOf(real)} image of this date` : `, ${between}`}`;
    else if (real) when = `Real image ${k + 1} of ${f.length}: ${missionOf(real)} · ${fmtDate(real.meta.date_iso ?? mjdToIso(real.meta.mjd))}`;
    else when = `Model frame ~${monthYear(vid.mjd)}, ${between}`;
    const how = local.videoSteady
      ? `Steady background: everything that doesn't move is the average of all ${f.length} images, so it stays still; ` +
        "only the moving objects change, each shown with its own real image from the nearest dates, slid along its motion. " +
        'Turn it off to see each real image as it is (stars then shimmer: every image has its own noise, sharpness and scaling).'
      : "In-between frames are a model: everything cross-fades, and each moving object's own image slides along its " +
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
    const isReal = Boolean(real) && !local.videoSteady; // with a steady background no frame is a whole real image
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

  function videoTick(now, id) {
    if (id !== vid.loop) return; // a newer loop took over
    vid.raf = 0;
    const st = store.get();
    if (!(st.op === 'video' && st.view === 'field' && st.playing && seq.length)) return;
    const dt = vid.last ? Math.min(0.5, (now - vid.last) / 1000) : 0;
    vid.last = now;
    const model = videoModel(st);
    if ((local.trailWise && wise.loading) || movers.loading) {
      // wait on the first image until WISE 2010–2024 and the motion catalogue are in
      vid.mjd = null;
      show(st);
      vid.raf = requestAnimationFrame(vid.tick);
      return;
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
    for (const id of ['#p-prev', '#p-play', '#p-next']) $(id).disabled = !many || !timelapse;
    scrub.disabled = !many || !timelapse;
    const chosen = showOf(s);
    stage.querySelectorAll('[data-show]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.show === chosen));
      b.disabled = (['video', 'blink'].includes(b.dataset.show) && !many) || (b.dataset.show === 'video' && kind === 'rgb');
    });
    // the options row only has content in the video (its options) or blink (its hint)
    $('.video-options').hidden = !['video', 'blink'].includes(s.op);
    epochsEl.hidden = s.op === 'video'; // the video has its own time line; the date buttons are for time-lapse and blink
    $('#trail-wise-wrap').hidden = s.op !== 'video';
    $('#video-marks-wrap').hidden = s.op !== 'video';
    $('#p-visit').disabled = s.mode !== 'single'; // other modes are already one per visit
    $('#op-hint').textContent =
      s.op === 'blink' ? 'Pick two dates (or it uses the first and last).' : '';
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
