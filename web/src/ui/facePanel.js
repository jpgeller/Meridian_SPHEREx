// Face-tracking panel (UI plan U8), in the left column above the places (#face-slot).
// Shows the tracker's 68 landmarks as a mesh, EAR / MAR / head-turn readouts and a gaze dot.
// The tracker runs outside the app (docs/EYE_TRACKING.md) and posts `face` messages; the bridge
// (core/messages.js) re-sends them here as the window event `meridian:face`. With no tracker
// message for 2 s the panel plays a scripted, clearly labelled "Simulated" face instead.
// Pure logic (maths, validation, demo script) is in faceCore.js.
//
// Commands: toggle_face_panel ({open?}), toggle_face_demo ({on?}). Console: meridian.face
//   .feed(msg) · .replay(frames, {fps, loop}) · .stopReplay() · .setGaze({x, y, confidence}) · .snapshot()
import './facePanel.css';
import { createFaceFeed, demoFrame, faceFlags, fitBox, fmt, MESH, partOf, LIVE_TIMEOUT_MS } from './faceCore.js';

const html = String.raw;
const CANVAS_W = 96;
const CANVAS_H = 116;

export function createFacePanel(slot, { commands, target = window, open = true } = {}) {
  slot.innerHTML = html`
    <section class="card face-panel" aria-label="Face tracking">
      <div class="face-head">
        <button type="button" id="face-toggle" class="face-toggle" aria-expanded="${open}" aria-controls="face-body">
          <span class="face-title">Face<span class="sr-only"> tracking</span></span>
          <span id="face-mode" class="face-mode" data-mode="demo">Simulated</span>
          <span class="chev" aria-hidden="true"></span>
        </button>
        <button type="button" id="face-demo" class="face-demo" aria-pressed="false"
                title="Show the simulated face even while a tracker is sending">Demo</button>
      </div>
      <div id="face-body" class="face-body" ${open ? '' : 'hidden'}>
        <div class="face-grid">
          <canvas id="face-canvas" width="${CANVAS_W}" height="${CANVAS_H}" role="img"
                  aria-label="Face landmark mesh, simulated"></canvas>
          <dl class="face-read">
            <div><dt>EAR</dt><dd><span id="face-ear">–</span> <b id="face-blink" class="flag">blink</b></dd></div>
            <div><dt>MAR</dt><dd><span id="face-mar">–</span> <b id="face-open" class="flag">open</b></dd></div>
            <div><dt>Turn</dt><dd id="face-pose" title="Head turn: left/right (yaw) and up/down (pitch)">–</dd></div>
            <div><dt>Tilt</dt><dd id="face-roll" title="Head tilt (roll)">–</dd></div>
            <div class="face-gaze-row"><dt>Gaze</dt>
              <dd><span class="face-gaze" aria-hidden="true"><i id="face-gaze-dot"></i></span>
                  <span id="face-gaze-text" class="muted">no gaze</span></dd></div>
          </dl>
        </div>
        <p id="face-phase" class="face-phase muted"></p>
        <p class="note face-privacy">Video stays on this computer.</p>
      </div>
    </section>`;
  slot.hidden = false;

  const $ = (sel) => slot.querySelector(sel);
  const canvas = $('#face-canvas');
  const ctx = canvas.getContext('2d');
  const feed = createFaceFeed({ now: () => performance.now() });
  const reducedQuery = target.matchMedia?.('(prefers-reduced-motion: reduce)');
  const t0 = performance.now();
  let expanded = open;
  let onScreen = true;
  let running = null; // { stop }
  let lastMode = null;
  let drawnCount = -1;
  let snap = { phase: null, face: null, flags: null, gaze: null };
  let flipTimer = 0;
  let replayTimer = 0;
  let badMessages = 0;

  // Device-pixel-sharp canvas.
  const dpr = Math.max(1, Math.min(3, target.devicePixelRatio || 1));
  canvas.width = CANVAS_W * dpr;
  canvas.height = CANVAS_H * dpr;
  canvas.style.width = `${CANVAS_W}px`;
  canvas.style.height = `${CANVAS_H}px`;
  const css = getComputedStyle(slot);
  const colour = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const C = {
    line: colour('--muted', '#9ba8cc'),
    dot: colour('--text', '#e9eefb'),
    hot: colour('--accent', '#ffb547'),
    faint: colour('--border-strong', '#3d4d82'),
  };

  // --- drawing ----------------------------------------------------------------------------
  function draw(face, mode) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (!face) return;
    const flags = faceFlags(face);
    const { points } = fitBox(face.landmarks, CANVAS_W, CANVAS_H, 10);
    ctx.globalAlpha = face.confidence < 0.5 ? 0.4 : 1;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    for (const [a, b, closed, part] of MESH) {
      const hot = (part === 'eye' && flags.blink) || (part === 'mouth' && flags.mouthOpen);
      ctx.strokeStyle = hot ? C.hot : C.line;
      ctx.beginPath();
      ctx.moveTo(points[a][0], points[a][1]);
      for (let i = a + 1; i <= b; i++) ctx.lineTo(points[i][0], points[i][1]);
      if (closed) ctx.closePath();
      ctx.stroke();
    }
    for (let i = 0; i < points.length; i++) {
      const part = partOf(i);
      ctx.fillStyle = part === 'eye' || part === 'mouth' ? C.hot : C.dot;
      ctx.beginPath();
      ctx.arc(points[i][0], points[i][1], 1.5, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    if (mode === 'demo') {
      ctx.fillStyle = C.faint;
      ctx.fillText('SIMULATED', 4, 4);
    } else if (face.confidence < 0.5) {
      ctx.fillStyle = C.hot;
      ctx.fillText('LOW CONFIDENCE', 4, 4);
    }
  }

  // a flag is filled when on; screen readers hear "blink: yes" / "blink: no" (not colour alone, U10)
  function setFlag(el, word, on) {
    const text = `${word}: ${on ? 'yes' : 'no'}`;
    if (el.dataset.text === text) return;
    el.dataset.text = text;
    el.classList.toggle('on', on);
    const sr = slot.ownerDocument.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = `: ${on ? 'yes' : 'no'}`;
    el.replaceChildren(word, sr);
  }

  function renderReadouts(face, flags) {
    const est = (k) => (face.computed[k] ? ' (computed)' : '');
    $('#face-ear').textContent = `${fmt.ear(face.ear[0])}/${fmt.ear(face.ear[1])}`;
    $('#face-ear').title = `Eye aspect ratio, left · right${est('ear')}. Blink below 0.16.`;
    setFlag($('#face-blink'), flags.wink ? 'wink' : 'blink', flags.blink || flags.wink);
    $('#face-mar').textContent = fmt.mar(face.mar);
    $('#face-mar').title = `Mouth aspect ratio${est('mar')}. Open above 0.30.`;
    setFlag($('#face-open'), 'open', flags.mouthOpen);
    const { yaw, pitch, roll } = face.pose;
    $('#face-pose').textContent = `↔${fmt.deg(yaw)} ↕${fmt.deg(pitch)}`;
    $('#face-roll').textContent = fmt.deg(roll);
  }

  function renderGaze(demoGaze) {
    const real = feed.gazeDot(target.innerWidth, target.innerHeight);
    const g = real ?? demoGaze ?? null;
    const dot = $('#face-gaze-dot');
    dot.hidden = !g;
    dot.classList.toggle('sim', !real && Boolean(g));
    if (g) {
      dot.style.left = `${(g.x * 100).toFixed(1)}%`;
      dot.style.top = `${(g.y * 100).toFixed(1)}%`;
    }
    $('#face-gaze-text').textContent = real ? 'live' : g ? 'sim.' : 'no gaze';
    snap.gaze = real ? { ...real, source: 'tracker' } : g ? { ...g, source: 'demo' } : null;
  }

  function renderMode(mode) {
    if (mode === lastMode) return;
    lastMode = mode;
    const el = $('#face-mode');
    el.dataset.mode = mode;
    el.textContent = mode === 'live' ? 'Live' : 'Simulated';
    canvas.setAttribute('aria-label', mode === 'live' ? 'Face landmark mesh from the tracker' : 'Face landmark mesh, simulated');
    drawnCount = -1;
  }

  function frame() {
    const mode = feed.mode();
    renderMode(mode);
    if (mode === 'live') {
      const face = feed.latest();
      if (feed.count() !== drawnCount) {
        drawnCount = feed.count();
        const flags = faceFlags(face);
        draw(face, mode);
        renderReadouts(face, flags);
        $('#face-phase').textContent = `Tracker · confidence ${Math.round(face.confidence * 100)} %`;
        snap = { ...snap, phase: null, face, flags };
      }
      renderGaze(null);
    } else {
      const d = demoFrame(performance.now() - t0, { reduced: Boolean(reducedQuery?.matches) });
      const flags = faceFlags(d.face);
      draw(d.face, mode);
      renderReadouts(d.face, flags);
      $('#face-phase').textContent = `Simulated: ${d.phase.toLowerCase()}`;
      renderGaze(d.gaze); // a real gaze sample still wins
      snap = { ...snap, phase: d.phase, face: d.face, flags };
    }
  }

  // --- loop: only while expanded, on screen and the tab is visible -----------------------
  function start() {
    if (reducedQuery?.matches) {
      // reduced motion: no smooth animation, a new still pose twice a second
      const id = setInterval(frame, 500);
      running = { stop: () => clearInterval(id) };
    } else {
      let raf = 0;
      const loop = () => {
        frame();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      running = { stop: () => cancelAnimationFrame(raf) };
    }
    frame();
  }
  function sync() {
    const want = expanded && onScreen && !document.hidden;
    if (want && !running) start();
    else if (!want && running) {
      running.stop();
      running = null;
    }
  }
  document.addEventListener('visibilitychange', sync);
  reducedQuery?.addEventListener?.('change', () => {
    if (running) {
      running.stop();
      running = null;
    }
    sync();
  });
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting;
      sync();
    }).observe(slot);
  }

  // --- data in ------------------------------------------------------------------------------
  function push(msg) {
    const r = feed.push(msg);
    if (!r.ok) {
      if (badMessages++ % 100 === 0) console.warn('[face] ignored message:', r.error);
      return r;
    }
    renderMode(feed.mode()); // the header badge updates even while collapsed
    clearTimeout(flipTimer);
    flipTimer = setTimeout(() => renderMode(feed.mode()), LIVE_TIMEOUT_MS + 50);
    return r;
  }
  target.addEventListener('meridian:face', (e) => push(e.detail));

  // --- commands (buttons only call these) ---------------------------------------------------
  commands.register(
    'toggle_face_panel',
    ({ open } = {}) => {
      expanded = typeof open === 'boolean' ? open : !expanded;
      $('#face-toggle').setAttribute('aria-expanded', String(expanded));
      $('#face-body').hidden = !expanded;
      sync();
    },
    { label: 'Show / hide face tracking', args: { open: 'optional true/false' } },
  );
  commands.register(
    'toggle_face_demo',
    ({ on } = {}) => {
      feed.forceDemo(typeof on === 'boolean' ? on : !feed.isForced());
      $('#face-demo').setAttribute('aria-pressed', String(feed.isForced()));
      renderMode(feed.mode());
      if (running) frame();
    },
    { label: 'Simulated face on / auto', args: { on: 'optional true/false' } },
  );
  $('#face-toggle').addEventListener('click', () => commands.run('toggle_face_panel', {}, 'ui'));
  $('#face-demo').addEventListener('click', () => commands.run('toggle_face_demo', {}, 'ui'));

  // --- public API (meridian.face) -----------------------------------------------------------
  function stopReplay() {
    clearInterval(replayTimer);
    replayTimer = 0;
  }
  const api = {
    /** Feed one `face` message directly (same validation as the bridge). */
    feed: push,
    /** Gaze for the dot (U9): viewport pixels; null = no gaze. */
    setGaze: (g) => feed.setGaze(g),
    /** Post recorded frames through the real bridge, `fps` per second. Resolves when done. */
    replay(frames, { fps = 30, loop = false } = {}) {
      stopReplay();
      const list = Array.isArray(frames) ? frames : frames?.frames ?? [];
      if (!list.length) return Promise.resolve(0);
      let i = 0;
      return new Promise((resolve) => {
        const send = () => {
          if (i >= list.length) {
            if (!loop) {
              stopReplay();
              resolve(list.length);
              return;
            }
            i = 0;
          }
          target.postMessage({ ...list[i++], type: 'face' }, target.location.origin);
        };
        send();
        replayTimer = setInterval(send, 1000 / fps);
      });
    },
    stopReplay,
    mode: () => feed.mode(),
    snapshot: () => ({
      mode: feed.mode(),
      expanded,
      forced: feed.isForced(),
      running: Boolean(running),
      frames: feed.count(),
      phase: snap.phase,
      ear: snap.face?.ear ?? null,
      mar: snap.face?.mar ?? null,
      pose: snap.face?.pose ?? null,
      computed: snap.face?.computed ?? null,
      flags: snap.flags,
      gaze: snap.gaze,
    }),
    element: slot,
  };
  if (target.meridian) target.meridian.face = api;
  sync();
  return api;
}
