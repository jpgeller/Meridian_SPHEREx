// Meridian with eye tracking through the browser's camera.
//
// This page wraps Meridian (unchanged, in a full-window same-origin iframe) and adds:
//   camera (getUserMedia) -> JPEG frames -> the gaze engine (gaze_tracker/gaze_server.py, over ws/wss)
//   engine -> gaze points -> Meridian's documented postMessage contract ({ type: 'gaze' } and { type: 'face' },
//   docs/EYE_TRACKING.md). Meridian answers with { type: 'targets' }: its buttons, used for the button layer.
// The calibration (100 dots, then a dot on each button, twice) runs here, over Meridian, in page pixels; the
// engine records and fits it. Nothing in Meridian's own code changes.
//
// URL: /eye.html?engine=wss://<tunnel>  (also &mode=gaze|assist, default gaze; other params go to Meridian)

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MODE = ['gaze', 'assist'].includes(params.get('mode')) ? params.get('mode') : 'gaze';
const STORE_KEY = 'meridian.eye.engine';
// The team's gaze engine (Yassin's laptop, through a fixed free ngrok address). Visitors need nothing else:
// they press Start and allow the camera. ?engine=... still overrides it (tests, another engine).
const DEFAULT_ENGINE = 'wss://crouch-bright-large.ngrok-free.dev';
const MAX_W = 1280; // frames are sent at up to 1280 px wide: the model was trained on 1280 x 720 webcam frames
const MIN_FRAME_MS = 66; // at most ~15 frames per second
const DOT_MS = 1500; // the engine ignores the first 0.6 s of each dot (eyes landing), records the rest
const INTRO_MS = 5000;
const RESULT_MS = 3500;
const LAYER1_DOTS = 100;
const LOOKS_PER_BUTTON = 2;

// ---------------------------------------------------------------------------------------------- Meridian
const frame = $('meridian');
const pass = new URLSearchParams(params);
['engine', 'mode', 'gaze_ws'].forEach((k) => pass.delete(k));
frame.src = '/' + (pass.toString() ? `?${pass}` : '');
let targets = [];

const toMeridian = (msg) => frame.contentWindow?.postMessage(msg, location.origin);

window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow || e.origin !== location.origin) return;
  if (e.data?.type === 'targets' && Array.isArray(e.data.items)) targets = e.data.items;
});

// Meridian's own "Calibrate" button expects its local-tracker link; here it should run this page's calibration.
frame.addEventListener('load', () => {
  const tryHook = (n = 0) => {
    const m = frame.contentWindow?.meridian;
    // wait for Meridian's own 'recalibrate' (registered late in its start-up), then replace it
    if (m?.commands?.has?.('recalibrate')) {
      m.commands.register('recalibrate', () => (engine.ready ? (startCalibration(), true) : false), {
        label: 'Calibrate the eye tracker again',
        eyePage: true,
      });
    } else if (n < 150) setTimeout(() => tryHook(n + 1), 200);
  };
  tryHook();
});

// ---------------------------------------------------------------------------------------------- engine URL
function engineUrl(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `wss://${t}`);
    if (u.protocol === 'https:') u.protocol = 'wss:';
    if (u.protocol === 'http:') u.protocol = 'ws:';
    if (!/^wss?:$/.test(u.protocol)) return null;
    // an https page may only open wss:// (except to this machine)
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (!local && !u.hostname.includes('.')) return null; // a typo, not an address
    if (location.protocol === 'https:' && u.protocol === 'ws:' && !local) return null;
    return u.href;
  } catch {
    return null;
  }
}
const input = $('engine-url');
input.value = params.get('engine') || DEFAULT_ENGINE || localStorage.getItem(STORE_KEY) || '';
// With a known engine the address field stays out of the way: one button, then the camera prompt.
const engineFields = [input, $('engine-hint'), document.querySelector('label[for="engine-url"]')];
if (input.value) {
  engineFields.forEach((el) => el && (el.hidden = true));
  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'link';
  change.textContent = 'Use a different engine';
  change.addEventListener('click', () => {
    engineFields.forEach((el) => el && (el.hidden = false));
    change.remove();
    input.focus();
  });
  $('consent-error').after(change);
} else {
  $('engine-hint').textContent = 'Paste the address the engine owner gave you (it starts with wss://).';
}

// ---------------------------------------------------------------------------------------------- status chip
const chip = $('chip');
let chipTimer = 0;
function status(text, sticky = false) {
  chip.hidden = false;
  chip.classList.add('show');
  $('chip-text').textContent = text;
  clearTimeout(chipTimer);
  if (!sticky) chipTimer = setTimeout(() => chip.classList.remove('show'), 6000);
}
document.addEventListener('mousemove', () => {
  if (!chip.hidden) {
    chip.classList.add('show');
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => chip.classList.remove('show'), 4000);
  }
});

