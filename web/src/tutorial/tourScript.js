// The guided tour of the controls (mouse mode, eye control off). Pure: the steps, when to offer the
// tour on opening the page, how long a caption stays, and where the caption card goes. The DOM side
// (the drawn cursor, the card, the presses) is in tour.js.
//
//   step = { id, view: 'sky' | 'field', target?: CSS selector, title, say,
//            do?: Act[],      what the cursor does after it reaches the target (in order)
//            ms?: number }    how long the caption stays after the acts (default: readMs(say))
//   Act  = { click: selector? }            press the target (or this selector): its own handler runs its command
//        | { type: text, into? }           type into the target (or `into`), letter by letter (no submit)
//        | { drag: [dx, dy], cmd, times }  a drag gesture over the sky while `cmd` runs `times` times
//        | { cmd, args? }                  run a command directly (no cursor)
//        | { wait: ms | 'sky' | 'frames' } wait a fixed time, for the sky to settle, or for the 2D frames
//        | { restore: 'search' }           put back what the person had typed in the search box
// A target that is not on screen (e.g. "Open time-lapse here" while zoomed out) is skipped quietly:
// the caption still shows, the cursor waits in place.

export const STORAGE_KEY = 'meridian.tour'; // localStorage: 'done' | 'skipped' once answered
export const TOUR_KEY = 'h';

export const STEPS = Object.freeze([
  {
    id: 'sky',
    view: 'sky',
    target: '#sky',
    title: 'The infrared sky',
    say: 'This is the whole sky as SPHEREx sees it in infrared. Drag it to turn it, and scroll to zoom in or out.',
    do: [{ drag: [-180, 40], cmd: 'pan_right', times: 3 }],
  },
  {
    id: 'panel',
    view: 'sky',
    target: '#panel-toggle',
    title: 'Controls',
    say: 'This button folds the side panel away and brings it back (key P). Every setting lives in that one panel.',
  },
  {
    id: 'eye',
    view: 'sky',
    target: '#input-mode',
    title: 'Eye control: off',
    say: 'You are using the mouse and keyboard. Press here (key G) to let your eyes help the guide, or to control everything by looking.',
  },
  {
    id: 'places',
    view: 'sky',
    target: '[data-preset="barnard"]',
    title: 'Places',
    say: 'One press flies the sky to a challenge target or a famous spot. Let’s go to Barnard’s Star, the fastest-moving star in our sky.',
    do: [{ click: null }, { wait: 'sky' }],
  },
  {
    id: 'hints',
    view: 'sky',
    target: '.hint-badge',
    title: 'Little stars explain',
    say: 'Rest the mouse on a white star next to a section title and it explains that whole section.',
  },
  {
    id: 'search',
    view: 'sky',
    target: '#search',
    title: 'Search',
    say: 'Or type a name or coordinates here and press Go (key /). Names like “R Dra” or numbers like 08h55m10.8s −07d14m42s both work.',
    do: [{ click: '#search-input' }, { type: 'WISE 0855', into: '#search-input' }, { wait: 1200 }, { restore: 'search' }],
  },
  {
    id: 'view',
    view: 'sky',
    target: '[data-proj="STG"]',
    title: 'View',
    say: '3D sphere shows the sky as a globe; Planetarium as if you stood inside it. − and + zoom out and in (keys − and +).',
    do: [{ click: null }, { wait: 900 }, { click: '[data-cmd="zoom_in"]' }, { wait: 700 }, { click: '[data-proj="SIN"]' }],
  },
  {
    id: 'colours',
    view: 'sky',
    target: '[data-color="tint"]',
    title: 'Colours',
    say: 'Infrared has no colour to our eyes, so these are translations. Tinted band gives each detector its own hue.',
    do: [{ click: null }, { wait: 'sky' }],
  },
  {
    id: 'bands',
    view: 'sky',
    target: '[data-detector="1"]',
    title: 'Infrared bands',
    say: 'SPHEREx has six detectors. D1 sees the shortest wavelengths, nearest to visible light; D6 the longest infrared. Keys [ and ] step band by band.',
    do: [{ click: null }, { wait: 1200 }, { click: '[data-detector="6"]' }, { wait: 1200 }, { click: '[data-color="grey"]' }],
  },
  {
    id: 'readout',
    view: 'sky',
    target: '.shell-readout',
    title: 'Where you are',
    say: 'The middle of the view in sky coordinates (RA and Dec), and how wide the view is.',
  },
  {
    id: 'guide',
    view: 'sky',
    target: '.guide-pill',
    title: 'AI Guide',
    say: 'Ask the guide what you are looking at (key A). If you rest the mouse on something for a while, it may offer to explain it.',
  },
  {
    id: 'open',
    view: 'sky',
    target: '#open-field',
    title: 'Open the time-lapse',
    say: 'Zoomed in, this opens the real SPHEREx images of this patch, one for each visit (key Enter).',
    do: [{ click: null }, { wait: 'frames' }],
  },
  {
    id: 'image',
    view: 'field',
    target: '#frame-canvas',
    title: 'Real SPHEREx images',
    say: 'Each frame is one SPHEREx exposure at its own pixel size (6.15″), never smoothed. Barnard’s Star moves about 10″ a year, so between dates it shifts by a pixel or so.',
  },
  {
    id: 'zoom2d',
    view: 'field',
    target: 'section[aria-labelledby="fsec-zoom"]',
    title: 'Zoom',
    say: 'How much sky the images cover. A wider field catches faster-moving objects but takes longer to load.',
  },
  {
    id: 'detector2d',
    view: 'field',
    target: 'section[aria-labelledby="fsec-detector"]',
    title: 'Detector',
    say: 'Which detector’s images to show, D1 (short) to D6 (long). More bands opens single bands, colour mixes and formulas.',
  },
  {
    id: 'view2d',
    view: 'field',
    target: '[data-show="blink"]',
    title: 'View',
    say: 'Blink flips between two dates, so anything that moved jumps. You can also compare with WISE or Gaia, or list sources not in Gaia.',
    do: [{ click: null }, { wait: 3500 }, { click: '[data-show="timelapse"]' }],
  },
  {
    id: 'dates',
    view: 'field',
    target: '#epochs',
    title: 'Dates',
    say: 'Every date SPHEREx looked here. Press one to jump to it, or pick two to compare.',
  },
  {
    id: 'play',
    view: 'field',
    target: '#p-play',
    title: 'Playback',
    say: 'Play runs the dates as a film (Space); the arrows step one frame at a time.',
    do: [{ click: null }, { wait: 3500 }, { click: '#p-play' }],
  },
  {
    id: 'back',
    view: 'field',
    target: '#field-close',
    title: 'Back to the sky',
    say: 'This takes you back to the 3D sky (key Esc).',
    do: [{ click: null }, { wait: 'sky' }],
  },
  {
    id: 'end',
    view: 'sky',
    title: 'That’s the tour',
    say: 'Now it’s your turn. Press H any time to watch this tour again.',
    ms: 0, // waits for Done
  },
]);

