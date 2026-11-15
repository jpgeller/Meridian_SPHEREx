// What each button does, in a sentence: the text of the yellow "!" hints (ui/hints.js) shown in
// input mode A (mouse and keyboard). Pure: no DOM beyond `el.matches` / attributes, so it is unit-tested.
//
// Order of preference for a button's hint:
//   1. its own `data-hint` attribute (set it on any new button that needs a specific explanation),
//   2. the first rule below whose selector matches,
//   3. its `title` (the places, colour views and band modes already explain themselves there),
//   4. nothing: no badge (better none than a hint that only repeats the button's words).

/** [CSS selector, explanation]. The first match wins, so put specific selectors first. */
export const HINT_RULES = Object.freeze([
  // --- top bar ---
  ['#search button[type="submit"]', 'Fly to the name or coordinates typed in the box (e.g. Barnard\'s Star, or 08h55m10.8s -07d14m42s).'],
  ['#panel-toggle', 'Show or hide the side panel with every setting (key P).'],
  ['.guide-pill', 'Open the AI guide: it explains what you are looking at and suggests things to try (key A).'],
  ['.guide-popup .gp-x', 'Close this message from the guide.'],
  ['#input-mode', 'Eye control: off (A), guide only (B) or full gaze control (C). Each press moves to the next one (key G).'],
  // --- face panel ---
  ['#face-toggle', 'Fold or unfold the face-tracking panel: the camera\'s face mesh, blinks and head turn.'],
  ['#face-demo', 'Show the simulated face even while a real eye tracker is sending data.'],
  // --- sky view: view and zoom ---
  ['[data-cmd="zoom_in"]', 'Zoom in on the centre of the view (key +).'],
  ['[data-cmd="zoom_out"]', 'Zoom out to see more of the sky (key −).'],
  ['[data-proj="SIN"]', 'Show the sky as a globe seen from outside.'],
  ['[data-proj="STG"]', 'Show the sky as if you stood inside it, like a planetarium dome: shapes keep their form as they move.'],
  ['#mix-form button[type="submit"]', 'Colour the sky with the three bands typed for red, green and blue.'],
  ['[data-detector]', 'Show the sky in this detector\'s wavelengths. D1 is the shortest (nearest to visible light), D6 the longest infrared.'],
  ['#open-field', 'Open the 2D time-lapse: the real SPHEREx images of this patch, one per visit (key Enter).'],
  // --- 2D view: header, size and band ---
  ['#field-close', 'Leave the 2D images and go back to the 3D sky (key Esc).'],
  ['[data-ffov]', 'How much sky the 2D images cover around the target. Smaller is closer in; the pixels stay SPHEREx\'s own.'],
  ['[data-fdet]', 'Use this detector\'s images. D1 is the shortest wavelength, D6 the longest.'],
  ['#band-more-toggle', 'Show or hide more band choices: step band by band, add a whole detector, mix colours or write a formula.'],
  ['#field-band-prev', 'Step to the next shorter wavelength band (key [).'],
  ['#field-band-next', 'Step to the next longer wavelength band (key ]).'],
  ['[data-mode="single"]', 'Show one of SPHEREx\'s 102 narrow bands.'],
  ['[data-mode="detector"]', 'Add all 17 bands of this detector together: fainter things show up.'],
  ['[data-mode="rgb"]', 'Show three bands or detectors as red, green and blue.'],
  ['[data-mode="custom"]', 'Combine bands with your own formula, for example D6 − D1 to find things brighter at long wavelengths.'],
  ['#rgb-form button[type="submit"]', 'Use the red, green and blue bands typed here.'],
  ['#formula-form button[type="submit"]', 'Show the image made by the formula typed here.'],
  // --- 2D view: what to show ---
  ['[data-show="timelapse"]', 'Play the real SPHEREx images of this patch in date order (key T).'],
  ['[data-show="video"]', 'A smooth video of change: the real images, with a model filling in between them (key V).'],
  ['[data-show="blink"]', 'Flip between two dates to spot anything that moved or changed brightness (key B).'],
  ['[data-show="wise"]', 'Put the WISE infrared images of the same patch beside SPHEREx\'s (key W). WISE watched 2010–2024.'],
  ['[data-show="gaia"]', 'Put the Gaia star catalogue beside the SPHEREx image, each star moved to the image\'s date.'],
  ['[data-show="nogaia"]', 'Mark sources SPHEREx sees that Gaia does not list (key N). Candidates only, not discoveries.'],
  ['#video-marks-on', 'Turn on or off the marks on objects that move between the images.'],
  ['#video-hold', 'Turn on to stop briefly on each real image, so you can tell them from the model in between.'],
  ['#trail-wise', 'Turn on or off the older WISE images (2010–2024) in the video, for a longer track of motion.'],
  ['.epoch', 'Select or unselect this date. Blink flips between the two dates you pick.'],
  // --- 2D view: playback ---
  ['#p-prev', 'Go back one image (key ,).'],
  ['#p-play', 'Start or stop playing the images (key Space).'],
  ['#p-next', 'Go forward one image (key .).'],
  ['#p-more', 'Show or hide display options: speed, one image per visit, colours, target mark.'],
  ['#p-speed', 'Change how many images per second play. Each press picks the next speed.'],
  ['#p-visit', 'Turn on to show one image per visit instead of every exposure.'],
  ['#p-cmap', 'Change the image colours: grey or a heat palette (inferno). Each press picks the next one.'],
  ['#p-ring', 'Turn on or off a ring around the target at the centre of the image.'],
  // --- spectrum ---
  ['#spec-close', 'Close the spectrum.'],
]);

/** Buttons that get no "!" (their own text is the explanation, or they belong to a message). */
export const HINT_SKIP = '[data-answer], [data-no-hint]';

const clean = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');

/** The hint for a button, or '' for none. `el` needs `matches` and `getAttribute`. */
export function hintFor(el, rules = HINT_RULES) {
  if (!el || el.matches(HINT_SKIP)) return '';
  const own = clean(el.getAttribute('data-hint'));
  if (own) return own;
  for (const [sel, text] of rules) if (el.matches(sel)) return text;
  const title = clean(el.getAttribute('title'));
  return title === 'Press to change' ? '' : title;
}