// ---------------------------------------------------------------------------------------------- camera + engine
const video = $('cam');
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: false });
const engine = { ws: null, url: null, ready: false, inFlight: false, lastSend: 0, sent: 0, fpsT: 0, fps: 0, stopped: false, retry: 1000, calib: {} };
let stream = null;

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

function connect() {
  if (engine.stopped) return;
  const ws = new WebSocket(engine.url);
  ws.binaryType = 'arraybuffer';
  engine.ws = ws;
  engine.ready = false;
  engine.inFlight = false;
  status('Eye tracking: connecting to the engine…', true);
  ws.onopen = () => {
    engine.retry = 1000;
    ws.send(JSON.stringify({ type: 'hello', viewport: { w: innerWidth, h: innerHeight } }));
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(msg);
  };
  ws.onclose = (e) => {
    engine.ready = false;
    if (engine.stopped) return;
    if (e.code === 4003) return fail('The engine refused this website. Its owner must start it with --allow-origin ' + location.origin);
    if (e.code === 4008) return status('The engine is busy with other visitors. Retrying…', true), retry();
    status('Eye tracking is offline right now (the engine is not running). Retrying… Meridian works with mouse and keyboard meanwhile.', true);
    retry();
  };
  ws.onerror = () => {};
}
function retry() {
  setTimeout(connect, engine.retry);
  engine.retry = Math.min(engine.retry * 2, 15000);
}
const sendJson = (m) => engine.ws?.readyState === 1 && engine.ws.send(JSON.stringify(m));

let askedOnce = false;
function handle(msg) {
  switch (msg.type) {
    case 'ready':
      engine.ready = true;
      status(`Eye tracking: connected (${msg.device === 'cuda' ? 'GPU' : msg.device})`, true);
      pump();
      if (!askedOnce) {
        askedOnce = true;
        openAsk();
      } else if (!engine.calib.stabiliser) {
        status('Eye tracking: reconnected. The calibration was lost - press Recalibrate.', true);
      }
      break;
    case 'gaze':
      engine.inFlight = false;
      tickFps();
      if (msg.ok) toMeridian({ type: 'gaze', x: msg.x, y: msg.y, confidence: msg.confidence ?? 0.9, t: performance.now() });
      else toMeridian({ type: 'gaze', x: 0, y: 0, confidence: 0, t: performance.now() });
      pump();
      break;
    case 'face':
      toMeridian(msg);
      break;
    case 'state':
      engine.calib = msg.calibration || {};
      break;
    case 'calib_result':
      resultWaiter?.(msg);
      break;
    case 'calibration_reset':
      engine.calib = {};
      status('The page size changed, so the calibration was reset. Press Recalibrate (best in full screen).', true);
      break;
    case 'busy':
      status('The engine is busy with other visitors. Retrying…', true);
      break;
    case 'error':
      console.warn('[eye] engine:', msg.error);
      break;
    default:
      break;
  }
}

function tickFps() {
  const now = performance.now();
  engine.sent++;
  if (now - engine.fpsT > 2000) {
    engine.fps = (engine.sent * 1000) / (now - engine.fpsT || 1);
    engine.sent = 0;
    engine.fpsT = now;
    if (!job) {
      const c = engine.calib.stabiliser ? 'calibrated' : 'not calibrated';
      $('chip-text').textContent = `Eye tracking: live · ${engine.fps.toFixed(0)} fps · ${c}`;
    }
  }
}

// one frame in flight at a time: no queue builds up, so the gaze never lags behind
function pump() {
  if (!engine.ready || engine.inFlight || engine.stopped || document.hidden || !video.videoWidth) return;
  const wait = MIN_FRAME_MS - (performance.now() - engine.lastSend);
  if (wait > 0) return void setTimeout(pump, wait);
  const s = Math.min(1, MAX_W / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * s);
  canvas.height = Math.round(video.videoHeight * s);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height); // unmirrored, as the model was trained
  engine.inFlight = true;
  engine.lastSend = performance.now();
  canvas.toBlob(
    (blob) => {
      if (!blob || engine.ws?.readyState !== 1) return void (engine.inFlight = false);
      engine.ws.send(blob);
      // safety net: if a reply is lost, carry on
      const mine = engine.lastSend;
      setTimeout(() => {
        if (engine.inFlight && engine.lastSend === mine) {
          engine.inFlight = false;
          pump();
        }
      }, 2000);
    },
    'image/jpeg',
    0.8,
  );
}
document.addEventListener('visibilitychange', () => pump());
addEventListener('resize', () => {
  // a calibration belongs to one page size: a run in progress stops, the engine resets a finished one
  if (job) {
    stopCalibration();
    msgEl.textContent = 'The page size changed (full screen left?), so the calibration stopped. Press Recalibrate.';
  }
  sendJson({ type: 'viewport', w: innerWidth, h: innerHeight });
});

