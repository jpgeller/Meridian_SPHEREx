// The guide's face: one of eight pixel companions (the team, drawn as pixel art). The person picks one
// and the choice is kept on this device (localStorage `meridian.companion`).
//
//   web/public/companions/agents.json   names, teams and roles: edit them there (no rebuild needed)
//   web/public/companions/<id>/         idle.webp (8 frames, gentle bobbing), talking.webp (mouth moves),
//                                       portrait.png and speaking.png (still poses, prefers-reduced-motion)
//
// Where it shows: a 64 px+ button beside the "AI Guide" pill (pressing it opens the picker) and in the
// guide card's header. It plays talking.webp while the guide speaks (popup.js sends `meridian:guide-speech`
// when a card shows its words: about the time it takes to read them) and returns to idle.webp afterwards.
// Commands: choose_companion (key C) opens/closes the picker, set_companion {id} picks one.
// Pixels stay crisp: image-rendering: pixelated, fixed square boxes (no jumping between the two loops).

export const STORAGE_KEY = 'meridian.companion';
export const SPEECH_EVENT = 'meridian:guide-speech';
export const DEFAULT_ID = 'agent-0502';
export const TALK_MS_PER_WORD = 260; // a little faster than reading aloud: the mouth stops before the reader does
export const TALK_MIN_MS = 1200;
export const TALK_MAX_MS = 6000;

// --- pure helpers (unit-tested) --------------------------------------------------------

/** The app's public folder (Vite's base URL; '/' in node tests). */
export const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';
const ROOT = `${BASE}companions/`;

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** agents.json -> [{ id, name, team, role, description, portrait, speaking, idle, talking }] with full URLs. */
export function normaliseAgents(list, root = ROOT) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const id = clean(a?.id);
    if (!id || !/^[a-z0-9-]+$/i.test(id) || out.some((o) => o.id === id)) continue;
    const file = (key, name) => `${root}${clean(a[key]) ?? `${id}/${name}`}`;
    out.push({
      id,
      name: clean(a.name) ?? id,
      team: clean(a.team),
      role: clean(a.role),
      description: clean(a.description),
      portrait: file('portrait', 'portrait.png'),
      speaking: file('speaking', 'speaking.png'),
      idle: file('idle', 'idle.webp'),
      talking: file('talking', 'talking.webp'),
    });
  }
  return out;
}

/** Until agents.json arrives (or if it fails): the id alone, with the standard file names. */
export const placeholderAgent = (id, root = ROOT) => normaliseAgents([{ id, name: 'AI Guide' }], root)[0];

/** The stored id if it is still in the list, else the first agent. */
export function pickAgent(agents, storedId) {
  return agents.find((a) => a.id === storedId) ?? agents[0] ?? null;
}

/** "Role · Team", or '' when neither is filled in. */
export const agentLine = (a) => [a?.role, a?.team].filter(Boolean).join(' · ');

/** Teams present in the list (the picker shows a team filter only when there are two or more). */
export const teamsOf = (agents) => [...new Set(agents.map((a) => a.team).filter(Boolean))];

/** How long the companion talks for these words (ms). */
export function talkMs(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  return Math.max(TALK_MIN_MS, Math.min(TALK_MAX_MS, words * TALK_MS_PER_WORD));
}

/** Which picture to show: the animated loops, or the still poses when motion is reduced. */
export function frameFor(agent, { talking = false, reduced = false } = {}) {
  if (!agent) return '';
  if (reduced) return talking ? agent.speaking : agent.portrait;
  return talking ? agent.talking : agent.idle;
}

// --- the companion ---------------------------------------------------------------------

/**
 * @param {Object} o
 * @param {Object} o.commands   the command bus (registers choose_companion, set_companion)
 * @param {Object} o.popup      the guide card (popup.js): its pill and card get the companion
 * @param {Function} [o.greet]  (agent) -> void: a short hello after the person picks a companion
 * @param {Document} [o.doc]
 * @param {Function} [o.fetchJson]
 */
