import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFormula, evaluateFormula, FormulaError } from '../src/field/formula.js';

const ev = (src, images, n = 1) => [...evaluateFormula(parseFormula(src), images, n)];

test('precedence, parentheses and unary minus', () => {
  const img = { D6: Float32Array.of(10), D1: Float32Array.of(4), b40: Float32Array.of(2) };
  assert.deepEqual(ev('D6 - D1', img), [6]);
  assert.deepEqual(ev('D6 - D1 * b40', img), [2]);
  assert.deepEqual(ev('(D6 - D1) * b40', img), [12]);
  assert.deepEqual(ev('-D1 + D6', img), [6]);
  assert.deepEqual(ev('2*D6/b40', img), [10]);
  assert.deepEqual(ev('d6-d1', img), [6]); // case-insensitive
});

test('inputs are listed once', () => {
  const { inputs } = parseFormula('(b88 + b89) / b88');
  assert.deepEqual(inputs.map((i) => i.key), ['b88', 'b89']);
});

test('missing data and division by zero give NaN', () => {
  const img = { D6: Float32Array.of(1, NaN, Infinity), D1: Float32Array.of(0, 1, 1) };
  const out = ev('D6 / D1', img, 3);
  assert.ok(out.every(Number.isNaN));
});

test('bad formulas fail with a readable message', () => {
  for (const bad of ['', 'D6 -', 'D6 D1', '(D6', 'D6)', 'b0', 'b500', 'D7', 'alert(1)', '3 + 4', '* D6']) {
    assert.throws(() => parseFormula(bad), FormulaError, bad);
  }
});