function fail(text) {
  $('consent').hidden = false;
  $('consent-error').textContent = text;
  chip.hidden = true;
}

function stopAll() {
  engine.stopped = true;
  engine.ws?.close();
  stream?.getTracks().forEach((t) => t.stop());
  toMeridian({ type: 'gaze', x: 0, y: 0, confidence: 0 });
  toMeridian({ type: 'command', name: 'set_input_mode', args: { mode: 'mouse' } });
  if (job) stopCalibration();
  calib.hidden = true;
  $('ask').hidden = true;
  chip.hidden = true;
  // back to the start screen: fix the engine address, start again, or continue without eye tracking
  $('consent').hidden = false;
  $('consent-error').textContent = 'Eye tracking stopped. The camera is off.';
}

$('start').addEventListener('click', async () => {
  $('consent-error').textContent = '';
  const url = engineUrl(input.value);
  if (!url) {
    $('consent-error').textContent = 'Enter the engine address (wss://…). On an https site it must start with wss://.';
    input.focus();
    return;
  }
  localStorage.setItem(STORE_KEY, input.value.trim());
  try {
    await document.documentElement.requestFullscreen?.();
  } catch {
    /* full screen is best, not required */
  }
  try {
    await startCamera();
  } catch (err) {
    $('consent-error').textContent =
      err?.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow it in the address bar (camera icon) and try again.'
        : `The camera could not start (${err?.name || err}). Close other apps using it and try again.`;
    return;
  }
  $('consent').hidden = true;
  engine.url = url;
  engine.stopped = false;
  engine.retry = 1000;
  askedOnce = false;
  connect();
});
$('stop').addEventListener('click', stopAll);
$('recal').addEventListener('click', () => engine.ready && startCalibration());
if (!navigator.mediaDevices?.getUserMedia) {
  $('consent-error').textContent = 'This browser cannot use the camera here (it needs https). Use Chrome or Edge.';
}

// ---------------------------------------------------------------------------------------------- calibration
// Same dots as Meridian's own calibration (web/src/input/calibration.js) and Yassin's make_cal_dots.
function calibrationDots(n, seed = 0) {
  let s = seed + 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const cols = Math.ceil(Math.sqrt(n * 1.6));
  const rows = Math.ceil(n / cols);
  const pts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push([(c + 0.2 + 0.6 * rnd()) / cols, (r + 0.2 + 0.6 * rnd()) / rows]);
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }
  return pts.slice(0, n).map(([x, y]) => [0.04 + 0.92 * x, 0.04 + 0.92 * y]);
}
function buttonDots(items, looks = LOOKS_PER_BUTTON, seed = 1) {
  const centres = [];
  for (const b of items) {
    if (b.kind !== 'button' || b.w < 8 || b.h < 8) continue;
    const c = [b.x + b.w / 2, b.y + b.h / 2];
    if (c[0] < 0 || c[1] < 0 || c[0] > innerWidth || c[1] > innerHeight) continue;
    if (centres.some((q) => Math.hypot(q[0] - c[0], q[1] - c[1]) < 10)) continue;
    centres.push(c);
  }
  let s = seed + 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let look = 0; look < looks; look++) {
    const order = centres.map((c, id) => ({ id, c, look }));
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    out.push(...order);
  }
  return out.map((d) => ({ id: d.id, look: d.look, x: d.c[0], y: d.c[1] }));
}

const calib = $('calib');
const dotEl = $('dot');
const countEl = $('count');
const msgEl = $('calib-msg');
let job = null;
let runId = 0;
let resultWaiter = null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (r) =>
  r?.error
    ? r.error
    : r
      ? `error ${Math.round(r.error_without_px)} → ${Math.round(r.error_with_px)} px on dots it did not learn from${r.enabled ? '' : ' (no better: left off)'}`
      : '';

function openAsk() {
  $('ask').hidden = false;
  $('calibrate').focus();
}
$('calibrate').addEventListener('click', () => {
  $('ask').hidden = true;
  startCalibration();
});
$('skip').addEventListener('click', () => {
  $('ask').hidden = true;
  toMeridian({ type: 'command', name: 'set_input_mode', args: { mode: MODE } });
  status('Eye tracking: on, not calibrated (less precise). Recalibrate any time.', false);
});

function showDot(x, y, n, total) {
  dotEl.hidden = false;
  dotEl.style.left = `${x}px`;
  dotEl.style.top = `${y}px`;
  dotEl.classList.remove('go');
  void dotEl.offsetWidth;
  dotEl.classList.add('go');
  countEl.textContent = `${n} / ${total}`;
  countEl.style.left = `${x + 26}px`;
  countEl.style.top = `${y - 30}px`;
}

