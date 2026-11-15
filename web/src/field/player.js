// Time-lapse player: the SPHEREx frames of the current patch, in date order, plus the
// date operations (blink, add, subtract). Two stages:
//   1. sequence  – which images make up the time-lapse (built in sequence.js; Step 8 adds band modes)
//   2. operation – state.op: none (time-lapse) | blink | add | subtract, on dates chosen in state.t
// Every control is a command, so keyboard, external controllers and the guide drive it the same way.
import { loadFrameList, bandsWithData } from './frames.js';
import { buildSequence, sequenceKey } from './sequence.js';
import { drawFrame, drawRGB, sharedStretch, rgbStretches } from './render.js';
import { addFrames, differenceSignificance, pickPair, pickForAdd } from './compare.js';
import { motionTrail, resampleToGrid } from './trail.js';
import { buildModel, renderAt, bracket } from './changeModel.js';
import { loadWiseFrames, WISE_PIXEL_ARCSEC } from './wiseFrames.js';
import { groupByVisit } from './sequence.js';

const SPEEDS = [1, 2, 4, 6, 10]; // frames per second
const BLINK_HZ = 2;
const DIFF_RANGE_SIGMA = 5; // difference images span ±5σ
const SPHEREX_PIXEL_ARCSEC = 6.15;
const TRAIL_STRETCH = [0, 1, 2].map(() => ({ vmin: 0, vmax: 1, kind: 'linear' }));
const VIDEO_SECONDS = 12; // the whole time line, 2010 → 2026, plays in this many seconds
const VIDEO_HOLD = 0.45; // seconds to hold on each real image
const VIDEO_STRETCH = { vmin: 0, vmax: 1, kind: 'linear' };
const mjdToIso = (mjd) => new Date((mjd - 40587) * 864e5).toISOString();
const monthYear = (mjd) => new Date((mjd - 40587) * 864e5).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
const year = (mjd) => new Date((mjd - 40587) * 864e5).getUTCFullYear();
const cssColour = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
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
          <svg class="video-marks" id="video-marks" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"></svg>
          <span class="video-badge" id="video-badge" hidden></span>
        </div>
        <p id="player-msg" class="player-msg" role="status" aria-live="polite"></p>
      </div>
      <div class="video-line" id="video-line" hidden aria-hidden="true">
        <span id="video-from"></span><div class="video-track" id="video-track"><div class="video-head" id="video-head"></div></div><span id="video-to"></span>
      </div>
      <div class="trail-legend" id="trail-legend" hidden aria-hidden="true">
        <span id="trail-from"></span><div class="trail-bar" id="trail-bar"></div><span id="trail-to"></span>
      </div>
      <div class="player-bar" role="group" aria-label="Compare dates">
        <button type="button" data-op="none">Time-lapse <kbd>t</kbd></button>
        <button type="button" data-op="blink">Blink <kbd>b</kbd></button>
        <button type="button" data-op="add">Add <kbd>m</kbd></button>
        <button type="button" data-op="subtract">Difference <kbd>d</kbd></button>
        <button type="button" data-op="trail">Motion trail <kbd>r</kbd></button>
        <button type="button" data-op="video">Change video <kbd>v</kbd></button>
        <label class="inline" id="video-marks-wrap" hidden><input type="checkbox" id="video-marks-on" checked /> Mark moving objects</label>
        <label class="inline" id="trail-wise-wrap" hidden><input type="checkbox" id="trail-wise" checked /> Include WISE 2010–2024</label>
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

  const local = { speed: 2, perVisit: false, colormap: 'grey', trailWise: true, videoMarks: true };
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
  const wise = { key: '', frames: null, error: '', loading: false }; // WISE epochs for the trail and video
  const movers = { key: '', list: null, error: '', loading: false }; // catalogue movers for the video
  const vid = { mjd: null, hold: 0, raf: 0, last: 0, out: null }; // change-video playhead
  const showListeners = [];

  // --- controls -> commands --------------------------------------------------------
  $('#p-prev').addEventListener('click', () => commands.run('step_prev', {}, 'ui'));
  $('#p-next').addEventListener('click', () => commands.run('step_next', {}, 'ui'));
  $('#p-play').addEventListener('click', () => commands.run('toggle_play', {}, 'ui'));
  stage.querySelectorAll('[data-op]').forEach((b) =>
    b.addEventListener('click', () => commands.run('set_op', { op: b.dataset.op }, 'ui')),
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
  $('#video-marks-on').addEventListener('change', (e) => {
    local.videoMarks = e.target.checked;
    show(store.get());
  });
  $('#trail-wise').addEventListener('change', (e) => {
    local.trailWise = e.target.checked;
    show(store.get());
  });
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
      if (firstLoad && st.op === 'video' && !st.playing) patch.playing = true; // a shared video link starts playing
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
    if (s.op === 'trail' && n >= 2 && kind !== 'rgb') return trailView(s);
    if (s.op === 'video' && n >= 2 && kind !== 'rgb') return videoView(s);
    return { frame: seq[i], stretch, cmap: local.colormap, label: '', index: i };
  }

  // Motion trail: one picture of every date, oldest blue → newest red (trail.js). With WISE on,
  // the SPHEREx visits are resampled onto WISE's finer 2.75" grid and the 2010–2024 WISE epochs
  // come first, so the time line spans ~16 years and nearby stars visibly streak.
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
          if (st.op === 'trail' || st.op === 'video') show(st);
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
    if (vid.model !== model) {
      // a new model (WISE or the motion catalogue just arrived): start again from its first image
      vid.model = model;
      vid.mjd = null;
    }
    if (vid.mjd == null || vid.mjd < model.t0 || vid.mjd > model.t1) vid.mjd = model.t0;
    if (!vid.out || vid.out.length !== model.w * model.h) vid.out = new Float32Array(model.w * model.h);
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
    const when = real
      ? `Real image ${k + 1} of ${f.length}: ${missionOf(real)} · ${fmtDate(real.meta.date_iso ?? mjdToIso(real.meta.mjd))}`
      : `Model frame ~${monthYear(vid.mjd)}, between the real ${missionOf(f[k])} image of ${monthYear(model.mjds[k])} ` +
        `and the ${missionOf(f[k + 1])} image of ${monthYear(model.mjds[k + 1])}`;
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
      `${when}. ${moving} In-between frames are a model: everything cross-fades, and each moving object's own image ` +
      `slides along its straight-line motion. Each image is scaled on its own; WISE (4.6 µm, 2.75″ pixels) looks sharper than SPHEREx (6.15″).${wiseNote}`
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
    badge.textContent = real ? `REAL · ${missionOf(real)} · ${monthYear(real.meta.mjd)}` : `MODEL · ${monthYear(vid.mjd)}`;
    badge.classList.toggle('real', Boolean(real));
  }

  function videoTick(now) {
    vid.raf = 0;
    const st = store.get();
    if (!(st.op === 'video' && st.view === 'field' && st.playing && seq.length)) return;
    const dt = vid.last ? Math.min(0.1, (now - vid.last) / 1000) : 0;
    vid.last = now;
    const model = videoModel(st);
    if (vid.hold > 0) {
      vid.hold -= dt;
    } else {
      const { k } = bracket(model.mjds, vid.mjd ?? model.t0);
      const next = model.mjds[k + 1];
      let t = (vid.mjd ?? model.t0) + (dt * (model.t1 - model.t0)) / VIDEO_SECONDS;
      if (next == null) {
        t = model.t0; // loop
        vid.hold = VIDEO_HOLD;
      } else if (t >= next) {
        t = next; // land exactly on the next real image and hold it
        vid.hold = k + 1 === model.mjds.length - 1 ? VIDEO_HOLD * 3 : VIDEO_HOLD;
      }
      vid.mjd = t;
    }
    show(st);
    vid.raf = requestAnimationFrame(videoTick);
  }

  function trailView(s) {
    const { frames, visits, wiseFrames } = alignedFrames(s);
    const key = `trail:${wiseFrames ? 'wise' : 'spherex'}:${seq.length}`;
    if (!derived.has(key)) {
      const t = motionTrail(frames);
      const frame = {
        id: key,
        w: t.w,
        h: t.h,
        rgb: [{ data: t.r }, { data: t.g }, { data: t.b }],
        meta: { ...visits[0].meta, mode: 'trail' },
        trail: { ...t, nWise: wiseFrames?.length ?? 0, nSpherex: visits.length },
      };
      derived.set(key, { frame, stretch: TRAIL_STRETCH });
    }
    return { ...derived.get(key), label: '', index: null };
  }

  function describeTrail(view) {
    const t = view.frame.trail;
    const parts = [];
    if (t.nWise) parts.push(`${t.nWise} WISE 4.6 µm images`);
    parts.push(`${t.nSpherex} SPHEREx visits`);
    let wiseNote = '';
    if (local.trailWise && !t.nWise) {
      wiseNote = wise.loading ? ' · Loading WISE 2010–2024…' : wise.error ? ` · WISE not available here (${wise.error}).` : '';
    }
    return (
      `Motion trail: ${parts.join(' + ')}, ${year(t.t0)}–${year(t.t1)}, each tinted by date (oldest blue → newest red) and stacked. ` +
      'Things that stay put come out white; a moving object leaves a rainbow streak from blue to red; ' +
      'a star that changes brightness gets a coloured fringe. Each image is scaled on its own, so compare positions, not brightness.' +
      wiseNote
    );
  }

  function describe(s, view) {
    const m = view.frame.meta;
    if (view.frame.trail) return describeTrail(view);
    if (view.frame.video) return describeVideo(view);
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
    renderTrailLegend(view.frame.trail);
    renderVideoLine(view.frame.video);
    for (const fn of showListeners) fn(view);
  }

  function renderTrailLegend(t) {
    const legend = $('#trail-legend');
    legend.hidden = !t;
    if (!t) return;
    $('#trail-from').textContent = String(year(t.t0));
    $('#trail-to').textContent = String(year(t.t1));
    // one stop per date, placed by time, so the bar shows where the dates bunch up
    const span = t.t1 - t.t0 || 1;
    const stops = t.mjds.map((m, k) => `${cssColour(t.colours[k])} ${(((m - t.t0) / span) * 100).toFixed(1)}%`);
    $('#trail-bar').style.background = `linear-gradient(to right, ${stops.join(', ')})`;
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
    const timelapse = s.op === 'none' || s.op === 'video'; // the video plays, pauses and steps too
    for (const id of ['#p-prev', '#p-play', '#p-next']) $(id).disabled = !many || !timelapse;
    scrub.disabled = !many || !timelapse;
    stage.querySelectorAll('[data-op]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.op === s.op));
      b.disabled = (b.dataset.op !== 'none' && !many) || (['subtract', 'trail', 'video'].includes(b.dataset.op) && kind === 'rgb');
    });
    $('#trail-wise-wrap').hidden = !['trail', 'video'].includes(s.op);
    $('#video-marks-wrap').hidden = s.op !== 'video';
    $('#p-visit').disabled = s.mode !== 'single'; // other modes are already one per visit
    $('#op-hint').textContent =
      s.op === 'none'
        ? ''
        : s.op === 'add'
          ? 'Select 2+ dates below, or all are added.'
          : s.op === 'trail' || s.op === 'video'
            ? 'Uses every date.'
            : 'Select two dates below, or the first and last are used.';
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
      vid.last = 0;
      vid.raf = requestAnimationFrame(videoTick);
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
    if (changed.includes('op') && s.op === 'video' && !s.playing) {
      vid.mjd = null;
      store.set({ playing: true }, 'player'); // the video starts playing (Space pauses)
      return;
    }
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
