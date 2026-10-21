import { describe, it, expect } from 'vitest';
import {
  textToFormula, formulaToText, parseFormula, checkFormula, evaluate, fractionOf,
  simpleFormula, readSimple, formatValue, lettersUsed, type FormulaNode, type Token,
} from './tileFormula';

const COUNTS: Record<string, number> = { A: 12, B: 48, C: 4, Z: 0 };
/** Fake intersection: the smallest member, minus one per extra search. */
const count = (letters: string[]) =>
  letters.length === 1 ? COUNTS[letters[0]] : Math.min(...letters.map((l) => COUNTS[l])) - (letters.length - 1);

function value(text: string): number | null {
  const r = parseFormula(textToFormula(text));
  if (!r.ok) throw new Error(`did not parse: ${text} — ${r.error.message}`);
  return evaluate(r.node, count);
}

function errorOf(text: string) {
  const r = parseFormula(textToFormula(text));
  if (r.ok) throw new Error(`parsed but should not have: ${text}`);
  return r.error;
}

describe('text form', () => {
  it('round-trips what the chips make', () => {
    const t = '( A & B ) / B * 100 - 2.5';
    expect(formulaToText(textToFormula(t))).toBe(t);
  });

  it('reads compact text and drops characters it does not know', () => {
    expect(formulaToText(textToFormula('A&B/B'))).toBe('A & B / B');
    expect(formulaToText(textToFormula('A % B'))).toBe('A B');
  });
});

describe('precedence', () => {
  it('multiplies and divides before adding and subtracting', () => {
    expect(value('A + B / 4')).toBe(24);
    expect(value('A - C * 2')).toBe(4);
    expect(value('2 * 3 + 4')).toBe(10);
  });

  it('is left-associative within a level', () => {
    expect(value('48 / 4 / 2')).toBe(6);
    expect(value('10 - 3 - 2')).toBe(5);
  });

  it('binds ∩ tighter than arithmetic', () => {
    // (A∩B) ÷ B, not A ∩ (B ÷ B)
    expect(value('A & B / B')).toBe(11 / 48); // fake A∩B is 11
    expect(value('A & B & C')).toBe(2);
  });

  it('handles unary minus', () => {
    expect(value('- A + 20')).toBe(8);
    expect(value('2 * - C')).toBe(-8);
    expect(value('- - 3')).toBe(3);
  });
});

describe('parentheses', () => {
  it('override precedence', () => {
    expect(value('( A + B ) / 4')).toBe(15);
    expect(value('( ( 2 ) )')).toBe(2);
  });

  it('may wrap a group of contacts and still intersect', () => {
    expect(value('( A & B ) & C')).toBe(2);
    expect(value('( A ) & B')).toBe(11);
  });

  it('report an unclosed ( at the parenthesis', () => {
    const e = errorOf('( A + B');
    expect(e.message).toMatch(/never closed/);
    expect([e.from, e.to]).toEqual([0, 1]);
  });

  it('report a stray ) at itself', () => {
    const e = errorOf('A + B )');
    expect(e.message).toMatch(/no matching/);
    expect([e.from, e.to]).toEqual([3, 4]);
  });

  it('reject empty parentheses', () => {
    expect(errorOf('A * ( )').message).toMatch(/Nothing inside/);
  });
});

describe('divide by zero', () => {
  it('has no value instead of Infinity or NaN', () => {
    expect(value('A / Z')).toBeNull();
    expect(value('A / ( B - 48 )')).toBeNull();
    expect(value('0 / 0')).toBeNull();
  });

  it('makes the whole formula valueless', () => {
    expect(value('1 + A / Z')).toBeNull();
    expect(value('- ( A / Z )')).toBeNull();
  });

  it('shows as a dash in every format', () => {
    for (const f of ['percent', 'number', 'ratio'] as const) expect(formatValue(null, f)).toBe('—');
    expect(formatValue(NaN, 'percent')).toBe('—');
  });

  it('a zero numerator is fine', () => {
    expect(value('Z / A')).toBe(0);
  });
});

