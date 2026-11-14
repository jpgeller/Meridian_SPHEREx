// The command bus. Every user action is a named command. Buttons, keys, postMessage
// (eye tracking) and the AI guide all call run(); none of them touch modules directly.
//
// Each run() also dispatches `meridian:command` on `target` (window in the browser) with
// { name, args, source, ok }, so the eye tracker and the guide can listen and react.

/**
 * @typedef {Object} CommandMeta
 * @property {string} label        Human-readable name (buttons, help, screen readers)
 * @property {string[]} [keys]     KeyboardEvent.key values that trigger it (core/keys.js)
 * @property {Object} [args]       Argument names -> short description (for the AI guide)
 * @property {boolean} [stub]      Not implemented yet; logs instead of acting
 */

export function createCommands({ target = globalThis.window } = {}) {
  /** @type {Map<string, {fn: Function, meta: CommandMeta}>} */
  const registry = new Map();

  function register(name, fn, meta = {}) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`bad command name: ${name}`);
    registry.set(name, { fn, meta: { label: name, keys: [], args: {}, ...meta } });
  }

  function run(name, args = {}, source = 'code') {
    const entry = registry.get(name);
    if (!entry) {
      console.warn(`[commands] unknown command: ${name}`);
      return { ok: false, error: 'unknown command' };
    }
    let result;
    try {
      result = { ok: true, value: entry.fn(args ?? {}, { source }) };
    } catch (err) {
      console.error(`[commands] ${name} failed`, err);
      result = { ok: false, error: String(err?.message ?? err) };
    }
    target?.dispatchEvent?.(
      new CustomEvent('meridian:command', { detail: { name, args, source, ok: result.ok } }),
    );
    return result;
  }

  /** Public description of every command (for help, the AI guide's tool list, the eye tracker). */
  function list() {
    return [...registry].map(([name, { meta }]) => ({ name, ...meta }));
  }

  return { register, run, list, has: (name) => registry.has(name) };
}