/**
 * Offer the tour when the page opens? Only on a first visit (nothing stored), never in automated
 * browsers (tests) or when a native eye tracker is connected (its calibration asks first).
 * `?tour=1` always offers, `?tour=0` never does.
 */
export function shouldOffer({ params, stored, webdriver = false }) {
  const p = params?.get?.('tour');
  if (p === '1' || p === 'on') return true;
  if (p === '0' || p === 'off') return false;
  if (webdriver || params?.get?.('gaze_ws')) return false;
  return !stored;
}

/** How long a caption stays once the cursor has finished: time to read it, 3.5–10 s. */
export function readMs(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  return Math.round(Math.min(10000, Math.max(3500, 1500 + words * 230)));
}

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Where the caption card goes: beside the target (right, left, below, above), never over it, inside
 * the screen minus the eye-tracking edges. No target (or no free side): the middle of the screen,
 * low down. -> { left, top }
 * @param {{left,top,right,bottom}|null} target
 * @param {{w,h}} card
 * @param {{w,h}} view
 * @param {{x,y}} edge  the 6 % margins in px
 */
export function placeCard(target, card, view, edge, gap = 24) {
  const minL = edge.x;
  const minT = edge.y;
  const maxL = view.w - edge.x - card.w;
  const maxT = view.h - edge.y - card.h;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const centre = { left: clamp((view.w - card.w) / 2, minL, maxL), top: clamp(view.h * 0.62 - card.h / 2, minT, maxT) };
  if (!target) return centre;
  const big = target.right - target.left > view.w * 0.6 && target.bottom - target.top > view.h * 0.6;
  if (big) return centre; // the whole sky: anywhere is "on" it
  const cx = (target.left + target.right) / 2;
  const cy = (target.top + target.bottom) / 2;
  const tries = [
    { left: target.right + gap, top: cy - card.h / 2 },
    { left: target.left - gap - card.w, top: cy - card.h / 2 },
    { left: cx - card.w / 2, top: target.bottom + gap },
    { left: cx - card.w / 2, top: target.top - gap - card.h },
  ];
  const keepOut = { left: target.left - 8, top: target.top - 8, right: target.right + 8, bottom: target.bottom + 8 };
  for (const t of tries) {
    const p = { left: clamp(t.left, minL, maxL), top: clamp(t.top, minT, maxT) };
    if (!overlaps({ ...p, right: p.left + card.w, bottom: p.top + card.h }, keepOut)) return p;
  }
  return centre;
}

/** The cursor's glide time for a move of `px` pixels: 450–1100 ms. */
export const glideMs = (px) => Math.round(450 + 650 * Math.min(1, Math.max(0, px) / 1400));