describe('malformed formulas', () => {
  it('rejects an empty formula', () => {
    expect(parseFormula([]).ok).toBe(false);
  });

  it('points at the end when the formula stops too soon', () => {
    const e = errorOf('A +');
    expect([e.from, e.to]).toEqual([2, 2]);
  });

  it('points at two operands with nothing between them', () => {
    const e = errorOf('A B');
    expect(e.message).toMatch(/operator between/);
    expect([e.from, e.to]).toEqual([0, 2]);
  });

  it('points at an operator with nothing before it', () => {
    const e = errorOf('* A');
    expect([e.from, e.to]).toEqual([0, 1]);
  });

  it('refuses ∩ with a number on either side', () => {
    expect(errorOf('2 & A').message).toMatch(/left side/);
    expect(errorOf('A & 2').message).toMatch(/right side/);
    expect(errorOf('( A + B ) & C').message).toMatch(/left side/);
  });
});

describe('letters', () => {
  const tokens = textToFormula('A & B / C');

  it('are accepted when each stands for a search', () => {
    expect(checkFormula(tokens, () => 'ok').ok).toBe(true);
  });

  it('flag an unknown letter at its own chip', () => {
    const r = checkFormula(tokens, (l) => (l === 'C' ? 'unknown' : 'ok'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/isn't one of this tile's searches/);
      expect([r.error.from, r.error.to]).toEqual([4, 5]);
    }
  });

  it('say which search was deleted', () => {
    const r = checkFormula(tokens, (l) => (l === 'B' ? 'deleted' : 'ok'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/for B was deleted/);
      expect([r.error.from, r.error.to]).toEqual([2, 3]);
    }
  });

  it('lists the letters used, once each, in order', () => {
    expect(lettersUsed(textToFormula('C + A & C / A'))).toEqual(['C', 'A']);
  });
});

describe('fraction shape', () => {
  const parsed = (t: string): FormulaNode => {
    const r = parseFormula(textToFormula(t));
    if (!r.ok) throw new Error(r.error.message);
    return r.node;
  };

  it('splits a top-level division', () => {
    const f = fractionOf(parsed('A & B / B'))!;
    expect(f.num).toMatchObject({ k: 'set', letters: ['A', 'B'] });
    expect(f.den).toMatchObject({ k: 'set', letters: ['B'] });
  });

  it('is absent when the top level is not a division', () => {
    expect(fractionOf(parsed('A / B * 100'))).toBeNull();
    expect(fractionOf(parsed('A + B'))).toBeNull();
  });
});

describe('simple mode', () => {
  it('is A∩B ÷ B with the checkbox on, A ÷ B with it off', () => {
    expect(formulaToText(simpleFormula(true))).toBe('A & B / B');
    expect(formulaToText(simpleFormula(false))).toBe('A / B');
  });

  it('recognises its own formulas and nothing else', () => {
    expect(readSimple(simpleFormula(true))).toEqual({ intersect: true });
    expect(readSimple(simpleFormula(false))).toEqual({ intersect: false });
    expect(readSimple(textToFormula('B & A / B'))).toBeNull();
    expect(readSimple(textToFormula('A / B * 100'))).toBeNull();
  });

  it('cannot exceed 100% with the intersection on', () => {
    const tokens: Token[] = simpleFormula(true);
    const r = parseFormula(tokens);
    if (!r.ok) throw new Error();
    // A has more contacts than B, but A∩B can never exceed B.
    const v = evaluate(r.node, (ls) => (ls.length === 2 ? 30 : ls[0] === 'A' ? 90 : 30));
    expect(v).toBe(1);
  });
});

describe('formatting', () => {
  it('percentages', () => {
    expect(formatValue(0.25, 'percent')).toBe('25%');
    expect(formatValue(0.0625, 'percent')).toBe('6.3%');
    expect(formatValue(0.125, 'percent')).toBe('12.5%');
    expect(formatValue(1 / 3, 'percent')).toBe('33.3%');
    expect(formatValue(1, 'percent')).toBe('100%');
    expect(formatValue(0, 'percent')).toBe('0%');
  });

  it('plain numbers', () => {
    expect(formatValue(12, 'number')).toBe('12');
    expect(formatValue(1 / 3, 'number')).toBe('0.33');
    expect(formatValue(12345, 'number')).toBe('12,345');
  });

  it('ratios', () => {
    expect(formatValue(0.25, 'ratio')).toBe('1 in 4');
    expect(formatValue(0.4, 'ratio')).toBe('1 in 2.5');
    expect(formatValue(1 / 48, 'ratio')).toBe('1 in 48');
    expect(formatValue(3, 'ratio')).toBe('3 to 1');
    expect(formatValue(0, 'ratio')).toBe('0');
  });
});
