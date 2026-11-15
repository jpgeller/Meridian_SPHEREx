// The guide's tours (wireframe v4): short scripts that explain one thought at a time while the guide
// drives the app (flies the sky, opens the time-lapse, plays it, switches bands), always through the
// same buttons and commands a person uses. Each returns { steps, end } for runner.runScript; the end
// card's answer ids are handled in index.js (e.g. 'show' -> motion tour, 'again', 'example').
//
//   menuCard()                           the pill's question: What am I looking at? · Something moving · What the colours mean
//   identifyTour(id, { inField })        name, what it is, a few facts (WISE 0855: the band goes to D6), "Want to see how it moves?"
//   motionTour(id, { inField, atTarget }) fly there -> open the time-lapse -> first picture -> play -> motion trail / blink
//   changeTour()                         (field view, replaying) first picture -> play -> motion trail, with the honest caveat
//   coloursTour({ inField })             the band ribbon -> D1 -> D6 -> colour views
//   exampleTour()                        WISE 0855 in D1, then D6
//   whereTour({ fov, detector })         nothing with notes in the middle: the whole sky / a patch, in plain words
//
// Facts are kept modest and checkable (CLAUDE.md: honest about limits, never claim discoveries).

import { presetById } from '../sky/presets.js';

export const NOTES = {
  milky_way: {
    kind: 'Galaxy core',
    blurb: 'The centre of our galaxy, around the black hole Sagittarius A*. Visible light is blocked by thick dust; infrared slips through it.',
    facts: [['Distance', 'about 26,000 light-years'], ['Moves?', 'No, far too distant'], ['Best in', 'D4 to D6']],
    motion: 'none',
  },
  solar_system: {
    kind: 'Ecliptic pole',
    blurb: 'Looking straight out of the plane the planets orbit in. SPHEREx never points at the Sun, and it revisits this part of the sky most often.',
    facts: [['Planets', 'move along the ecliptic, not here'], ['Visits', 'many, near the poles']],
    motion: 'none',
  },
  barnard: {
    kind: 'Red dwarf star',
    blurb: 'A small, cool star and one of the Sun’s closest neighbours. It crosses our sky faster than any other star, fast enough to shift between SPHEREx visits.',
    facts: [['Distance', '5.96 light-years'], ['Motion', '10.4 arcsec per year'], ['Best in', 'D1 to D3']],
    motion: 'pm',
    rate: '10 arcseconds',
  },
  eps_ind_b: {
    kind: 'Pair of brown dwarfs',
    blurb: 'Two brown dwarfs orbiting each other, travelling with the nearby star Epsilon Indi. They are cool, so they glow mostly in the longer bands.',
    facts: [['Distance', 'about 12 light-years'], ['Motion', 'about 4.7 arcsec per year'], ['Best in', 'D4 to D6']],
    motion: 'pm',
    rate: 'almost 5 arcseconds',
  },
  wise_0855: {
    kind: 'Brown dwarf',
    blurb: 'A “failed star”, too small to shine by fusion and about as cold as a winter day. It gives off almost no light at short wavelengths.',
    facts: [['Distance', 'about 7.4 light-years'], ['Temperature', 'near water’s freezing point'], ['Motion', 'about 8 arcsec per year']],
    motion: 'pm',
    rate: 'about 8 arcseconds',
    longOnly: true,
  },
  rw_aur: {
    kind: 'Young variable star',
    blurb: 'A young star, a few million years old, still wrapped in gas and dust. Dust passing in front makes it fade and brighten.',
    facts: [['Type', 'T Tauri star (very young)'], ['Changes', 'brightness, not position'], ['Distance', 'about 500 light-years']],
    motion: 'var',
  },
  r_dra: {
    kind: 'Mira variable star',
    blurb: 'A giant star near the end of its life that swells and shrinks, brightening and fading over about eight months.',
    facts: [['Type', 'pulsating red giant'], ['Changes', 'brightness, not position'], ['Cycle', 'about 245 days']],
    motion: 'var',
    saturated: true,
  },
};

