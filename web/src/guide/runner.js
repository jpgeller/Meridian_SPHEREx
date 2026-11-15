// Guide script runner (UI plan, U5): plays a script step by step through the pop-up and the overlay.
//
//   script = steps | { steps, end? }
//   step   = { say: 'text', title?, sub?, facts?: [[term, value]], ms?, actions?: Action[], answers?, target? }
//   end    = { title?, say?, answers: [...] }   the closing card ("Is that clear?" Got it · Show me again …)
//
//   Like wireframe v4: each step shows "i / n", Next and Stop, and moves on by itself after `ms`
//   (STEP_MS by default; the card's bar shows it, reading the card pauses it). Without an `end`, the
//   last step waits for "Got it". runScript resolves with the end card's answer id (e.g. 'again',
//   'example'), 'done' for "Got it" (or the last step), or one of the outcomes below.
//   Action = { point: id, label? } | { circle: id } | { highlight: id } | { trail: [idFrom, idTo] }
//          | { cmd: name, args?: {...} }        -> run(name, args, 'guide')
//          | { wait: 'frames' | 'sky' }   wait (at most WAIT_MS) for the time-lapse frames / the sky to be ready
//          | { click: id }   the pointer flies to a control (FLY_MS; reduced motion: no wait), presses it
//                            and calls el.click(): the button's own handler runs its command, reported
//                            as source 'guide' (commands.actingAs). Only a visible, enabled <button>
//                            (or a [data-guide] element with a button-like role); never the guide's own
//                            card, never a personOnly command. Ids: data-guide ids, or the gaze layer's
//                            preset:<id> / proj:<P> / color:<view>. Sky objects have no button: use cmd
//                            go_preset / fly_to. A command the press starts asynchronously is awaited
//                            (at most CMD_TIMEOUT_MS) before the next action.
//
//   runScript(steps, { trigger?, target? }) -> Promise<'done'|'closed'|'interrupted'|'stopped'|'replaced'|'empty'>
//        Shows a step, then runs its actions (so the pointer flies from the card), waits for an
//        answer, then the next step. 'close' (or Esc) ends it ('closed'); any successful command
//        the person runs (same rule as the overlay's auto-clear) ends it at once ('interrupted') and
//        dismisses the card. stop() -> 'stopped'; a newer runScript -> 'replaced' (also when someone
//        else calls guide.say over our card). Nothing valid to show -> 'empty'.
//   isRunning()  stop()
//
// Whitelist: an action's command must be in commands.list() (and not a stub, nor personOnly); its args must be
// named in that command's own arg spec, and every value that maps to a state field must survive
// the store's sanitize() (the same validation every command's state change goes through).
// Anything else is dropped with a console log. A step keeps its text even if all its actions are
// dropped; a step without text is dropped. Dragging or zooming by hand is not a command, so it does
// not end the script: the marks follow the sky (U3).

import { QUIET_SOURCES, FLY_MS } from './overlay.js';

export const MAX_STEPS = 6;
export const MAX_ACTIONS = 6;
export const CMD_TIMEOUT_MS = 10000; // an async command (fly_to by name) is awaited at most this long
export const PRESS_MS = 250;
export const STEP_MS = 7500; // a tour step moves on by itself after this long (wireframe v4)
export const WAIT_MS = 20000;
const WAITS = new Set(['frames', 'sky']);
const CONTINUE = new Set(['next', 'more', 'auto']); // how long a pressed control shows it was pressed
const CONTROL_ROLES = new Set(['button', 'radio', 'checkbox', 'switch', 'tab', 'menuitem', 'option']);
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

/**
 * Why the guide may not press `el` (a string), or null when it may: a <button>, or a [data-guide]
 * element with a button-like role; enabled; not inside the guide's own pop-up card.
 */
export function refuseClick(el) {
  if (!el || typeof el.click !== 'function') return 'no such control on screen';
  const tag = String(el.tagName ?? '').toLowerCase();
  const role = el.getAttribute?.('role');
  const control = tag === 'button' || (el.hasAttribute?.('data-guide') && CONTROL_ROLES.has(role));
  if (!control) return 'not a button';
  if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') return 'disabled';
  if (el.closest?.('[data-guide="guide-popup"]')) return "the guide's own card";
  return null;
}

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
  const kinds = ['point', 'circle', 'highlight', 'trail', 'cmd', 'click', 'wait'].filter((k) => k in action);
  if (kinds.length !== 1) return { ok: false, reason: 'unknown action shape' };
  const [kind] = kinds;
  if (kind === 'trail') {
    const t = action.trail;
    return Array.isArray(t) && t.length === 2 && t.every(isId) ? { ok: true, action: { trail: [...t] } } : { ok: false, reason: 'bad trail ids' };
  }
  if (kind === 'wait') return WAITS.has(action.wait) ? { ok: true, action: { wait: action.wait } } : { ok: false, reason: 'bad wait' };
  if (kind === 'click') {
    // only controls have a button; sky:/field:/colour: spots are moved to with a cmd
    const ok = isId(action.click) && (!action.click.includes(':') || /^(preset|proj|color):[A-Za-z0-9_.-]+$/.test(action.click));
    return ok ? { ok: true, action: { click: action.click } } : { ok: false, reason: 'bad click id' };
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
  if (spec.personOnly) return { ok: false, reason: `only the person can run ${name}` }; // e.g. the eye-control mode (U9)
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
    if (typeof step?.title === 'string' && step.title.trim()) clean.title = step.title.trim().slice(0, 120);
    if (typeof step?.sub === 'string' && step.sub.trim()) clean.sub = step.sub.trim().slice(0, 200);
    if (Array.isArray(step?.facts)) {
      const facts = step.facts.filter((f) => Array.isArray(f) && f.length === 2 && f.every(isPrimitive)).slice(0, 4);
      if (facts.length) clean.facts = facts.map(([k, v]) => [String(k), String(v)]);
    }
    if (Number.isFinite(step?.ms)) clean.ms = Math.min(30000, Math.max(2000, step.ms));
    out.push(clean);
  });
  if (out.length > MAX_STEPS) log(`script cut to ${MAX_STEPS} steps`);
  return out.slice(0, MAX_STEPS);
}

