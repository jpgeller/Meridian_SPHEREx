// Guide pop-up (guide/popup.js): the pure logic behind the card (words, answers, cool-down,
// auto-hide timer, "would it cover the target or the centre"). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clipWords,
  normaliseAnswers,
  centreZone,
  wouldCover,
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

test('wouldCover: the centre zone, a sky point (with its pad) and a control box', () => {
  const view = { w: 1280, h: 800 };
  const card = { x: 928, y: 12, w: 340, h: 214 }; // the step card, top right
  const zone = centreZone(view);
  assert.deepEqual(zone, { x: 640, y: 400, r: 80 });
  assert.equal(wouldCover(card, [zone]), false, 'the top-right card leaves the middle free');
  assert.equal(wouldCover({ x: 500, y: 300, w: 340, h: 214 }, [zone]), true);
  // a centre given by the caller (the field view's target)
  assert.deepEqual(centreZone(view, { x: 600, y: 350 }), { x: 600, y: 350, r: 80 });
  // a star under the card, one just outside, one within the pad
  assert.equal(wouldCover(card, [{ x: 1100, y: 100, r: 24 }]), true);
  assert.equal(wouldCover(card, [{ x: 1100, y: 330, r: 24 }]), false);
  assert.equal(wouldCover(card, [{ x: 1100, y: 240, r: 0 }]), true, '24 px pad around a point');
  assert.equal(wouldCover(card, [{ x: 1100, y: 240, r: 0 }], 0), false);
  // a control (the a button half under the card, one just below it) and nulls
  assert.equal(wouldCover(card, [{ x: 1038, y: 240, rect: { x: 997, y: 220, w: 82, h: 40 } }]), true);
  assert.equal(wouldCover(card, [{ x: 1038, y: 300, rect: { x: 997, y: 280, w: 82, h: 40 } }]), false);
  assert.equal(wouldCover(card, [null, undefined]), false);
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

test('createTimer: fires after 12 s; pause keeps the time left; cancel stops it', () => {
  const clock = fakeClock();
  let fired = 0;
  const timer = createTimer(AUTO_HIDE_MS, () => fired++, clock);
  assert.equal(AUTO_HIDE_MS, 12000);
  timer.start();
  assert.equal(timer.running(), true);
  clock.advance(11999);
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
  clock.advance(3999);
  assert.equal(fired, 1);
  clock.advance(1);
  assert.equal(fired, 2, 'resumes with the 4 s that were left');

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
  clock.advance(6000);
  assert.equal(fired, 3);
});
