// Safe band formulas, e.g. "D6 - D1", "(b88 + b89) / b40", "2*D5 - D6".
// Tokens: numbers, b<k> (cube band 1-101), D<d> (detector 1-6), + - * / and parentheses.
// Parsed with the shunting-yard algorithm into postfix; never uses eval().

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([bB]\d{1,3})|([dD][1-6])|([-+*/()]))/y;
const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, neg: 3 };
const MAX_LEN = 200;

export class FormulaError extends Error {}

/** "b88" -> {kind:'band', value:88}; "D6" -> {kind:'detector', value:6} */
function operand(text) {
  if (/^[bB]/.test(text)) {
    const k = Number(text.slice(1));
    if (k < 1 || k > 101) throw new FormulaError(`band ${k} is outside 1–101`);
    return { kind: 'band', value: k, key: `b${k}` };
  }
  const d = Number(text.slice(1));
  return { kind: 'detector', value: d, key: `D${d}` };
}

/** Parse to postfix. Returns { rpn, inputs } where inputs are the distinct operands. */
export function parseFormula(src) {
  if (typeof src !== 'string' || !src.trim()) throw new FormulaError('type a formula, e.g. D6 - D1');
  if (src.length > MAX_LEN) throw new FormulaError('formula is too long');
  const out = [];
  const ops = [];
  const inputs = new Map();
  let expectOperand = true;
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (!src.slice(pos).trim()) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new FormulaError(`can't read “${src.slice(pos).trim().slice(0, 8)}”`);
    pos = TOKEN.lastIndex;
    const [, num, band, det, op] = m;
    if (num !== undefined) {
      if (!expectOperand) throw new FormulaError('missing operator between values');
      out.push({ type: 'num', value: Number(num) });
      expectOperand = false;
    } else if (band || det) {
      if (!expectOperand) throw new FormulaError('missing operator between values');
      const o = operand(band ?? det);
      inputs.set(o.key, o);
      out.push({ type: 'input', key: o.key });
      expectOperand = false;
    } else if (op === '(') {
      if (!expectOperand) throw new FormulaError('missing operator before “(”');
      ops.push(op);
    } else if (op === ')') {
      while (ops.length && ops.at(-1) !== '(') out.push({ type: 'op', op: ops.pop() });
      if (!ops.length) throw new FormulaError('unbalanced “)”');
      ops.pop();
      expectOperand = false;
    } else {
      const o = expectOperand && op === '-' ? 'neg' : op;
      if (expectOperand && o !== 'neg') throw new FormulaError(`“${op}” needs a value before it`);
      while (ops.length && ops.at(-1) !== '(' && PREC[ops.at(-1)] >= PREC[o] && o !== 'neg') {
        out.push({ type: 'op', op: ops.pop() });
      }
      ops.push(o);
      expectOperand = true;
    }
  }
  if (expectOperand) throw new FormulaError('formula ends with an operator');
  while (ops.length) {
    const o = ops.pop();
    if (o === '(') throw new FormulaError('unbalanced “(”');
    out.push({ type: 'op', op: o });
  }
  if (!inputs.size) throw new FormulaError('use at least one band (b40) or detector (D6)');
  return { rpn: out, inputs: [...inputs.values()] };
}

/**
 * Evaluate per pixel. `images` maps input key -> Float32Array (same length).
 * Non-finite inputs (no data, saturated) and non-finite results become NaN.
 */
export function evaluateFormula({ rpn }, images, length) {
  const out = new Float32Array(length);
  const stack = new Float64Array(rpn.length);
  for (let i = 0; i < length; i++) {
    let sp = 0;
    let bad = false;
    for (const t of rpn) {
      if (t.type === 'num') stack[sp++] = t.value;
      else if (t.type === 'input') {
        const v = images[t.key][i];
        if (!Number.isFinite(v)) {
          bad = true;
          break;
        }
        stack[sp++] = v;
      } else if (t.op === 'neg') stack[sp - 1] = -stack[sp - 1];
      else {
        const b = stack[--sp];
        const a = stack[--sp];
        stack[sp++] = t.op === '+' ? a + b : t.op === '-' ? a - b : t.op === '*' ? a * b : a / b;
      }
    }
    const v = stack[0];
    out[i] = bad || !Number.isFinite(v) ? NaN : v;
  }
  return out;
}
