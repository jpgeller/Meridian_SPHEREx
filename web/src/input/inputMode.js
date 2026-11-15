// Input modes (UI plan U9). A setting in the store (`state.input`, URL `?input=`), default 'mouse'.
// Pure: what each mode lets gaze samples do. The DOM wiring is in gaze.js.
//
//   mouse  (A) mouse and keyboard only. Gaze samples are ignored for pressing and for the guide;
//              they only move the face panel's gaze dot. The guide's dwell follows the mouse with
//              ?gaze=mouse (U6). Offers auto-hide after 12 s.
//   assist (B) gaze helps the guide: samples feed guide.attention (the 7 s dwell ring and offers)
//              and never press anything. Offers stay until answered.
//   gaze   (C) full gaze control: a 0.8 s dwell presses buttons (gazeCore.js), 24 px snapping,
//              edge panning over the sky, a rest zone to pause. Samples also feed the guide, so a
//              7 s look at a sky object or at the colours still brings the offer. Offers stay.
import { INPUTS } from '../core/state.js';

export { INPUTS };

export const MODE_INFO = Object.freeze({
  mouse: { letter: 'A', label: 'Off', title: 'Eye control off: mouse and keyboard' },
  assist: { letter: 'B', label: 'Guide only', title: 'Gaze helps the guide; it never presses anything' },
  gaze: { letter: 'C', label: 'Full control', title: 'Full gaze control: look at a button for 0.8 s to press it' },
});

/** What gaze may do in a mode. */
export function modeBehaviour(mode) {
  const m = INPUTS.includes(mode) ? mode : 'mouse';
  return {
    mode: m,
    press: m === 'gaze', // dwell-to-press, edge panning, rest zone
    attention: m !== 'mouse', // gaze samples feed the guide's attention
    mouseAttention: m === 'mouse', // the mouse may feed it instead (only with ?gaze=mouse)
    autoHide: m === 'mouse', // offers hide after 12 s only when nobody relies on gaze
    dot: m !== 'mouse', // draw the gaze dot on the page (the face panel shows it in every mode)
  };
}

/** A -> B -> C -> A. From full gaze one press turns eye control off. */
export const nextMode = (mode) => INPUTS[(INPUTS.indexOf(mode) + 1) % INPUTS.length];

/** Accepts 'mouse' | 'assist' | 'gaze' or the plan's letters 'A' | 'B' | 'C'. Returns null if neither. */
export function parseMode(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (INPUTS.includes(s.toLowerCase())) return s.toLowerCase();
  const byLetter = Object.entries(MODE_INFO).find(([, i]) => i.letter === s.toUpperCase());
  return byLetter ? byLetter[0] : null;
}
