// The formula behind a ratio tile: saved searches combined into one number.
//
// A formula is a short expression over LETTERS, each standing for a saved
// search (A, B, C…), plus plain numbers and the operators + − × ÷, parentheses,
// and ∩ ("contacts in both"). A letter used as a number is its count; A∩B is
// the count of contacts matching both searches. The simple "A out of B" tile is
// just the formula `A ∩ B / B` (or `A / B` without the intersection), so both
// editor modes save exactly the same thing.
//
// Stored as text with ASCII operators (`A & B / B`) so it stays small and
// readable in a synced settings bag. The editor never lets anyone type it: it
// is built from chips, so the text only has to round-trip what the chips make.
// Everything here is pure, and errors point at TOKEN positions so the editor
// can underline the offending chips in place.

export type Op = '+' | '-' | '*' | '/' | '&';

export type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; letter: string }
  | { kind: 'op'; op: Op }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

/** Letters a formula may use, in the order they are handed out. */
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** How each token shows in the editor and on the tile. */
export function tokenLabel(t: Token): string {
  switch (t.kind) {
    case 'num': return formatPlain(t.value);
    case 'ref': return t.letter;
    case 'lparen': return '(';
    case 'rparen': return ')';
    case 'op': return OP_LABEL[t.op];
  }
}

export const OP_LABEL: Record<Op, string> = { '+': '+', '-': '−', '*': '×', '/': '÷', '&': '∩' };

// ---------------------------------------------------------------------------
// Text form
// ---------------------------------------------------------------------------

/** Tokens → the stored text. */
export function formulaToText(tokens: Token[]): string {
  return tokens.map((t) => {
    switch (t.kind) {
      case 'num': return String(t.value);
      case 'ref': return t.letter;
      case 'op': return t.op;
      case 'lparen': return '(';
      case 'rparen': return ')';
    }
  }).join(' ');
}

/**
 * Stored text → tokens. Characters this build doesn't understand (a newer
 * build's operator, a hand-edited backup) are dropped rather than failing the
 * whole tile; whatever is left still has to parse, so a dropped operator shows
 * up as an underlined gap instead of a silently different number.
 */
export function textToFormula(text: string): Token[] {
  const out: Token[] = [];
  const src = typeof text === 'string' ? text : '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\d|\./.test(ch)) {
      let j = i;
      while (j < src.length && /[\d.]/.test(src[j])) j++;
      const value = Number(src.slice(i, j));
      if (Number.isFinite(value)) out.push({ kind: 'num', value });
      i = j;
      continue;
    }
    if (/[A-Z]/.test(ch)) out.push({ kind: 'ref', letter: ch });
    else if (ch === '(') out.push({ kind: 'lparen' });
    else if (ch === ')') out.push({ kind: 'rparen' });
    else if ('+-*/&'.includes(ch)) out.push({ kind: 'op', op: ch as Op });
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A parsed formula. `from`/`to` are the token range it came from (to exclusive). */
export type FormulaNode =
  | { k: 'num'; value: number; from: number; to: number }
  /** A count of contacts: one search, or the intersection of several. */
  | { k: 'set'; letters: string[]; from: number; to: number }
  | { k: 'neg'; x: FormulaNode; from: number; to: number }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; l: FormulaNode; r: FormulaNode; from: number; to: number };

/**
 * What is wrong and where. `from`/`to` are token indices (to exclusive); when
 * the problem is that the formula stops too soon, both equal the token count —
 * "underline the empty space at the end".
 */
export interface FormulaError {
  message: string;
  from: number;
  to: number;
}

// Both shapes name both fields: this project doesn't build with strict null
// checks, under which `if (!r.ok)` would not narrow a plain union.
export type ParseResult =
  | { ok: true; node: FormulaNode; error?: undefined }
  | { ok: false; error: FormulaError; node?: undefined };

class Fail extends Error {
  constructor(public err: FormulaError) { super(err.message); }
}

/**
 * Precedence, loosest to tightest: + −, then × ÷, then unary minus, then ∩.
 * ∩ binds tightest because it isn't arithmetic at all — it builds the group of
 * contacts that then gets counted — so `A ∩ B / B` reads as "(A∩B) ÷ B".
 */
