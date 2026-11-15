// window.postMessage -> commands. The hook for external controllers (the eye-tracking
// integration by Yassin's team, an AI guide...); see docs/EYE_TRACKING.md:
//
//   { type: 'command', name: 'zoom_in' }
//   { type: 'command', name: 'set_band', args: { band: 72 } }
//   { type: 'list_commands' }               -> replies { type: 'commands', items: [...] }
//   { type: 'world2pix', id, points: [{ ra, dec }, ...] }
//        -> { type: 'world2pix_result', id, points: [{ x, y, pageX, pageY, inView } | null, ...] }
//   { type: 'pix2world', id, points: [{ x, y }, ...] } -> { type: 'pix2world_result', id, points: [{ ra, dec } | null] }
//   { type: 'get_state', id }               -> { type: 'state', id, state: { ra, dec, fov, view, ... } }
//   { type: 'face', landmarks: [[x, y] x 68], ear?: [l, r], mar?, pose?: { yaw, pitch, roll }, confidence? }
//        -> no reply; re-sent in the page as the window event `meridian:face` (ui/facePanel.js validates it)
//   { type: 'gaze', x, y, t?, confidence? }  viewport px, ~30 per second (UI plan U9)
//        -> re-sent as the window event `meridian:gaze` { x, y, t, confidence, reply, source } for
//           input/gaze.js, which answers this sender with { type: 'targets', items: [{ id, x, y, w, h, kind, label? }] }
//           (throttled, when the list changes). What gaze may do depends on the input mode (state.input).
// RA/Dec are ICRS degrees; x, y are pixels inside the sky view (sky/skyCoords.js). `id` is echoed back.
//
// Only messages from allowed origins are accepted. By default: this page's own origin and
// localhost (the tracker running on the same machine). Add others with `allowedOrigins`.

const DEFAULT_ALLOWED = [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

export function startMessages(
  commands,
  { allowedOrigins = [], target = window, world2pix = () => null, pix2world = () => null, getState = () => ({}) } = {},
) {
  const allowed = [...DEFAULT_ALLOWED, ...allowedOrigins];
  const isAllowed = (origin) =>
    origin === target.location.origin ||
    allowed.some((a) => (a instanceof RegExp ? a.test(origin) : a === origin));

  const onMessage = (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (!isAllowed(e.origin)) {
      console.warn('[messages] ignored message from', e.origin);
      return;
    }
    switch (msg.type) {
      case 'command': {
        if (typeof msg.name !== 'string') return;
        const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
        const result = commands.run(msg.name, args, 'message');
        const reply = (r) =>
          e.source?.postMessage?.(
            { type: 'command_result', name: msg.name, ok: r.ok, ...(r.error ? { error: r.error } : {}) },
            { targetOrigin: e.origin },
          );
        // Async commands (fly_to) answer when they finish; a Promise cannot be posted.
        if (result.pending) result.value.then(() => reply({ ok: true }), (err) => reply({ ok: false, error: String(err?.message ?? err) }));
        else reply(result);
        break;
      }
      case 'list_commands':
        e.source?.postMessage?.({ type: 'commands', items: commands.list() }, { targetOrigin: e.origin });
        break;
      case 'world2pix':
      case 'pix2world': {
        const pts = Array.isArray(msg.points) ? msg.points.slice(0, 5000) : [msg];
        const fn = msg.type === 'world2pix' ? (p) => world2pix(Number(p?.ra), Number(p?.dec)) : (p) => pix2world(Number(p?.x), Number(p?.y));
        e.source?.postMessage?.({ type: `${msg.type}_result`, id: msg.id ?? null, points: pts.map(fn) }, { targetOrigin: e.origin });
        break;
      }
      case 'gaze': {
        if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
        const source = e.source ?? null;
        const reply = (data) => source?.postMessage?.(data, { targetOrigin: e.origin });
        const confidence = Number.isFinite(msg.confidence) ? msg.confidence : 1;
        target.dispatchEvent?.(
          new CustomEvent('meridian:gaze', { detail: { x: msg.x, y: msg.y, t: Number(msg.t) || null, confidence, reply, source } }),
        );
        break;
      }
      case 'face':
        target.dispatchEvent?.(new CustomEvent('meridian:face', { detail: msg }));
        break;
      case 'get_state':
        e.source?.postMessage?.({ type: 'state', id: msg.id ?? null, state: getState() }, { targetOrigin: e.origin });
        break;
      default:
        break;
    }
  };
  target.addEventListener('message', onMessage);
  return () => target.removeEventListener('message', onMessage);
}
