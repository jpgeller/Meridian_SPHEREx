// Guide script runner (UI plan, U5): plays a script step by step through the pop-up and the overlay.
//
//   script = [ { say: 'text', actions?: Action[], answers?: [...], target?: id }, ... ]
//   Action = { point: id, label? } | { circle: id } | { highlight: id } | { trail: [idFrom, idTo] }
//          | { cmd: name, args?: {...} }        -> run(name, args, 'guide')
//
//   runScript(steps, { trigger?, target? }) -> Promise<'done'|'closed'|'interrupted'|'stopped'|'replaced'|'empty'>
//        Shows a step, then runs its actions (so the pointer flies from the card), waits for an
//        answer, then the next step. 'close' (or Esc) ends it ('closed'); any successful command
//        the person runs (same rule as the overlay's auto-clear) ends it at once ('interrupted') and
//        dismisses the card. stop() -> 'stopped'; a newer runScript -> 'replaced' (also when someone
//        else calls guide.say over our card). Nothing valid to show -> 'empty'.
//   isRunning()  stop()
//
// Whitelist: an action's command must be in commands.list() (and not a stub); its args must be
// named in that command's own arg spec, and every value that maps to a state field must survive
// the store's sanitize() (the same validation every command's state change goes through).
// Anything else is dropped with a console log. A step keeps its text even if all its actions are
// dropped; a step without text is dropped. Dragging or zooming by hand is not a command, so it does
// not end the script: the marks follow the sky (U3).

import { QUIET_SOURCES } from './overlay.js';

export const MAX_STEPS = 6;
export const MAX_ACTIONS = 6;
export const CMD_TIMEOUT_MS = 10000; // an async command (fly_to by name) is awaited at most this long
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
const MAX_TEXT = 200; // free-text args (fly_to target, preset id)