const GOT = 'got_it';
const AGAIN = { id: 'again', label: 'Show me again' };
const clear = { title: 'Is that clear?' };

export const noteFor = (id) => {
  const preset = presetById(id);
  return preset && NOTES[id] ? { id, name: preset.label, ...NOTES[id] } : null;
};

/** 'sky:barnard' | 'field:target' | 'barnard' -> 'barnard' (a preset id), or null. */
export function presetIdOf(targetId) {
  if (typeof targetId !== 'string') return null;
  const id = targetId.replace(/^(sky|field):/, '');
  return NOTES[id] && presetById(id) ? id : null;
}

export function menuCard() {
  return {
    title: 'What can I show you?',
    say: 'Pick one, and I will point at it on the screen.',
    answers: [
      { id: 'here', label: 'What am I looking at?' },
      { id: 'moving', label: 'Something moving' },
      { id: 'colours', label: 'What the colours mean' },
    ],
    auto: 16000,
  };
}

export function identifyTour(id, { inField = false } = {}) {
  const n = noteFor(id);
  if (!n) return null;
  const mark = inField ? 'field:target' : `sky:${id}`;
  const show = [{ point: mark, label: n.name }, { circle: mark }];
  const steps = [
    { title: n.name, sub: n.kind, say: n.blurb, actions: show, ms: 10000 },
    { title: n.name, say: 'A few facts:', facts: n.facts, actions: show, ms: 9000 },
  ];
  if (n.longOnly && !inField) {
    steps.push({
      say: 'It only shows up at long wavelengths. That is why I put the band on D6.',
      actions: [{ click: 'band-d6' }, { circle: 'band-d6' }, { circle: mark }],
    });
  }
  const q = n.motion === 'pm' ? 'Want to see how it moves?' : n.motion === 'var' ? 'Want to see how it changes?' : 'Want to see what the colours show here?';
  return { steps, end: { title: q, answers: [{ id: 'show', label: 'Show me' }, GOT] } };
}

/** The time-lapse part of a motion tour: first picture -> play -> trail (moving) or blink (changing). */
function timelapseSteps(n) {
  const name = n?.name ?? 'this object';
  const steps = [
    {
      say: 'This is the first picture, from the oldest date. Every frame is a real SPHEREx image of this spot, taken on a different day.',
      actions: [{ cmd: 'set_op', args: { op: 'none' } }, { cmd: 'set_frame', args: { index: 0 } }, { point: 'dates', label: 'Dates' }],
      ms: 8000,
    },
    {
      say: `Now watch the circled ${n?.motion === 'var' ? 'star' : 'spot'} while I play the pictures.`,
      actions: [{ circle: 'field:target' }, { click: 'play' }, { point: 'field:target', label: name }],
      ms: 9000,
    },
  ];
  if (n?.motion === 'var') {
    steps.push({
      say: 'It does not move: its brightness changes between visits. Blink flips between two dates, so the change jumps out.',
      sub: n.saturated ? `${name} is so bright that it saturates every SPHEREx image, so its exact brightness cannot be measured here.` : '',
      actions: [{ cmd: 'pause' }, { click: 'op-blink' }, { circle: 'field:target' }, { point: 'op-blink', label: 'Blink' }],
      ms: 11000,
    });
  } else {
    steps.push({
      say: n?.rate
        ? `In the motion trail each date gets its own colour. Stars that stay put come out white; ${name} moves ${n.rate} a year and leaves a coloured streak.`
        : 'In the motion trail each date gets its own colour. Things that stay put come out white; something that moved leaves a coloured streak.',
      sub: 'A streak is a hint, not proof: noise or a passing asteroid can look similar.',
      actions: [{ cmd: 'pause' }, { click: 'op-trail' }, { wait: 'frames' }, { point: 'trail-legend', label: 'oldest → newest' }, { circle: 'field:target' }],
      ms: 12000,
    });
  }
  return steps;
}

