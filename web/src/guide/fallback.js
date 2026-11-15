// Fixed guide scripts for the three triggers (UI plan, U5). No network: the runner plays these
// when the guide API (U7) fails, times out or answers something invalid. Plain words, honest about
// limits, no claims beyond what the images show (CLAUDE.md).
//
//   fallbackScript(trigger, target?, state?) -> steps   trigger: 'object' | 'change' | 'colours'
//        target: { id, name } (e.g. { id: 'sky:barnard', name: "Barnard's Star" }) or an id string.
//        state: the store's state (only `view` is read).

import { presetById } from '../sky/presets.js';
import { CHANNELS_PER_DETECTOR } from '../core/bands.js';

export const TRIGGERS = ['object', 'change', 'colours'];
const D6_MIDDLE = 5 * CHANNELS_PER_DETECTOR + Math.floor(CHANNELS_PER_DETECTOR / 2); // band 93, same as the D6 button

function describe(target) {
  const t = typeof target === 'string' ? { id: target } : target ?? {};
  const id = typeof t.id === 'string' ? t.id : null;
  const preset = id && /^(sky|field):/.test(id) ? presetById(id.split(':')[1]) : null;
  return { id, name: t.name || preset?.label || null, note: preset?.note || null };
}

// One sentence: "This is Barnard's Star, the fastest-moving star…" when the note is one sentence that
// starts with "The"/"A"; otherwise the name, then the note.
function firstLine(name, note) {
  if (!note) return `This is ${name}.`;
  const one = !/[.!?]\s+\S/.test(note.trim());
  return one && /^(The|A|An) /.test(note) ? `This is ${name}, ${note[0].toLowerCase()}${note.slice(1)}` : `This is ${name}. ${note}`;
}

const objectScript = (target, state) => {
  const { id, name, note } = describe(target);
  const mark = id ? [{ point: id }, { circle: id }] : [];
  return [
    { say: name ? firstLine(name, note) : 'This is the spot you were looking at.', actions: mark },
    {
      say: 'SPHEREx photographs every part of the sky in 102 infrared colours, a few times a year. Each colour is a separate picture, taken on its own date.',
      actions: [],
    },
    {
      say:
        state?.view === 'field'
          ? 'These are the real SPHEREx pictures of this spot, one per visit. The guide is offline right now, so it cannot say more about this object.'
          : 'Zoom in and open the time-lapse to see the real SPHEREx pictures of this spot. The guide is offline right now, so it cannot say more.',
      actions: [],
    },
  ];
};

const changeScript = (target, state) => {
  const inField = state?.view === 'field';
  return [
    {
      say: 'You are replaying the same visits. Each frame is a real SPHEREx picture of this spot, taken on a different date.',
      actions: inField ? [{ point: 'time-player' }] : [],
    },
    {
      say: 'The change video plays this spot from 2010 to 2026, WISE first, then SPHEREx. Stars that stay put stand still; something that moved slides along, marked with a ring.',
      actions: inField ? [{ cmd: 'set_op', args: { op: 'video' } }, { point: 'video-line' }] : [],
    },
    {
      say: 'A streak is a hint, not proof. Noise, a passing asteroid or a star that changed brightness can look similar. Check the Gaia and WISE layers before trusting it.',
      actions: [],
    },
  ];
};

const coloursScript = () => [
  {
    say: 'These colours are infrared light our eyes cannot see. SPHEREx splits it into 102 bands, from about 0.75 to 5 micrometres, grouped here as six detectors, D1 to D6.',
    actions: [{ point: 'band-ribbon' }],
  },
  {
    say: 'D6 holds the longest wavelengths, about 4.4 to 5 micrometres. Cool things glow there: dust, ices and the coldest brown dwarfs. The map now shows a D6 band.',
    actions: [{ cmd: 'set_band', args: { band: D6_MIDDLE } }, { circle: 'band-d6' }],
  },
  {
    say: 'The colours on the map are a display choice, not the true colour of anything. Brightness also depends on the colour view and the brightness settings.',
    actions: [{ point: 'colour-views' }],
  },
];

const SCRIPTS = { object: objectScript, change: changeScript, colours: coloursScript };

/** A fixed script for `trigger` ('colors' is accepted too). Unknown trigger -> the object script. */
export function fallbackScript(trigger, target, state) {
  const key = trigger === 'colors' ? 'colours' : trigger;
  return (SCRIPTS[key] ?? objectScript)(target, state);
}
