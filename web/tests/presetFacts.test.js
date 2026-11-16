import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../src/sky/presets.js';
import { factsFor, promptCard } from '../src/sky/presetFacts.js';
import { identifyTour } from '../src/guide/tours.js';

test('preset fact cards: every place has a card with hook, facts and sources', () => {
  for (const p of PRESETS) {
    const c = factsFor(p.id);
    assert.ok(c, `card for ${p.id}`);
    assert.ok(c.hook?.trim(), `${p.id} hook`);
    assert.ok(c.facts?.length >= 3, `${p.id} facts`);
    assert.ok(c.sources?.length, `${p.id} sources`);
    assert.equal(promptCard(c).sources, undefined);
  }
  assert.equal(factsFor('sky:barnard').moves, 10.4);
  assert.equal(factsFor('milky_way').distance.ly, 27000);
});

test('place tours: at most 5 steps, each step 35 words or fewer', () => {
  for (const p of PRESETS) {
    const t = identifyTour(p.id);
    assert.ok(t.steps.length <= 5, p.id);
    for (const s of t.steps) assert.ok(s.say.split(/\s+/).length <= 35, `${p.id}: ${s.say}`);
  }
});