// Command arg -> the state patch whose sanitize() decides whether the value is valid.
const ARG_STATE = {
  band: (v) => ({ band: v }),
  mode: (v) => ({ mode: v }),
  rgb: (v) => ({ rgb: v }),
  formula: (v) => ({ formula: v }),
  color: (v) => ({ color: v }),
  mix: (v) => ({ mix: v }),
  proj: (v) => ({ proj: v }),
  compare: (v) => ({ compare: v }),
  op: (v) => ({ op: v }),
  t: (v) => ({ t: v }),
  fov: (v) => ({ fov: v }),
  ra: (v) => ({ ra: v }),
  dec: (v) => ({ dec: v }),
  layer: (v) => ({ layers: [v] }),
  index: (v) => ({ t: [v] }),
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isPrimitive = (v) =>
  (typeof v === 'string' && v.trim() !== '' && v.length <= MAX_TEXT) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

/**
 * Check one action. -> { ok: true, action } (a clean copy) | { ok: false, reason }
 * @param {Object} o
 * @param {Array} o.commands  commands.list()
 * @param {Function} o.sanitize  state.js sanitize(patch, current)
 * @param {Object} [o.state]  current state (sanitize uses it for band direction)
 */
export function validateAction(action, { commands, sanitize, state }) {
  if (!isObj(action)) return { ok: false, reason: 'not an object' };
  const kinds = ['point', 'circle', 'highlight', 'trail', 'cmd'].filter((k) => k in action);
  if (kinds.length !== 1) return { ok: false, reason: 'unknown action shape' };
  const [kind] = kinds;
  if (kind === 'trail') {
    const t = action.trail;
    return Array.isArray(t) && t.length === 2 && t.every(isId) ? { ok: true, action: { trail: [...t] } } : { ok: false, reason: 'bad trail ids' };
  }
  if (kind !== 'cmd') {
    if (!isId(action[kind])) return { ok: false, reason: `bad ${kind} id` };
    const out = { [kind]: action[kind] };
    if (kind === 'point' && typeof action.label === 'string' && action.label.trim()) out.label = action.label.trim().slice(0, 80);
    return { ok: true, action: out };
  }
  const name = action.cmd;
  const spec = typeof name === 'string' ? commands.find((c) => c.name === name) : null;
  if (!spec) return { ok: false, reason: `command not on the whitelist: ${name}` };
  if (spec.stub) return { ok: false, reason: `command not implemented yet: ${name}` };
  const args = action.args ?? {};
  if (!isObj(args)) return { ok: false, reason: `${name}: args must be an object` };
  const allowed = Object.keys(spec.args ?? {});
  for (const [k, v] of Object.entries(args)) {
    if (!allowed.includes(k)) return { ok: false, reason: `${name}: unknown arg ${k}` };
    const toPatch = ARG_STATE[k];
    if (toPatch) {
      const patch = toPatch(v);
      const key = Object.keys(patch)[0];
      if (!(key in sanitize(patch, state))) return { ok: false, reason: `${name}: invalid ${k}` };
    } else if (!isPrimitive(v)) return { ok: false, reason: `${name}: invalid ${k}` };
  }
  return { ok: true, action: { cmd: name, args: structuredClone(args) } };
}

/**
 * Clean a whole script. Accepts an array of steps or { steps }. Logs each drop through `log`.
 * -> [{ say, actions, answers?, target? }]
 */
export function validateScript(script, { commands, sanitize, state, log = (...a) => console.warn('[guide]', ...a) }) {
  const steps = Array.isArray(script) ? script : Array.isArray(script?.steps) ? script.steps : null;
  if (!steps) {
    log('script is not a list of steps', script);
    return [];
  }
  const out = [];
  steps.forEach((step, i) => {
    const say = typeof step === 'string' ? step : step?.say;
    if (typeof say !== 'string' || !say.trim()) {
      log(`step ${i + 1} dropped: no text`);
      return;
    }
    const actions = [];
    const raw = Array.isArray(step?.actions) ? step.actions : step?.actions == null ? [] : (log(`step ${i + 1}: actions is not a list`), []);
    raw.forEach((a, j) => {
      const r = validateAction(a, { commands, sanitize, state });
      if (!r.ok) log(`step ${i + 1}, action ${j + 1} dropped: ${r.reason}`, a);
      else if (actions.length >= MAX_ACTIONS) log(`step ${i + 1}, action ${j + 1} dropped: too many actions`);
      else actions.push(r.action);
    });
    const clean = { say: say.trim(), actions };
    if (Array.isArray(step?.answers)) clean.answers = step.answers.slice(0, 3);
    if (isId(step?.target)) clean.target = step.target;
    out.push(clean);
  });
  if (out.length > MAX_STEPS) log(`script cut to ${MAX_STEPS} steps`);
  return out.slice(0, MAX_STEPS);
}

// Default answers: a step in the middle offers "Show me more" / "Close"; the last one "Got it".
export const defaultAnswers = (isLast) => (isLast ? ['got_it'] : ['more', 'close']);

/**
 * @param {Object} o
 * @param {Function} o.say        popup.say(step) -> Promise<answer id>
 * @param {Function} o.dismiss    popup.dismiss(reason)
 * @param {Object}   o.overlay    { pointAt, circle, highlight, trail, clear }
 * @param {Function} o.run        commands.run(name, args, source)
 * @param {Function} o.list       commands.list
 * @param {Function} o.sanitize   state.js sanitize
 * @param {Function} [o.getState]
 * @param {EventTarget} [o.events]  where `meridian:command` arrives
 */
export function createRunner({ say, dismiss, overlay, run, list, sanitize, getState = () => undefined, events, log }) {
  let current = null; // { end(outcome) }

  function stop(outcome = 'stopped') {
    current?.end(outcome);
  }

  async function runActions(actions, alive) {
    for (const a of actions) {
      if (!alive()) return;
      try {
        if ('point' in a) overlay.pointAt(a.point, a.label);
        else if ('circle' in a) overlay.circle(a.circle);
        else if ('highlight' in a) overlay.highlight(a.highlight);
        else if ('trail' in a) overlay.trail(a.trail[0], a.trail[1]);
        else {
          const r = run(a.cmd, a.args, 'guide');
          if (r?.pending) {
            // wait for e.g. a fly_to so a circle after it lands on the right sky
            let timer;
            await Promise.race([r.value.catch(() => {}), new Promise((res) => (timer = setTimeout(res, CMD_TIMEOUT_MS)))]);
            clearTimeout(timer);
          }
        }
      } catch (err) {
        console.warn('[guide] action failed', a, err);
      }
    }
  }

  function runScript(script, { trigger, target } = {}) {
    stop('replaced');
    const steps = validateScript(script, { commands: list(), sanitize, state: getState(), log });
    if (!steps.length) return Promise.resolve('empty');

    return new Promise((resolve) => {
      let ended = false;
      let wake = null; // resolves the current wait early when the script ends
      const me = {
        trigger,
        target,
        end(outcome) {
          if (ended) return;
          ended = true;
          if (current === me) current = null;
          events?.removeEventListener?.('meridian:command', onCommand);
          overlay.clear();
          if (outcome === 'interrupted' || outcome === 'stopped') dismiss?.('close');
          wake?.();
          resolve(outcome);
        },
      };
      const alive = () => !ended;
      // the person did something: the script belongs to a view that is gone
      const onCommand = (e) => {
        const d = e.detail;
        if (d?.ok && !QUIET_SOURCES.has(d.source)) me.end('interrupted');
      };
      current = me;
      events?.addEventListener?.('meridian:command', onCommand);

      (async () => {
        for (let i = 0; i < steps.length && alive(); i++) {
          const step = steps[i];
          const isLast = i === steps.length - 1;
          overlay.clear();
          // the card avoids covering the thing the step points at
          const mark = step.actions.find((a) => a.point || a.circle || a.highlight);
          const answer = say({
            say: step.say,
            answers: step.answers ?? defaultAnswers(isLast),
            target: step.target ?? mark?.point ?? mark?.circle ?? mark?.highlight,
          });
          await runActions(step.actions, alive);
          if (!alive()) return;
          const id = await Promise.race([answer, new Promise((res) => (wake = res))]);
          if (!alive()) return;
          if (id === 'close' || id === 'dismissed') return me.end('closed');
          if (id === 'replaced') return me.end('replaced');
        }
        me.end('done');
      })().catch((err) => {
        console.error('[guide] script failed', err);
        me.end('stopped');
      });
    });
  }

  return { runScript, stop, isRunning: () => current !== null };
}
