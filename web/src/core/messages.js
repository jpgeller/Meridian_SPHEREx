// window.postMessage -> commands. This is the contract with the eye-tracking module
// (see the spec, "Contract between the eye-tracking module and the app"):
//
//   { type: 'command', name: 'zoom_in' }
//   { type: 'command', name: 'set_band', args: { band: 72 } }
//   { type: 'gaze', x, y, confidence, t }   -> re-emitted as a `meridian:gaze` event for the
//                                             gaze adapter (web/src/input/gaze.js); x, y in CSS px
//   app -> tracker: { type: 'targets', items: [{ id, label, x, y, w, h }] } whenever the
//                   buttons on screen change, so the tracker can snap to them
//   { type: 'list_commands' }               -> replies { type: 'commands', items: [...] }
//
// Only messages from allowed origins are accepted. By default: this page's own origin and
// localhost (the tracker running on the same machine). Add others with `allowedOrigins`.

const DEFAULT_ALLOWED = [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

export function startMessages(commands, { allowedOrigins = [], target = window } = {}) {
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
      case 'gaze': {
        if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
        // `reply` lets the gaze adapter send the on-screen targets back to this tracker.
        const reply = (data) => e.source?.postMessage?.(data, { targetOrigin: e.origin });
        target.dispatchEvent(new CustomEvent('meridian:gaze', { detail: { ...msg, reply } }));
        break;
      }
      case 'list_commands':
        e.source?.postMessage?.({ type: 'commands', items: commands.list() }, { targetOrigin: e.origin });
        break;
      default:
        break;
    }
  };
  target.addEventListener('message', onMessage);
  return () => target.removeEventListener('message', onMessage);
}