async function runLayer(layer, dots, intro, runNo) {
  const me = (job = { layer, run: runNo, stopped: false, paused: false });
  const over = () => me.stopped || runNo !== runId || engine.stopped;
  calib.hidden = false;
  calib.classList.toggle('buttons', layer === 'buttons');
  calib.focus();
  dotEl.hidden = true;
  countEl.textContent = '';
  msgEl.textContent = intro;
  await wait(INTRO_MS);
  if (over()) return null;
  msgEl.textContent = '';
  sendJson({ type: 'calib', action: 'start', layer });
  for (let i = 0; i < dots.length; i++) {
    while (me.paused && !over()) await wait(100);
    if (over()) return null;
    const d = dots[i];
    showDot(d.x, d.y, i + 1, dots.length);
    sendJson({ type: 'calib', action: 'dot', id: d.id, look: d.look ?? 0, x: d.x, y: d.y });
    await wait(DOT_MS);
  }
  dotEl.hidden = true;
  countEl.textContent = '';
  msgEl.textContent = 'Fitting…';
  const answer = new Promise((r) => (resultWaiter = (m) => m.layer === layer && r(m.report)));
  sendJson({ type: 'calib', action: 'end', layer });
  const report = await Promise.race([answer, wait(20000).then(() => ({ error: 'the engine did not answer' }))]);
  resultWaiter = null;
  return over() ? null : report;
}

async function startCalibration() {
  if (job) {
    job.stopped = true;
    sendJson({ type: 'calib', action: 'cancel' });
  }
  const runNo = ++runId;
  $('ask').hidden = true;
  toMeridian({ type: 'command', name: 'set_input_mode', args: { mode: 'mouse' } }); // nothing pressed meanwhile
  const W = innerWidth;
  const H = innerHeight;
  const dots1 = calibrationDots(LAYER1_DOTS).map(([x, y], id) => ({ id, x: x * W, y: y * H }));
  const r1 = await runLayer(
    'stabiliser',
    dots1,
    'Calibration 1 of 2: 100 dots, one at a time (about 2.5 minutes). Look straight at each dot. ' +
      'Between dots, move your head a little: turn, tilt, lean, closer or farther. Space pauses, Esc stops.',
    runNo,
  );
  if (!r1) return;
  msgEl.textContent = `Layer 1 (whole screen): ${fmt(r1)}`;
  await wait(RESULT_MS);
  if (runNo !== runId) return;
  const dots2 = buttonDots(targets);
  let r2 = null;
  if (new Set(dots2.map((d) => d.id)).size >= 3) {
    const n = new Set(dots2.map((d) => d.id)).size;
    r2 = await runLayer(
      'buttons',
      dots2,
      `Calibration 2 of 2: a dot on each of the ${n} buttons, twice (about ${Math.round((dots2.length * DOT_MS) / 60000 + 0.4)} min). Look at the dot on each button.`,
      runNo,
    );
    if (r2 === null) return;
  }
  finish(`Calibrated. Whole screen: ${fmt(r1)}.${r2 ? ` On the buttons: ${fmt(r2)}.` : ''}`, runNo);
}

function finish(text, runNo, { stopped = false } = {}) {
  if (runNo !== runId) return;
  job = null;
  calib.classList.remove('buttons');
  dotEl.hidden = true;
  countEl.textContent = '';
  msgEl.textContent = text;
  if (!stopped) toMeridian({ type: 'command', name: 'set_input_mode', args: { mode: MODE } });
  setTimeout(() => {
    if (!job) calib.hidden = true;
    frame.focus();
  }, RESULT_MS);
  status(stopped ? 'Calibration stopped: nothing changed.' : 'Eye tracking: calibrated and on.', false);
}

function stopCalibration() {
  if (!job) return;
  job.stopped = true;
  sendJson({ type: 'calib', action: 'cancel' });
  finish('Calibration stopped: nothing changed.', job.run, { stopped: true });
}
$('calib-stop').addEventListener('click', stopCalibration);
addEventListener(
  'keydown',
  (e) => {
    if (!job) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      stopCalibration();
    } else if (e.key === ' ') {
      e.preventDefault();
      job.paused = !job.paused;
      sendJson({ type: 'calib', action: job.paused ? 'pause' : 'resume' });
      msgEl.textContent = job.paused ? 'Paused: rest your eyes. Space continues.' : '';
    }
  },
  true,
);

// tests and debugging
window.meridianEye = { engine, engineUrl, calibrationDots, buttonDots, targets: () => targets, startCalibration, stopAll };
