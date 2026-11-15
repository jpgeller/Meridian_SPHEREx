// Guide pop-up (guide/popup.js): the pure logic behind the card (words, answers, cool-down,
// auto-hide timer, where the card goes so it does not cover the target or the centre). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clipWords,
  normaliseAnswers,
  centreZone,
  spotRects,
  chooseSpot,
  offerKey,
  createCooldown,
  createTimer,
  AUTO_HIDE_MS,
  COOLDOWN_MS,
  MAX_WORDS,
} from '../src/guide/popup.js';

test('clipWords: short text untouched (spaces tidied), long text cut with an ellipsis', () => {
  assert.deepEqual(clipWords('  Want   help\nidentifying this? '), { text: 'Want help identifying this?', clipped: false });
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  const { text, clipped } = clipWords(long);
  assert.equal(clipped, true);
  assert.equal(text.split(' ').length, MAX_WORDS);
  assert.ok(text.endsWith('w44…'));
  assert.equal(clipWords('one, two, three.', 2).text, 'one, two…', 'trailing punctuation before the ellipsis is dropped');
  assert.deepEqual(clipWords(undefined), { text: '', clipped: false });
});

test('normaliseAnswers: ids, labels and objects; default "Got it"; at most 3, no duplicates', () => {
  assert.deepEqual(normaliseAnswers(), [{ id: 'got_it', label: 'Got it' }]);
  assert.deepEqual(normaliseAnswers([]), [{ id: 'got_it', label: 'Got it' }]);
  assert.deepEqual(normaliseAnswers(['got_it', 'more', 'close']), [
    { id: 'got_it', label: 'Got it' },
    { id: 'more', label: 'Show me more' },
    { id: 'close', label: 'Close' },
  ]);
  // known labels map back to the same ids, so the runner can match either
  assert.deepEqual(
    normaliseAnswers(['Got it', 'Show me more']).map((a) => a.id),
    ['got_it', 'more'],
  );
  assert.deepEqual(normaliseAnswers(['Play it again']), [{ id: 'play_it_again', label: 'Play it again' }]);
  assert.deepEqual(normaliseAnswers([{ id: 'next', label: 'Next' }]), [{ id: 'next', label: 'Next' }]);
  assert.deepEqual(normaliseAnswers([{ id: 'close' }]), [{ id: 'close', label: 'Close' }]);
  assert.equal(normaliseAnswers(['got_it', 'Got it', 'close']).length, 2, 'duplicates dropped');
  assert.equal(normaliseAnswers(['a', 'b', 'c', 'd']).length, 3);
  assert.deepEqual(normaliseAnswers([null, 42, '', {}]), [{ id: 'got_it', label: 'Got it' }]);
});

const VIEW = { w: 1280, h: 800 };
const LAYOUT = { edge: 12, leftTop: 116, leftW: 264, toolsW: 284, dockTop: 668, dockLeft: 318, dockRight: 1138 };
const STEP = { w: 340, h: 214 };
const byId = (list) => Object.fromEntries(list.map((c) => [c.id, c.rect]));

test('spotRects: top right first, then top left, then above the dock; never the logo corner', () => {
  const spots = spotRects({ viewport: VIEW, size: STEP, layout: LAYOUT });
  assert.deepEqual(spots.map((c) => c.id), ['top-right', 'top-left', 'bottom-right', 'bottom-left']);
  const r = byId(spots);
  assert.deepEqual(r['top-right'], { x: 928, y: 12, w: 340, h: 214 });
  assert.deepEqual(r['top-left'], { x: 12, y: 116, w: 340, h: 214 }, 'below Aladin\'s buttons, under the search bar');
  // above the dock: the right one stops left of the tools column, the left one starts with the dock
  assert.deepEqual(r['bottom-right'], { x: 632, y: 442, w: 340, h: 214 });
  assert.deepEqual(r['bottom-left'], { x: 318, y: 442, w: 340, h: 214 });
  for (const c of spots) {
    const logo = { x: VIEW.w - 112, y: LAYOUT.dockTop, w: 112, h: VIEW.h - LAYOUT.dockTop };
    assert.ok(c.rect.x + c.rect.w <= logo.x || c.rect.y + c.rect.h <= logo.y, `${c.id} keeps the logo corner free`);
  }
  // the field view: top right 72 px down (below "Back to sky"), then the sides of the image
  const field = byId(spotRects({ viewport: VIEW, size: STEP, field: true, layout: LAYOUT }));
  assert.deepEqual(Object.keys(field), ['top-right', 'right', 'left']);
  assert.deepEqual(field['top-right'], { x: 912, y: 72, w: 340, h: 214 });
  assert.deepEqual(field.left, { x: 28, y: 293, w: 340, h: 214 });
  // a narrow window: every spot stays on screen
  for (const c of spotRects({ viewport: { w: 360, h: 640 }, size: { w: 336, h: 214 }, layout: {} })) {
    assert.ok(c.rect.x >= 12 && c.rect.x + c.rect.w <= 348 && c.rect.y >= 12, c.id);
  }
});

