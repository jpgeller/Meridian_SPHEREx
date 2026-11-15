// Gaze over a local WebSocket: lets a native eye tracker (Yassin's Python tracker, gaze_tracker/) feed
// Meridian without a relay page. Opt-in: ?gaze_ws=8765 (or a full ws://localhost:PORT/ URL).
//
//   tracker (WebSocket server on localhost)  --JSON-->  this module  --> `meridian:gaze` event (gaze.js)
//                                            <--JSON--  { type: 'targets', items } and { type: 'hello', ... }
//
// Messages from the tracker (one JSON object per WebSocket text message, or an array of them):
//   { type: 'gaze', x, y, confidence?, t?, space?: 'screen' | 'viewport', screen_w?, screen_h? }
//   { type: 'face', landmarks, ... }   forwarded to the page's own bridge (face panel, EYE_TRACKING.md)
// `space: 'screen'` (the default) means physical screen pixels as the tracker sees them; send screen_w/h
// (e.g. 2560 x 1600) so the conversion is exact even with macOS "scaled" resolutions or Windows display
// scaling. Run the browser full-screen: then the page's top-left is the screen's top-left.
//
// The dwell, smoothing and snapping stay in the page (gazeCore.js): send calibrated raw points.

const ALLOWED_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** ?gaze_ws value -> a ws:// URL on this machine, or null. '8765' -> ws://localhost:8765/ */
export function gazeSocketUrl(param) {
  if (param == null || param === '') return null;
  const text = String(param).trim();
  if (/^\d{2,5}$/.test(text)) return `ws://localhost:${text}/`;
  try {
    const u = new URL(text);
    if (!/^wss?:$/.test(u.protocol) || !ALLOWED_HOST.test(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * A tracker sample -> page (viewport CSS) pixels, or null if unusable. Pure.
 * env: { screenW, screenH } the screen in CSS px (window.screen), dpr, and where the page's viewport
 * starts on that screen: { left, top } in CSS px (0, 0 when the browser is full-screen).
 */
export function toViewport(sample, env) {
  const x = Number(sample?.x);
  const y = Number(sample?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (sample.space === 'viewport') return { x, y };
  const sw = Number(sample.screen_w);
  const sh = Number(sample.screen_h);
  const sx = sw > 0 && env.screenW > 0 ? env.screenW / sw : 1 / (env.dpr || 1);
  const sy = sh > 0 && env.screenH > 0 ? env.screenH / sh : 1 / (env.dpr || 1);
  return { x: x * sx - (env.left || 0), y: y * sy - (env.top || 0) };
}

/** Where the viewport sits on the screen, in CSS px (browser chrome estimated from outer - inner size). */
export function viewportOnScreen(win = window) {
  const sideChrome = Math.max(0, (win.outerWidth - win.innerWidth) / 2);
  const topChrome = Math.max(0, win.outerHeight - win.innerHeight - sideChrome);
  return {
    screenW: win.screen?.width ?? 0,
    screenH: win.screen?.height ?? 0,
    dpr: win.devicePixelRatio || 1,
    left: (win.screenX || 0) + sideChrome,
    top: (win.screenY || 0) + topChrome,
  };
}

/**
 * Connect (and keep reconnecting) to the tracker. Returns { close, status } or null when not asked for.
 * @param {string} param   the ?gaze_ws value
 * @param {Function} getInput  () => current input mode (for the hello message)
 */
export function startGazeSocket(param, { getInput = () => null, win = window, WS = win.WebSocket } = {}) {
  const url = gazeSocketUrl(param);
  if (!url) {
    if (param) console.warn('[gaze-ws] ignored: only ws://localhost (or 127.0.0.1) is allowed:', param);
    return null;
  }
  let ws = null;
  let state = 'connecting';
  let retryMs = 1000;
  let closed = false;
  let samples = 0;
  const chip = makeChip(win.document);

  const setState = (s) => {
    state = s;
    if (chip) {
      chip.dataset.state = s;
      chip.textContent = s === 'live' ? 'Eye tracker connected' : s === 'open' ? 'Eye tracker: waiting for gaze…' : 'Eye tracker: connecting…';
    }
  };
  const send = (data) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(data));
  };

  function handle(msg) {
    if (Array.isArray(msg)) return msg.forEach(handle);
    if (!msg || typeof msg !== 'object') return;
    const type = msg.type ?? 'gaze';
    if (type === 'gaze') {
      const p = toViewport(msg, viewportOnScreen(win));
      if (!p) return;
      const confidence = Number.isFinite(Number(msg.confidence)) ? Number(msg.confidence) : 1;
      samples++;
      if (state !== 'live') setState('live');
      win.dispatchEvent(
        new CustomEvent('meridian:gaze', { detail: { x: p.x, y: p.y, t: Number(msg.t) || null, confidence, reply: send, source: send } }),
      );
    } else if (type === 'face' || type === 'command' || type === 'list_commands' || type === 'get_state') {
      // the page's own bridge validates these (the page is an allowed sender of itself)
      win.postMessage(msg, win.location.origin);
    }
  }

  function connect() {
    if (closed) return;
    setState('connecting');
    try {
      ws = new WS(url);
    } catch (err) {
      console.warn('[gaze-ws]', err);
      return retry();
    }
    ws.onopen = () => {
      retryMs = 1000;
      setState('open');
      const v = viewportOnScreen(win);
      send({ type: 'hello', app: 'meridian', input: getInput(), viewport: { w: win.innerWidth, h: win.innerHeight, ...v } });
    };
    ws.onmessage = (e) => {
      try {
        handle(JSON.parse(e.data));
      } catch {
        /* not JSON: ignore */
      }
    };
    ws.onclose = () => retry();
    ws.onerror = () => {}; // onclose follows
  }
  function retry() {
    ws = null;
    if (closed) return;
    setState('connecting');
    win.setTimeout(connect, retryMs);
    retryMs = Math.min(5000, retryMs * 1.6);
  }
  connect();
  return {
    status: () => ({ url, state, samples }),
    close() {
      closed = true;
      ws?.close();
      chip?.remove();
    },
  };
}

// A small, non-clickable note at the bottom (inside the 6% edges) so the person running the demo can
// see the link is up.
function makeChip(doc) {
  if (!doc?.body) return null;
  const el = doc.createElement('div');
  el.className = 'gaze-ws-chip';
  el.setAttribute('role', 'status');
  doc.body.append(el);
  return el;
}
