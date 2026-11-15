// The `targets` reply to the eye tracker (UI plan U9). Pure, unit-tested.
//
//   Meridian -> tracker: { type: 'targets', items: [{ id, x, y, w, h, kind, label? }] }
//   x, y = top-left corner, w, h = size, all in viewport px (rounded).
//   kind: 'button'  a real <button> gaze can press in full gaze mode (id = its data-guide id,
//                   else preset:<id> / cmd:<name> / detector:<n> …, else a stable t<n>)
//         'target'  something the guide knows by name (registry ids: sky:barnard, field:target,
//                   colour:D6, band-ribbon …). Points come as a box around the point.
// A tracker can snap its cursor to these boxes. Sent when the list changes, at most every
// minMs (250 ms = 4 per second), only to the window that sent the latest gaze sample.

const round = (v) => Math.round(v);

/** registry entry { id, label?, x, y, r? | rect? } -> { id, x, y, w, h } or null */
export function boxOf(entry) {
  if (!entry || typeof entry.id !== 'string') return null;
  if (entry.rect) return { x: entry.rect.x, y: entry.rect.y, w: entry.rect.w, h: entry.rect.h };
  if (Number.isFinite(entry.x) && Number.isFinite(entry.y)) {
    const r = Number.isFinite(entry.r) && entry.r > 0 ? entry.r : 12;
    return { x: entry.x - r, y: entry.y - r, w: 2 * r, h: 2 * r };
  }
  return null;
}

/**
 * buttons: [{ id, label?, x, y, w, h }] (pressable); registry: registry.list() entries.
 * Buttons first; a registry id already used by a button is not repeated.
 */
export function buildTargets(buttons = [], registry = []) {
  const out = [];
  const seen = new Set();
  const push = (id, box, kind, label) => {
    if (!box || seen.has(id) || !(box.w > 0) || !(box.h > 0)) return;
    seen.add(id);
    out.push({ id, x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h), kind, ...(label ? { label: String(label).slice(0, 40) } : {}) });
  };
  for (const b of buttons) push(b.id, b, 'button', b.label);
  for (const e of registry) push(e.id, boxOf(e), 'target', e.label);
  return out;
}

/**
 * A stable id for a button: its data-guide, else a data-* that names it, else null (the caller
 * numbers it per element). The guide card's answers are left to the caller on purpose: each step
 * has new buttons, so a new "Show me more" in the spot just pressed is a new target (gazeCore
 * waits until the gaze leaves that spot) and staring never runs through the steps.
 */
export function buttonId(dataset = {}) {
  if (dataset.guide) return dataset.guide;
  for (const [key, prefix] of [['preset', 'preset'], ['cmd', 'cmd'], ['detector', 'detector'], ['proj', 'proj'], ['color', 'color']]) {
    if (dataset[key]) return `${prefix}:${dataset[key]}`;
  }
  return null;
}

/**
 * Throttled sender: update(items, now) posts when the list differs from the last one sent and
 * at least minMs have passed; a change inside the window waits for a later update() (gaze
 * samples arrive ~30 per second, so it goes out within minMs). setSend(fn, key) switches the
 * receiving tracker, which then gets the current list at once.
 */
export function createTargetSender({ minMs = 250 } = {}) {
  let send = null;
  let sendKey = null;
  let last = '';
  let lastT = -Infinity;
  return {
    /** key: what identifies the receiver (the message's source window); a new key resets. */
    setSend(fn, key = fn) {
      if (key === sendKey) {
        send = fn;
        return;
      }
      sendKey = key;
      send = fn;
      last = '';
      lastT = -Infinity;
    },
    update(items, now) {
      if (!send) return false;
      const json = JSON.stringify(items);
      if (json === last || now - lastT < minMs) return false;
      last = json;
      lastT = now;
      send({ type: 'targets', items });
      return true;
    },
    hasReceiver: () => Boolean(send),
  };
}