export function createCompanion({ commands, popup, greet = () => {}, doc = document, fetchJson = null }) {
  const win = doc.defaultView;
  const storage = (() => {
    try {
      return win.localStorage;
    } catch {
      return null;
    }
  })();
  const readStored = () => {
    try {
      return storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  };
  const writeStored = (id) => {
    try {
      storage?.setItem(STORAGE_KEY, id);
    } catch {
      /* private window: the choice lasts this visit */
    }
  };
  const motionQuery = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reduced = () => !!motionQuery?.matches;

  let agents = [];
  let agent = placeholderAgent(readStored() ?? DEFAULT_ID);
  let talking = false;
  let talkTimer = 0;
  let team = null; // picker filter

  // the pill and the companion share one fixed corner: [companion][AI Guide]
  const corner = doc.createElement('div');
  corner.className = 'guide-corner';
  popup.pill.before(corner);
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'companion-btn';
  button.dataset.guide = 'companion';
  button.setAttribute('aria-keyshortcuts', 'c');
  button.innerHTML = '<img class="companion-img" alt="" width="256" height="256" draggable="false">';
  button.addEventListener('click', () => commands.run('choose_companion', {}, 'ui'));
  corner.append(button, popup.pill);
  const buttonImg = button.querySelector('img');

  // the card's header: the companion speaks from there, with its name
  const head = popup.element.querySelector('.gp-head');
  const cardImg = doc.createElement('img');
  cardImg.className = 'gp-companion';
  cardImg.alt = '';
  cardImg.width = cardImg.height = 256;
  cardImg.draggable = false;
  head.prepend(cardImg);
  const who = doc.createElement('span');
  who.className = 'gp-who';
  head.querySelector('.gp-name')?.after(who);

  // the picker: a dialog of eight big buttons (gaze presses buttons; no drop-downs)
  const picker = doc.createElement('div');
  picker.className = 'companion-picker';
  picker.hidden = true;
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-modal', 'true');
  picker.setAttribute('aria-labelledby', 'companion-picker-title');
  picker.innerHTML =
    '<div class="cp-box"><div class="cp-head"><h2 id="companion-picker-title">Choose your AI helper</h2>' +
    '<p class="cp-sub">Your guide will look like this. Kept on this device.</p></div>' +
    '<div class="cp-teams" role="group" aria-label="Team" hidden></div>' +
    '<div class="cp-grid" role="group" aria-label="Helpers"></div>' +
    '<div class="cp-foot"><button type="button" class="cp-done">Done</button></div></div>';
  doc.body.append(picker);
  const grid = picker.querySelector('.cp-grid');
  const teamsEl = picker.querySelector('.cp-teams');
  picker.querySelector('.cp-done').addEventListener('click', () => commands.run('choose_companion', { open: false }, 'ui'));
  let returnFocus = null;

  const preload = (a) => {
    if (!a || reduced()) return;
    for (const src of [a.idle, a.talking]) {
      const im = new win.Image();
      im.src = src;
    }
  };

  function paint() {
    const src = frameFor(agent, { talking, reduced: reduced() });
    for (const img of [buttonImg, cardImg]) if (img.getAttribute('src') !== src) img.src = src;
    const label = `${agent.name}, your AI helper. Change helper (key C)`;
    button.title = label;
    button.setAttribute('aria-label', label);
    who.textContent = agent.name === 'AI Guide' ? '' : agent.name;
    doc.body.dataset.companion = agent.id;
    doc.body.classList.toggle('companion-talking', talking);
  }

  function setTalking(on, ms = 0) {
    win.clearTimeout(talkTimer);
    talking = !!on;
    if (talking && ms > 0) talkTimer = win.setTimeout(() => setTalking(false), ms);
    paint();
  }

  function renderPicker() {
    const teams = teamsOf(agents);
    teamsEl.hidden = teams.length < 2;
    if (team && !teams.includes(team)) team = null;
    teamsEl.replaceChildren(
      ...(teams.length < 2 ? [] : [null, ...teams]).map((t) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'cp-team';
        b.textContent = t ?? 'Everyone';
        b.setAttribute('aria-pressed', String(team === t));
        b.addEventListener('click', () => commands.run('choose_companion', { team: t ?? '' }, 'ui'));
        return b;
      }),
    );
    const shown = agents.filter((a) => !team || a.team === team);
    grid.replaceChildren(
      ...shown.map((a) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'cp-agent';
        b.dataset.companion = a.id;
        b.setAttribute('aria-pressed', String(a.id === agent.id));
        const line = agentLine(a);
        b.title = `${a.name}${line ? `, ${line}` : ''}`;
        b.innerHTML = '<img alt="" width="256" height="256" draggable="false"><span class="cp-name"></span><span class="cp-line"></span>';
        // the chosen one bobs; the others stand still (eight loops at once would be busy)
        b.querySelector('img').src = a.id === agent.id ? frameFor(a, { reduced: reduced() }) : a.portrait;
        b.querySelector('.cp-name').textContent = a.name;
        b.querySelector('.cp-line').textContent = line;
        b.querySelector('.cp-line').hidden = !line;
        b.addEventListener('click', () => commands.run('set_companion', { id: a.id }, 'ui'));
        return b;
      }),
    );
  }

  function openPicker(on) {
    if (on === !picker.hidden) return;
    if (on) {
      returnFocus = doc.activeElement;
      renderPicker();
      picker.hidden = false;
      doc.body.classList.add('companion-picking');
      (grid.querySelector('[aria-pressed="true"]') ?? grid.querySelector('button'))?.focus();
    } else {
      picker.hidden = true;
      doc.body.classList.remove('companion-picking');
      if (returnFocus?.isConnected && returnFocus !== doc.body) returnFocus.focus();
      returnFocus = null;
    }
  }

  function select(id, { save = true } = {}) {
    const next = agents.find((a) => a.id === id);
    if (!next) throw new Error(`no helper with id ${id}`);
    agent = next;
    if (save) writeStored(next.id);
    preload(next);
    paint();
    if (!picker.hidden) renderPicker();
    return next;
  }

  commands.register(
    'choose_companion',
    ({ open, team: t } = {}) => {
      if (t !== undefined) {
        team = t || null;
        if (picker.hidden) openPicker(true);
        else renderPicker();
        return;
      }
      openPicker(open === undefined ? picker.hidden : !!open);
    },
    { label: 'Choose your AI helper', personOnly: true, keys: ['c'], args: { open: 'optional: true/false (default: toggle)', team: 'optional: show one team' } },
  );
  commands.register(
    'set_companion',
    ({ id } = {}) => {
      const a = select(String(id ?? ''));
      openPicker(false);
      greet(a);
      return a.id;
    },
    { label: 'Pick your AI helper', personOnly: true, args: { id: 'the helper id, e.g. agent-0505 (companions/agents.json)' } },
  );

  // Esc closes the picker first (capture: before "back to sky" and the guide card)
  win.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || picker.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      commands.run('choose_companion', { open: false }, 'keyboard');
    },
    true,
  );
  // a press outside the box closes it
  picker.addEventListener('click', (e) => {
    if (e.target === picker) commands.run('choose_companion', { open: false }, 'ui');
  });

  // the guide speaks: talk for about the time the words take, then idle
  win.addEventListener(SPEECH_EVENT, (e) => {
    const d = e.detail ?? {};
    if (d.speaking && !d.thinking) setTalking(true, talkMs(d.text));
    else setTalking(false);
  });
  motionQuery?.addEventListener?.('change', () => {
    paint();
    if (!picker.hidden) renderPicker();
  });

  paint();
  const load = fetchJson ?? ((url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))));
  const ready = load(`${ROOT}agents.json`)
    .then((list) => {
      agents = normaliseAgents(list);
      const a = pickAgent(agents, readStored());
      if (a) select(a.id, { save: false });
    })
    .catch((err) => {
      console.warn('[companion] companions/agents.json not loaded; the default helper stays', err);
      agents = [agent];
      paint();
    });

  return {
    ready,
    agents: () => agents.slice(),
    current: () => agent,
    isTalking: () => talking,
    isOpen: () => !picker.hidden,
    talk: (text) => setTalking(true, talkMs(text) || TALK_MIN_MS),
    quiet: () => setTalking(false),
    element: button,
    picker,
  };
}
