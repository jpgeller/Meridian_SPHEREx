import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STEPS, shouldOffer, readMs, placeCard, glideMs, TOUR_KEY } from '../src/tutorial/tourScript.js';

const params = (q) => new URLSearchParams(q);

test('tour: offered on a first visit only; ?tour=1 / ?tour=0 win; never in tests or with an eye tracker', () => {
  assert.equal(shouldOffer({ params: params(''), stored: null }), true);
  assert.equal(shouldOffer({ params: params(''), stored: 'done' }), false);
  assert.equal(shouldOffer({ params: params(''), stored: 'skipped' }), false);
  assert.equal(shouldOffer({ params: params(''), stored: null, webdriver: true }), false);
  assert.equal(shouldOffer({ params: params('?gaze_ws=8765'), stored: null }), false);
  assert.equal(shouldOffer({ params: params('?tour=1'), stored: 'done', webdriver: true }), true);
  assert.equal(shouldOffer({ params: params('?tour=0'), stored: null }), false);
});

test('tour: steps are well formed, sky first, the 2D view after "Open the time-lapse", a closing card last', () => {
  const ids = STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const s of STEPS) {
    assert.ok(['sky', 'field'].includes(s.view), s.id);
    assert.ok(s.title && s.say, s.id);
    for (const a of s.do ?? []) {
      const kinds = ['click', 'type', 'drag', 'cmd', 'wait', 'restore'].filter((k) => k in a && !(k === 'cmd' && 'drag' in a)); // a drag names the command it runs
      assert.equal(kinds.length, 1, `${s.id}: one kind per act`);
    }
  }
  const open = ids.indexOf('open');
  assert.ok(STEPS.slice(0, open + 1).every((s) => s.view === 'sky'));
  assert.ok(STEPS.slice(open + 1, ids.indexOf('back') + 1).every((s) => s.view === 'field'));
  assert.equal(STEPS.at(-1).id, 'end');
  assert.equal(STEPS.at(-1).target, undefined);
  assert.equal(STEPS.at(-1).ms, 0);
  assert.equal(TOUR_KEY, 'h');
});

test('tour: every id or data- selector a step uses exists in the app source', () => {
  const src = ['index.html', 'src/ui/controls.js', 'src/sky/handoff.js', 'src/field/fieldView.js', 'src/field/player.js', 'src/ui/inputModeButton.js', 'src/guide/popup.js']
    .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))
    .join('\n');
  const sels = STEPS.flatMap((s) => [s.target, ...(s.do ?? []).flatMap((a) => [a.click, a.into])]).filter(Boolean);
  for (const sel of sels) {
    for (const [, id] of sel.matchAll(/#([\w-]+)/g)) assert.ok(src.includes(`id="${id}"`) || src.includes(`id = '${id}'`) || src.includes(`.id = '${id}'`), `${sel}: #${id}`);
    for (const [, attr] of sel.matchAll(/\[(data-[\w-]+)=/g)) assert.ok(src.includes(attr), `${sel}: ${attr}`);
  }
});

test('tour: a caption stays long enough to read, within 3.5–10 s', () => {
  assert.equal(readMs(''), 3500);
  assert.ok(readMs('a b c d e f g h i j k l m n o p q r s t') > 5000);
  assert.equal(readMs('word '.repeat(200)), 10000);
});

test('tour: the cursor glides 450–1100 ms, longer for farther', () => {
  assert.equal(glideMs(0), 450);
  assert.ok(glideMs(700) > glideMs(100));
  assert.equal(glideMs(5000), 1100);
});

test('tour: the caption card sits beside its target, never on it, and 6 % from the screen edges', () => {
  const view = { w: 1280, h: 800 };
  const edge = { x: 81, y: 52 };
  const card = { w: 400, h: 220 };
  const overlaps = (p, t) => p.left < t.right && t.left < p.left + card.w && p.top < t.bottom && t.top < p.top + card.h;
  const inside = (p) => p.left >= edge.x && p.top >= edge.y && p.left + card.w <= view.w - edge.x && p.top + card.h <= view.h - edge.y;
  const targets = [
    { left: 100, top: 300, right: 170, bottom: 360 }, // a place button, left panel
    { left: 1090, top: 52, right: 1200, bottom: 116 }, // the AI Guide pill, top right
    { left: 460, top: 580, right: 980, bottom: 660 }, // the band dock, bottom
    { left: 540, top: 60, right: 760, bottom: 124 }, // the search box, top
  ];
  for (const t of targets) {
    const p = placeCard(t, card, view, edge);
    assert.ok(!overlaps(p, t), JSON.stringify(t));
    assert.ok(inside(p), JSON.stringify(p));
  }
  // first choice: to the right of the target, centred on it
  assert.deepEqual(placeCard(targets[0], card, view, edge), { left: 194, top: 220 });
  // no target, or the whole sky: the middle, low down
  const mid = placeCard(null, card, view, edge);
  assert.equal(mid.left, 440);
  assert.deepEqual(placeCard({ left: 0, top: 0, right: 1280, bottom: 800 }, card, view, edge), mid);
});
