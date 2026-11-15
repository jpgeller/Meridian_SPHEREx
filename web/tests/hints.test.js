import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hintFor, HINT_RULES } from '../src/ui/hintText.js';

// A stand-in for a <button>: `matches` knows the selectors it was told it matches.
const el = ({ matches = [], attrs = {} } = {}) => ({
  matches: (sel) => sel.split(',').some((s) => matches.includes(s.trim())),
  getAttribute: (k) => attrs[k] ?? null,
});

test('hints: data-hint, then the catalogue, then the title; nothing for answers or "Press to change"', () => {
  assert.equal(hintFor(el({ matches: ['#p-play'], attrs: { 'data-hint': '  Own   words ' } })), 'Own words');
  assert.match(hintFor(el({ matches: ['#p-play'], attrs: { title: 'ignored' } })), /Start or stop playing/);
  assert.equal(hintFor(el({ attrs: { title: 'The centre of our galaxy.' } })), 'The centre of our galaxy.');
  assert.equal(hintFor(el({ matches: ['[data-answer]'], attrs: { title: 'x' } })), '');
  assert.equal(hintFor(el({ attrs: { title: 'Press to change' } })), '');
  assert.equal(hintFor(el()), '');
  assert.equal(hintFor(null), '');
});

test('hints: every explanation is one or two short sentences, every selector unique', () => {
  const seen = new Set();
  for (const [sel, text] of HINT_RULES) {
    assert.ok(!seen.has(sel), `duplicate selector ${sel}`);
    seen.add(sel);
    assert.ok(text.length >= 10 && text.length <= 140, `${sel}: ${text.length} characters`);
    assert.match(text, /[.)]$/, `${sel} ends a sentence`);
  }
});