test('chooseSpot: first clear spot; keeps its spot while clear; least overlap when none is', () => {
  const spots = spotRects({ viewport: VIEW, size: STEP, layout: LAYOUT });
  const zone = centreZone(VIEW);
  assert.deepEqual(zone, { x: 640, y: 400, r: 80 });
  assert.deepEqual(centreZone(VIEW, { x: 600, y: 350 }), { x: 600, y: 350, r: 80 }, 'a centre given by the caller');
  assert.equal(chooseSpot(spots, [zone]), 'top-right', 'the default leaves the middle free');
  assert.equal(chooseSpot(spots, [zone, null, undefined]), 'top-right');
  // a star under the top-right card: move to the top left
  const star = { x: 1100, y: 100, r: 24 };
  assert.equal(chooseSpot(spots, [zone, star]), 'top-left');
  assert.equal(chooseSpot(spots, [zone, star], 'top-right'), 'top-left', 'a blocked spot is left');
  // a star just below the card does not move it (the caller adds the pad)
  assert.equal(chooseSpot(spots, [zone, { x: 1100, y: 260, r: 24 }]), 'top-right');
  // a control box under the card works too
  assert.equal(chooseSpot(spots, [{ rect: { x: 997, y: 120, w: 82, h: 40 } }]), 'top-left');
  // hysteresis: once at the top left, stay there even when the top right is free again
  assert.equal(chooseSpot(spots, [zone], 'top-left'), 'top-left');
  // both top spots blocked -> above the dock (the right one first), unless the centre is in the way
  const stars = [{ x: 1100, y: 100, r: 24 }, { x: 200, y: 200, r: 24 }];
  assert.equal(chooseSpot(spots, stars), 'bottom-right');
  // nothing clear (the middle blocks both dock spots): the least overlap wins, the first spot on a tie
  const crowd = [zone, { x: 400, y: 500, r: 24 }, { x: 200, y: 200, r: 24 }];
  assert.equal(chooseSpot(spots, [...crowd, { x: 1100, y: 100, r: 24 }]), 'top-right');
  assert.equal(chooseSpot(spots, [...crowd, { x: 1100, y: 100, r: 40 }]), 'top-left');
  // weights: a light shape (the hand-off button) loses against the target
  const handoff = { rect: { x: 540, y: 600, w: 200, h: 64 }, weight: 0.25 };
  const big = { x: 1100, y: 100, r: 120 };
  assert.equal(chooseSpot([spots[0], spots[2]], [big, handoff]), 'bottom-right');
  // a tie keeps the current spot; no candidates -> null
  const block = { rect: { x: 0, y: 0, w: 1280, h: 800 } };
  assert.equal(chooseSpot(spots, [block], 'bottom-left'), 'bottom-left');
  assert.equal(chooseSpot([], [zone]), null);
});

test('offerKey: target first, then key, then the text', () => {
  assert.equal(offerKey({ target: 'sky:barnard', key: 'identify', text: 'Hi' }), 'sky:barnard');
  assert.equal(offerKey({ key: 'colours', text: 'Hi' }), 'colours');
  assert.equal(offerKey({ text: 'Hi' }), 'Hi');
  assert.equal(offerKey(), '');
});

test('createCooldown: blocks a key for 60 s, others stay free, expires on its own', () => {
  let t = 1000;
  const cd = createCooldown({ now: () => t });
  assert.equal(COOLDOWN_MS, 60000);
  assert.equal(cd.isCooling('sky:barnard'), false);
  cd.mark('sky:barnard');
  assert.equal(cd.isCooling('sky:barnard'), true);
  assert.equal(cd.isCooling('sky:r_dra'), false);
  t += 59000;
  assert.equal(cd.remaining('sky:barnard'), 1000);
  t += 1000;
  assert.equal(cd.isCooling('sky:barnard'), false);
  cd.mark('a', 5000);
  cd.mark('b');
  cd.clear('a');
  assert.equal(cd.isCooling('a'), false);
  assert.equal(cd.isCooling('b'), true);
  cd.clear();
  assert.equal(cd.isCooling('b'), false);
});

function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => (timers.set(++seq, { fn, at: t + ms }), seq),
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      t += ms;
      for (const [id, { fn, at }] of [...timers]) {
        if (at <= t) {
          timers.delete(id);
          fn();
        }
      }
    },
  };
}

test('createTimer: fires after 14 s; pause keeps the time left; cancel stops it', () => {
  const clock = fakeClock();
  let fired = 0;
  const timer = createTimer(AUTO_HIDE_MS, () => fired++, clock);
  assert.equal(AUTO_HIDE_MS, 14000);
  timer.start();
  assert.equal(timer.running(), true);
  clock.advance(13999);
  assert.equal(fired, 0);
  clock.advance(1);
  assert.equal(fired, 1);
  assert.equal(timer.running(), false);

  // hover / focus on the card pauses it
  timer.start();
  clock.advance(8000);
  timer.pause();
  clock.advance(60000);
  assert.equal(fired, 1, 'paused: no hide');
  timer.resume();
  clock.advance(5999);
  assert.equal(fired, 1);
  clock.advance(1);
  assert.equal(fired, 2, 'resumes with the 6 s that were left');

  // gaze mode: cancelled, never fires
  timer.start();
  timer.cancel();
  clock.advance(AUTO_HIDE_MS * 2);
  assert.equal(fired, 2);
  // start() restarts the full time
  timer.start();
  clock.advance(6000);
  timer.start();
  clock.advance(6000);
  assert.equal(fired, 2);
  clock.advance(8000);
  assert.equal(fired, 3);
});
