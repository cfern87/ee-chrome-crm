// Tests for {one|the other} message variations.
//
// The two things that would actually hurt: a template that quietly loses text
// (a message going out with half a sentence missing is unrecoverable — it has
// already been sent), and {{name}} being eaten by the group parser, which would
// send everyone a message addressed to "name".

import { describe, it, expect } from 'vitest';
import {
  pickVariation, countVariations, hasVariations, variationIssue, enumerateVariations,
} from './variations';
import { renderTemplate } from './campaigns';

/** Deterministic rng: replays the given fractions, then always picks the first. */
function rng(...values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0);
}

describe('pickVariation', () => {
  it('picks one alternative', () => {
    expect(pickVariation('{Hey|Hi} there', rng(0))).toBe('Hey there');
    expect(pickVariation('{Hey|Hi} there', rng(0.9))).toBe('Hi there');
  });

  it('handles three or more alternatives', () => {
    expect(pickVariation('{a|b|c}', rng(0.5))).toBe('b');
    expect(pickVariation('{a|b|c}', rng(0.99))).toBe('c');
  });

  it('nests, rolling the inner group only inside the chosen branch', () => {
    // {OPTION 1{a|b}|OPTION 2} — the example from the feature request.
    const t = '{OPTION 1{a|b}|OPTION 2}';
    expect(pickVariation(t, rng(0, 0))).toBe('OPTION 1a');
    expect(pickVariation(t, rng(0, 0.9))).toBe('OPTION 1b');
    expect(pickVariation(t, rng(0.9))).toBe('OPTION 2');
  });

  it('allows a deliberately empty alternative', () => {
    expect(pickVariation('Hi there{, friend|}', rng(0.9))).toBe('Hi there');
    expect(pickVariation('Hi there{, friend|}', rng(0))).toBe('Hi there, friend');
  });

  it('leaves a template with no groups completely alone', () => {
    expect(pickVariation('Plain message, no braces.')).toBe('Plain message, no braces.');
  });

  it('handles several groups in one message', () => {
    expect(pickVariation('{Hey|Hi} {there|friend}', rng(0.9, 0.9))).toBe('Hi friend');
  });

  // The collision that matters: {{name}} is not a group.
  it('leaves {{name}} and {{firstName}} untouched', () => {
    expect(pickVariation('Hi {{firstName}}, how are you?')).toBe('Hi {{firstName}}, how are you?');
    expect(pickVariation('{Hey|Hi} {{name}}', rng(0))).toBe('Hey {{name}}');
  });

  // The shape people will actually type: a token INSIDE a group.
  it('handles a {{token}} inside a group', () => {
    const t = '{Hey {{firstName}}|Hi there}';
    expect(pickVariation(t, rng(0))).toBe('Hey {{firstName}}');
    expect(pickVariation(t, rng(0.9))).toBe('Hi there');
    expect(renderTemplate(pickVariation(t, rng(0)), 'Dana Ellis')).toBe('Hey Dana');
  });

  it('handles a {{token}} inside a nested group', () => {
    const t = '{{{firstName}}{, mate|}|Hello}';
    expect(renderTemplate(pickVariation(t, rng(0, 0)), 'Dana Ellis')).toBe('Dana, mate');
  });

  it('still personalizes a varied template', () => {
    const rolled = pickVariation('{Hey|Hi} {{firstName}}, got a minute?', rng(0.9));
    expect(renderTemplate(rolled, 'Dana Ellis')).toBe('Hi Dana, got a minute?');
  });

  // Malformed input must come out as the text the user typed. Losing the tail
  // of a message silently is the one outcome there is no recovering from.
  it('emits an unclosed group as literal text', () => {
    expect(pickVariation('Hi {there, how are you')).toBe('Hi {there, how are you');
  });

  it('keeps the pipes inside an unclosed group', () => {
    expect(pickVariation('Hi {a|b')).toBe('Hi {a|b');
  });

  it('emits a stray closing brace literally', () => {
    expect(pickVariation('Hi there}')).toBe('Hi there}');
  });

  it('never returns an out-of-range branch on rng() === 1', () => {
    expect(pickVariation('{a|b}', () => 1)).toBe('b');
  });
});

describe('countVariations', () => {
  it('multiplies independent groups', () => {
    expect(countVariations('{a|b} {c|d|e}')).toBe(6);
  });

  it('counts a nested group only within its own branch', () => {
    // "OPTION 1a", "OPTION 1b", "OPTION 2" — three, not four.
    expect(countVariations('{OPTION 1{a|b}|OPTION 2}')).toBe(3);
  });

  it('counts a plain template as one message', () => {
    expect(countVariations('No variation here')).toBe(1);
  });

  it('counts an empty alternative as a real option', () => {
    expect(countVariations('Hi{, friend|}')).toBe(2);
  });
});

describe('hasVariations', () => {
  it('is false for a plain template', () => {
    expect(hasVariations('Hi {{firstName}}')).toBe(false);
  });

  it('is true once a group appears', () => {
    expect(hasVariations('{Hi|Hey} {{firstName}}')).toBe(true);
  });
});

describe('variationIssue', () => {
  it('passes a well-formed template', () => {
    expect(variationIssue('{Hey|Hi} {{firstName}}{!|.}')).toBeNull();
  });

  it('passes a template with no braces at all', () => {
    expect(variationIssue('Just a message')).toBeNull();
  });

  it('reports an unclosed group', () => {
    expect(variationIssue('Hi {there')).toMatch(/Unclosed/);
  });

  it('reports a stray closing brace', () => {
    expect(variationIssue('Hi there}')).toMatch(/Unmatched/);
  });

  // Almost always a forgotten '|'. Rendering it as plain text would hide the
  // typo until the campaign had gone out.
  it('reports a group with no alternatives', () => {
    expect(variationIssue('Hi {there}')).toMatch(/no \| in it/);
  });

  it('does not mistake a template token for an empty group', () => {
    expect(variationIssue('Hi {{firstName}}')).toBeNull();
  });
});

describe('enumerateVariations', () => {
  it('lists every message a small template can produce', () => {
    expect(enumerateVariations('{Hey|Hi} there')).toEqual(['Hey there', 'Hi there']);
  });

  it('expands nesting', () => {
    expect(enumerateVariations('{OPTION 1{a|b}|OPTION 2}')).toEqual(['OPTION 1a', 'OPTION 1b', 'OPTION 2']);
  });

  it('stops at the limit rather than expanding a huge template', () => {
    const big = '{a|b}{c|d}{e|f}{g|h}{i|j}';
    expect(enumerateVariations(big, 5)).toHaveLength(5);
  });
});