export function parseFormula(tokens: Token[]): ParseResult {
  if (tokens.length === 0) {
    return { ok: false, error: { message: 'Add a search or a number to start the formula.', from: 0, to: 0 } };
  }
  let i = 0;
  const end = tokens.length;
  const fail = (message: string, from: number, to = from + 1): never => { throw new Fail({ message, from, to }); };

  const expr = (): FormulaNode => {
    let l = term();
    while (i < end && tokens[i].kind === 'op' && ((tokens[i] as { op: Op }).op === '+' || (tokens[i] as { op: Op }).op === '-')) {
      const op = (tokens[i] as { op: '+' | '-' }).op;
      i++;
      const r = term();
      l = { k: 'bin', op, l, r, from: l.from, to: r.to };
    }
    return l;
  };

  const term = (): FormulaNode => {
    let l = unary();
    while (i < end && tokens[i].kind === 'op' && ((tokens[i] as { op: Op }).op === '*' || (tokens[i] as { op: Op }).op === '/')) {
      const op = (tokens[i] as { op: '*' | '/' }).op;
      i++;
      const r = unary();
      l = { k: 'bin', op, l, r, from: l.from, to: r.to };
    }
    return l;
  };

  const unary = (): FormulaNode => {
    const t = tokens[i];
    if (t && t.kind === 'op' && t.op === '-') {
      const from = i;
      i++;
      const x = unary();
      return { k: 'neg', x, from, to: x.to };
    }
    return intersection();
  };

  const intersection = (): FormulaNode => {
    let l = primary();
    while (i < end && tokens[i].kind === 'op' && (tokens[i] as { op: Op }).op === '&') {
      const at = i;
      if (l.k !== 'set') fail('∩ joins two searches — the left side is a number.', l.from, at + 1);
      i++;
      const r = primary();
      if (r.k !== 'set') fail('∩ joins two searches — the right side is a number.', at, r.to);
      const letters = [...(l as { letters: string[] }).letters];
      for (const x of (r as { letters: string[] }).letters) if (!letters.includes(x)) letters.push(x);
      l = { k: 'set', letters, from: l.from, to: r.to };
    }
    return l;
  };

  const primary = (): FormulaNode => {
    if (i >= end) return fail('The formula stops too soon — add a search or a number.', end, end);
    const t = tokens[i];
    const at = i;
    switch (t.kind) {
      case 'num': i++; return { k: 'num', value: t.value, from: at, to: at + 1 };
      case 'ref': i++; return { k: 'set', letters: [t.letter], from: at, to: at + 1 };
      case 'lparen': {
        i++;
        if (i < end && tokens[i].kind === 'rparen') return fail('Nothing inside these parentheses.', at, i + 1);
        const inner = expr();
        if (i >= end || tokens[i].kind !== 'rparen') return fail('This ( is never closed.', at);
        i++;
        return { ...inner, from: at, to: i };
      }
      case 'rparen': return fail('This ) has no matching (.', at);
      case 'op': return fail(`Expected a search or a number before ${OP_LABEL[t.op]}.`, at);
    }
  };

  try {
    const node = expr();
    if (i < end) {
      const t = tokens[i];
      if (t.kind === 'rparen') fail('This ) has no matching (.', i);
      fail('Put an operator between these.', i - 1, i + 1);
    }
    return { ok: true, node };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.err };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Checking the letters
// ---------------------------------------------------------------------------

/** What a letter stands for right now. */
export type LetterStatus = 'ok' | 'unknown' | 'deleted';

/**
 * Parse, then make sure every letter means something. Two different problems:
 * a letter the tile never assigned (`unknown`), and one whose saved search has
 * since been deleted (`deleted`) — the second is the common one, and the
 * message says which search to replace rather than just "invalid".
 */
export function checkFormula(tokens: Token[], status: (letter: string) => LetterStatus): ParseResult {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'ref') continue;
    const s = status(t.letter);
    if (s === 'unknown') return { ok: false, error: { message: `${t.letter} isn't one of this tile's searches.`, from: i, to: i + 1 } };
    if (s === 'deleted') return { ok: false, error: { message: `The saved search for ${t.letter} was deleted — pick another one.`, from: i, to: i + 1 } };
  }
  return parseFormula(tokens);
}