export function motionTour(id, { inField = false, atTarget = false } = {}) {
  const n = noteFor(id);
  if (!n) return null;
  if (n.motion === 'none') {
    return {
      steps: [
        {
          say: `${n.name} is far too distant to move between SPHEREx visits. What changes is what you can see in each band.`,
          actions: [{ point: 'band-ribbon', label: 'bands' }, { circle: 'band-ribbon' }],
          ms: 9000,
        },
      ],
      end: { ...clear, answers: [GOT, { id: 'colours', label: 'What the colours mean' }] },
    };
  }
  const steps = [];
  if (!atTarget) {
    steps.push({ say: `First I will take you to ${n.name}.`, actions: [{ cmd: 'go_preset', args: { id } }, { point: `sky:${id}`, label: n.name }], ms: 4000 });
  }
  if (!inField || !atTarget) {
    steps.push({
      say: 'SPHEREx photographed this spot on several dates. I will open its real pictures.',
      actions: [{ click: 'open-field' }, { wait: 'frames' }, { point: 'time-player', label: 'Time-lapse' }],
      ms: 6000,
    });
  }
  steps.push(...timelapseSteps(n));
  return { steps, end: { ...clear, answers: [GOT, AGAIN, { id: 'back', label: 'Back to sky' }] } };
}

export function changeTour() {
  return { steps: timelapseSteps(null), end: { ...clear, answers: [GOT, AGAIN] } };
}

export function coloursTour({ inField = false } = {}) {
  const steps = [];
  if (inField) steps.push({ say: 'The colour controls live on the sky. I will take you back there.', actions: [{ click: 'back-to-sky' }], ms: 4000 });
  steps.push(
    {
      say: 'Each colour here is a kind of infrared light your eyes cannot see. SPHEREx splits it into 102 bands, grouped as six detectors, D1 to D6.',
      actions: [{ point: 'band-ribbon', label: '102 colours' }, { circle: 'band-ribbon' }],
    },
    {
      title: 'D1',
      say: 'D1 is closest to visible light. The sky looks much like it does through an ordinary telescope.',
      actions: [{ click: 'band-d1' }, { circle: 'band-d1' }],
    },
    {
      title: 'D6',
      say: 'D6 holds the longest wavelengths. Cold things that are dark everywhere else start to glow here: dust, ices, the coldest brown dwarfs.',
      actions: [{ click: 'band-d6' }, { circle: 'band-d6' }],
    },
    {
      say: 'The colours on the map are a display choice, not the true colour of anything. These buttons change how the infrared is painted.',
      actions: [{ cmd: 'toggle_panel', args: { open: true } }, { point: 'colour-views', label: 'Colour views' }, { highlight: 'colour-views' }],
    },
  );
  return { steps, end: { ...clear, answers: [GOT, { id: 'example', label: 'Show me an example' }, AGAIN] } };
}

export function exampleTour() {
  return {
    steps: [
      { say: 'Here is a cold object: WISE 0855, the coldest known brown dwarf.', actions: [{ cmd: 'go_preset', args: { id: 'wise_0855' } }, { circle: 'sky:wise_0855' }], ms: 5000 },
      {
        title: 'D1',
        say: 'In D1, near visible light, WISE 0855 gives off almost no light at all.',
        actions: [{ click: 'band-d1' }, { circle: 'sky:wise_0855' }, { point: 'sky:wise_0855', label: 'WISE 0855' }],
      },
      {
        title: 'D6',
        say: 'In D6 it gives off most of its light. It is still very faint, so the real SPHEREx pictures show it best.',
        actions: [{ click: 'band-d6' }, { circle: 'sky:wise_0855' }, { point: 'open-field', label: 'Real pictures' }],
      },
    ],
    end: { title: 'Want to see it move?', answers: [{ id: 'show', label: 'Show me' }, GOT] },
  };
}

export function whereTour({ fov = 60, detector = 1 } = {}) {
  const say =
    fov > 100
      ? `This is the whole sky as a sphere, seen from outside. The bright band is the Milky Way, in D${detector} infrared light.`
      : `A patch of sky in D${detector} infrared light. Every dot is a star or a galaxy. Nothing I have notes on is in the middle.`;
  return { steps: [{ say, actions: [], answers: [GOT, { id: 'moving', label: 'Something moving' }] }] };
}
