// The command bus. Every user action is a named command. Buttons, keys, postMessage
// (eye tracking) and the AI guide all call run(); none of them touch modules directly.
//
// Each run() also dispatches `meridian:command` on `target` (window in the browser) with
// { name, args, source, ok, error? }, so the eye tracker and the guide can listen and react.
// Async commands return { ok: true, pending: true, value: Promise } and emit when settled;
// they also emit `meridian:command-start` (same detail, without ok) when they begin, so the
// guide can stay quiet while e.g. a fly_to is still looking up a name.
//
// actingAs(source, fn): every run() made while fn runs (synchronously) reports `source` instead of
// its own. The guide presses a real button with it (runner.js `click`): the button's own handler
// runs the command as usual, but the bus reports it as the guide's, not the person's. A personOnly
// command (e.g. the eye-control mode) refuses to run inside actingAs: only the person can press it.

/**
 * @typedef {Object} CommandMeta
 * @property {string} label        Human-readable name (buttons, help, screen readers)
 * @property {string[]} [keys]     KeyboardEvent.key values that trigger it (core/keys.js)
 * @property {Object} [args]       Argument names -> short description (for the AI guide)
 * @property {boolean} [stub]      Not implemented yet; logs instead of acting
 * @property {boolean} [personOnly] Only the person may run it (e.g. the eye-control mode); the AI guide never can
 */

export function createCommands({ target = globalThis.window } = {}) {
  /** @type {Map<string, {fn: Function, meta: CommandMeta}>} */
  const registry = new Map();
  let actor = null; // actingAs() source, while its fn runs

  function register(name, fn, meta = {}) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`bad command name: ${name}`);
    registry.set(name, { fn, meta: { label: name, keys: [], args: {}, ...meta } });
  }

  function run(name, args = {}, source = 'code') {
    if (actor) source = actor;
    const entry = registry.get(name);
    if (!entry) {
      console.warn(`[commands] unknown command: ${name}`);
      return { ok: false, error: 'unknown command' };
    }
    if (actor && entry.meta.personOnly) {
      console.warn(`[commands] only the person can run ${name} (asked by: ${actor})`);
      return { ok: false, error: `only the person can run ${name}` };
    }
    const emit = (ok, error) =>
      target?.dispatchEvent?.(
        new CustomEvent('meridian:command', {
          detail: { name, args, source, ok, ...(error ? { error } : {}) },
        }),
      );
    let value;
    try {
      value = entry.fn(args ?? {}, { source });
    } catch (err) {
      console.error(`[commands] ${name} failed`, err);
      const error = String(err?.message ?? err);
      emit(false, error);
      return { ok: false, error };
    }
    if (value && typeof value.then === 'function') {
      // Async command (e.g. fly_to with a name lookup): report when it settles.
      // `value` still rejects for callers that await it; the bus never leaves it unhandled.
      const settled = value.then(
        (v) => (emit(true), v),
        (err) => {
          console.error(`[commands] ${name} failed`, err);
          emit(false, String(err?.message ?? err));
          throw err;
        },
      );
      settled.catch(() => {});
      target?.dispatchEvent?.(new CustomEvent('meridian:command-start', { detail: { name, args, source } }));
      return { ok: true, pending: true, value: settled };
    }
    emit(true);
    return { ok: true, value };
  }

  /** Public description of every command (for help, the AI guide's tool list, the eye tracker). */
  function list() {
    return [...registry].map(([name, { meta }]) => ({ name, ...meta }));
  }

  function actingAs(source, fn) {
    const was = actor;
    actor = source;
    try {
      return fn();
    } finally {
      actor = was;
    }
  }

  return { register, run, list, actingAs, has: (name) => registry.has(name) };
}