// Default answers: Next / Stop on every step; "Got it" on the last one when no end card follows.
export const defaultAnswers = (isLast, hasEnd = false) => (isLast && !hasEnd ? ['got_it'] : ['next', 'stop']);

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
 * @param {Function} [o.findControl]  id -> the [data-guide] element, only when it is on screen (else null)
 * @param {Function} [o.actingAs]     commands.actingAs (no click without it: the press would look like the person's)
 * @param {Function} [o.flyMs]        () -> how long the pointer flies before a press (0 with reduced motion)
 */
export function createRunner({
  say,
  dismiss,
  overlay,
  run,
  list,
  sanitize,
  getState = () => undefined,
  events,
  log = (...a) => console.warn('[guide]', ...a),
  findControl = () => null,
  actingAs = null,
  flyMs = () => FLY_MS,
  waitFor = () => Promise.resolve(),
}) {
  let current = null; // { end(outcome) }
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  /** Wait (at most CMD_TIMEOUT_MS, or until the script ends) for the named async commands to settle. */
  function settled(names, alive) {
    if (!names.length || !events) return Promise.resolve();
    const left = [...names];
    return new Promise((res) => {
      let timer = 0;
      let poll = 0;
      const done = () => {
        clearTimeout(timer);
        clearInterval(poll);
        events.removeEventListener('meridian:command', onEnd);
        res();
      };
      const onEnd = (e) => {
        const i = left.indexOf(e.detail?.name);
        if (i >= 0) left.splice(i, 1);
        if (!left.length) done();
      };
      events.addEventListener('meridian:command', onEnd);
      timer = setTimeout(done, CMD_TIMEOUT_MS);
      poll = setInterval(() => !alive() && done(), 100);
    });
  }

  /** { click: id }: fly, press, run the button's own command as the guide. */
  async function press(id, alive) {
    const el = findControl(id);
    const why = !actingAs ? 'no actingAs: the press would count as the person' : refuseClick(el);
    if (why) return log(`click ${id} refused: ${why}`);
    overlay.pointAt(id);
    const ms = flyMs();
    if (ms > 0) await sleep(ms);
    if (!alive()) return;
    overlay.press?.(id);
    el.classList?.add('guide-pressed');
    setTimeout(() => el.classList?.remove('guide-pressed'), PRESS_MS);
    const started = [];
    const onStart = (e) => started.push(e.detail?.name);
    events?.addEventListener?.('meridian:command-start', onStart);
    try {
      actingAs('guide', () => el.click());
    } finally {
      events?.removeEventListener?.('meridian:command-start', onStart);
    }
    await settled(started, alive);
  }

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
        else if ('click' in a) await press(a.click, alive);
        else if ('wait' in a) {
          let timer;
          await Promise.race([Promise.resolve(waitFor(a.wait, alive)).catch(() => {}), new Promise((res) => (timer = setTimeout(res, WAIT_MS)))]);
          clearTimeout(timer);
        }
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
    const end = script && !Array.isArray(script) && script.end && typeof script.end === 'object' ? script.end : null;

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

      const wait = (answer) => Promise.race([answer, new Promise((res) => (wake = res))]);
      (async () => {
        const n = steps.length;
        for (let i = 0; i < n && alive(); i++) {
          const step = steps[i];
          const isLast = i === n - 1;
          const waitsForGotIt = isLast && !end;
          overlay.clear();
          const mark = step.actions.find((a) => a.point || a.circle || a.highlight || a.click);
          const answer = say({
            title: step.title,
            say: step.say,
            sub: step.sub,
            facts: step.facts,
            step: n > 1 ? `${i + 1} / ${n}` : '',
            answers: step.answers ?? defaultAnswers(isLast, !!end),
            auto: waitsForGotIt || step.answers ? 0 : (step.ms ?? STEP_MS),
            target: step.target ?? mark?.point ?? mark?.circle ?? mark?.highlight ?? mark?.click,
          });
          // closing the card (✕, Esc, Stop) ends the tour at once, even while this step is still acting
          answer.then((id) => {
            if (id === 'close' || id === 'dismissed' || id === 'stop') me.end('closed');
            else if (id === 'replaced') me.end('replaced');
          });
          await runActions(step.actions, alive);
          if (!alive()) return;
          const id = await wait(answer);
          if (!alive()) return;
          if (id === 'close' || id === 'dismissed' || id === 'stop') return me.end('closed');
          if (id === 'replaced') return me.end('replaced');
          if (id === 'got_it') return me.end('done');
          if (!CONTINUE.has(id) && step.answers) return me.end(id); // a custom answer ends the script with it
        }
        if (!alive()) return;
        if (end) {
          // the closing card keeps the last step's marks on screen
          const id = await wait(say({ title: end.title, say: end.say, answers: end.answers ?? ['got_it'] }));
          if (!alive()) return;
          if (id === 'close' || id === 'dismissed' || id === 'stop') return me.end('closed');
          return me.end(id === 'got_it' ? 'done' : id);
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