/** Every letter the formula uses, in order of first use. */
export function lettersUsed(tokens: Token[]): string[] {
  const out: string[] = [];
  for (const t of tokens) if (t.kind === 'ref' && !out.includes(t.letter)) out.push(t.letter);
  return out;
}

// ---------------------------------------------------------------------------
// Evaluating
// ---------------------------------------------------------------------------

/**
 * The formula's value, or null when it has none — dividing by zero, mostly.
 * `count` answers "how many contacts are in all of these searches". A null
 * anywhere makes the whole result null: "—" is honest, a number computed
 * around a hole is not.
 */
export function evaluate(node: FormulaNode, count: (letters: string[]) => number): number | null {
  switch (node.k) {
    case 'num': return node.value;
    case 'set': return count(node.letters);
    case 'neg': {
      const x = evaluate(node.x, count);
      return x === null ? null : -x;
    }
    case 'bin': {
      const l = evaluate(node.l, count);
      const r = evaluate(node.r, count);
      if (l === null || r === null) return null;
      let v: number;
      switch (node.op) {
        case '+': v = l + r; break;
        case '-': v = l - r; break;
        case '*': v = l * r; break;
        case '/': if (r === 0) return null; v = l / r; break;
      }
      return Number.isFinite(v) ? v : null;
    }
  }
}

/**
 * The top-level "X ÷ Y", if that is the formula's shape — what the tile and the
 * preview show as "12 of 48". Either side may be any expression; only a side
 * that is a plain group of contacts can be clicked through to its list.
 */
export function fractionOf(node: FormulaNode): { num: FormulaNode; den: FormulaNode } | null {
  return node.k === 'bin' && node.op === '/' ? { num: node.l, den: node.r } : null;
}

// ---------------------------------------------------------------------------
// The simple mode
// ---------------------------------------------------------------------------

/** "A out of B": A∩B ÷ B when `intersect`, else A ÷ B. */
export function simpleFormula(intersect: boolean): Token[] {
  const A: Token = { kind: 'ref', letter: 'A' };
  const B: Token = { kind: 'ref', letter: 'B' };
  return intersect
    ? [A, { kind: 'op', op: '&' }, B, { kind: 'op', op: '/' }, B]
    : [A, { kind: 'op', op: '/' }, B];
}

/**
 * Whether these tokens are exactly what the simple mode makes, and with which
 * setting — the test for opening a saved tile in simple mode rather than
 * advanced. Anything else, however close, opens in advanced so nothing about
 * the formula is hidden.
 */
export function readSimple(tokens: Token[]): { intersect: boolean } | null {
  const text = formulaToText(tokens);
  if (text === formulaToText(simpleFormula(true))) return { intersect: true };
  if (text === formulaToText(simpleFormula(false))) return { intersect: false };
  return null;
}

// ---------------------------------------------------------------------------
// Showing the result
// ---------------------------------------------------------------------------

export type TileFormat = 'percent' | 'number' | 'ratio';

export const TILE_FORMATS: { value: TileFormat; label: string }[] = [
  { value: 'percent', label: 'Percentage' },
  { value: 'number', label: 'Number' },
  { value: 'ratio', label: 'Ratio (1 in 4)' },
];

/** Up to `digits` decimals, trailing zeros dropped. */
function round(v: number, digits: number): string {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return (Object.is(r, -0) ? 0 : r).toLocaleString('en-US', { maximumFractionDigits: digits });
}

function formatPlain(v: number): string {
  return round(v, 4);
}

/**
 * The value as the tile shows it. No value (divide by zero) is "—" in every
 * format — never NaN, never Infinity, never an error.
 */
export function formatValue(v: number | null, format: TileFormat): string {
  if (v === null || !Number.isFinite(v)) return '—';
  switch (format) {
    case 'percent':
      return `${round(v * 100, 1)}%`;
    case 'number':
      return round(v, 2);
    case 'ratio': {
      // "1 in 4" reads naturally only for a share between 0 and 1. Above 1 the
      // same idea is "3 to 1"; a negative or zero rate has no "1 in" form.
      if (v <= 0) return round(v, 2);
      if (v >= 1) return `${round(v, v >= 10 ? 0 : 1)} to 1`;
      const n = 1 / v;
      return `1 in ${round(n, n >= 10 ? 0 : 1)}`;
    }
  }
}
