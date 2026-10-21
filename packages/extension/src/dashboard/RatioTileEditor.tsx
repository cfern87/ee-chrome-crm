// Editing a ratio tile.
//
// Two modes over ONE saved shape (a formula plus which search each letter is):
//
//   * Simple — the default, and all most people need: a sentence, "[Search A]
//     out of [Search B]", with a checkbox for counting only A's contacts who
//     are also in B. That is the formula A∩B ÷ B (or A ÷ B), built for you.
//   * Advanced — the formula itself, built from chips: each chosen search is a
//     lettered chip, plus operator buttons and plain numbers. Nothing is typed
//     except numbers, so there are no names to misspell. Switching from simple
//     keeps the formula, so advanced starts from what you already had.
//
// A live preview runs the real counts the whole time, and a broken formula is
// underlined where it breaks — not reported after Save.

import React, { useMemo, useState } from 'react';
import type { SavedSearch } from '../search';
import { sortSavedSearches } from '../search';
import { intersectionSize, nextLetter, type RatioTile } from '../ratioTiles';
import {
  OP_LABEL, TILE_FORMATS, checkFormula, evaluate, formatValue, formulaToText, fractionOf,
  readSimple, simpleFormula, textToFormula, tokenLabel,
  type FormulaNode, type LetterStatus, type Op, type TileFormat, type Token,
} from '../tileFormula';
import { Button, Input, SectionTitle, Select, Text, color, radius, space } from '../ui/primitives';

export interface RatioTileEditorProps {
  tile: RatioTile;
  isNew: boolean;
  savedSearches: Record<string, SavedSearch>;
  /** Contact ids a saved search matches (the Dashboard's shared matcher). */
  idsFor: (preset: SavedSearch) => Set<string>;
  onSave: (tile: RatioTile) => Promise<void> | void;
  onCancel: () => void;
}

const OPERATORS: { op: Op; title: string }[] = [
  { op: '+', title: 'Add' },
  { op: '-', title: 'Subtract' },
  { op: '*', title: 'Multiply' },
  { op: '/', title: 'Divide' },
  { op: '&', title: 'In both — contacts who match both searches' },
];

const plain = (n: number | null) => (n === null ? '—' : formatValue(n, 'number'));

export function RatioTileEditor({ tile, isNew, savedSearches, idsFor, onSave, onCancel }: RatioTileEditorProps) {
  const initialTokens = useMemo(() => textToFormula(tile.formula), [tile.formula]);
  const initialSimple = readSimple(initialTokens);

  const [name, setName] = useState(tile.name);
  const [terms, setTerms] = useState<Record<string, string>>(tile.terms);
  const [tokens, setTokens] = useState<Token[]>(initialTokens);
  const [format, setFormat] = useState<TileFormat>(tile.format);
  // Opens in advanced only when simple mode couldn't show the formula as is.
  const [advanced, setAdvanced] = useState(
    !initialSimple || Object.keys(tile.terms).some((l) => l !== 'A' && l !== 'B'),
  );
  const [numberDraft, setNumberDraft] = useState('');
  /** "Back to simple" would replace a custom formula — waiting on a second click. */
  const [confirmSimple, setConfirmSimple] = useState(false);
  const [saving, setSaving] = useState(false);

  const searches = useMemo(() => sortSavedSearches(savedSearches), [savedSearches]);
  const simple = readSimple(tokens);
  const intersect = simple ? simple.intersect : true;

  const status = (letter: string): LetterStatus =>
    !terms[letter] ? 'unknown' : !savedSearches[terms[letter]] ? 'deleted' : 'ok';
  const check = checkFormula(tokens, status);

  const count = (letters: string[]) =>
    intersectionSize(letters.map((l) => idsFor(savedSearches[terms[l]])));
  const value = check.ok ? evaluate(check.node, count) : null;
  const fraction = check.ok ? fractionOf(check.node) : null;

  const nameOf = (letter: string) => savedSearches[terms[letter]]?.name;

  // --- edits ---

  const setTerm = (letter: string, presetId: string) => {
    setTerms((t) => {
      const next = { ...t };
      if (presetId) next[letter] = presetId;
      else delete next[letter];
      return next;
    });
  };

  const addSearch = (presetId: string) => {
    const letter = nextLetter(terms);
    if (!letter || !presetId) return;
    setTerm(letter, presetId);
    // A first search with an empty formula is almost certainly going to be
    // used — put its chip in so the preview has something to show.
    if (tokens.length === 0) setTokens([{ kind: 'ref', letter }]);
  };

  const push = (t: Token) => { setTokens((ts) => [...ts, t]); setConfirmSimple(false); };
  const removeAt = (i: number) => { setTokens((ts) => ts.filter((_, j) => j !== i)); setConfirmSimple(false); };

  const addNumber = () => {
    const v = Number(numberDraft);
    if (numberDraft === '' || !Number.isFinite(v)) return;
    push({ kind: 'num', value: v });
    setNumberDraft('');
  };

  const goSimple = () => {
    if (!simple && !confirmSimple) { setConfirmSimple(true); return; }
    if (!simple) setTokens(simpleFormula(true));
    setConfirmSimple(false);
    setAdvanced(false);
  };

  const trimmedName = name.trim();
  const ready = check.ok && trimmedName.length > 0;

  const save = async () => {
    if (!ready || saving) return;
    // Simple mode only ever uses A and B; anything else assigned earlier in
    // advanced mode is dropped rather than carried along invisibly.
    const keptTerms = advanced
      ? terms
      : Object.fromEntries(Object.entries(terms).filter(([l]) => l === 'A' || l === 'B'));
    setSaving(true);
    try {
      await onSave({ ...tile, name: trimmedName, formula: formulaToText(tokens), terms: keptTerms, format });
    } finally {
      setSaving(false);
    }
  };

  // --- pieces ---

  const picker = (letter: string, label: string) => (
    <Select
      aria-label={label}
      value={terms[letter] && savedSearches[terms[letter]] ? terms[letter] : ''}
      onChange={(e) => setTerm(letter, e.target.value)}
      style={{ minWidth: 180, maxWidth: 260 }}
    >
      <option value="">{terms[letter] ? '(deleted search — pick another)' : 'Pick a saved search…'}</option>
      {searches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </Select>
  );

  const letterBadge = (letter: string) => (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, borderRadius: 11, fontSize: 12, fontWeight: 700,
        background: color.accent.base, color: color.surface.raised, flexShrink: 0,
      }}
    >
      {letter}
    </span>
  );

  const errFrom = check.ok ? -1 : check.error.from;
  const errTo = check.ok ? -1 : check.error.to;
  const errAtEnd = !check.ok && errFrom >= tokens.length;
  const underline: React.CSSProperties = {
    textDecoration: `underline wavy ${color.danger.base}`,
    textDecorationSkipInk: 'none',
    textUnderlineOffset: 4,
  };

  const preview = (() => {
    if (!advanced && (!terms.A || !terms.B || status('A') !== 'ok' || status('B') !== 'ok')) {
      return <Text tone="muted">Pick both searches to see the rate.</Text>;
    }
    if (!check.ok) return <Text tone="muted">Fix the formula to see the result.</Text>;
    const result = formatValue(value, format);
    if (fraction) {
      const num = evaluate(fraction.num, count);
      const den = evaluate(fraction.den, count);
      return (
        <Text size="body">
          <strong>{plain(num)}</strong> of <strong>{plain(den)}</strong> = <strong style={{ color: color.accent.base }}>{result}</strong>
          {den === 0 && <Text tone="muted" size="small"> (nothing to divide by yet)</Text>}
        </Text>
      );
    }
    return <Text size="body">= <strong style={{ color: color.accent.base }}>{result}</strong></Text>;
  })();

  const describeSide = (node: FormulaNode | undefined) =>
    node && node.k === 'set' ? node.letters.map((l) => nameOf(l) || l).join(' ∩ ') : null;

  return (
    <div style={{ maxWidth: 760 }}>
      <SectionTitle>{isNew ? 'New ratio tile' : `Edit “${tile.name}”`}</SectionTitle>

      <div style={{ marginBottom: 14, maxWidth: 360 }}>
        <Input
          value={name}
          autoFocus={isNew}
          aria-label="Tile name"
          placeholder="Tile name (e.g. Reply rate, Booked from replies)…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
        />
      </div>

      {!advanced ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.md, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', fontSize: 14 }}>
            {picker('A', 'Search A — the part')}
            <Text weight="medium">out of</Text>
            {picker('B', 'Search B — the whole')}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: space.sm, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={intersect}
              onChange={(e) => setTokens(simpleFormula(e.target.checked))}
            />
            <span>
              Only count {nameOf('A') ? <strong>{nameOf('A')}</strong> : 'A'}’s contacts who are also in{' '}
              {nameOf('B') ? <strong>{nameOf('B')}</strong> : 'B'}
              <Text tone="muted" size="small"> — keeps the rate at or under 100%</Text>
            </span>
          </label>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.md, marginBottom: 16 }}>
          {/* The searches, one letter each. */}
          <div>
            <Text size="small" weight="medium" tone="secondary">Searches</Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs, marginTop: 6 }}>
              {Object.keys(terms).sort().map((letter) => (
                <div key={letter} style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
                  {letterBadge(letter)}
                  {picker(letter, `Search ${letter}`)}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setTerm(letter, '')}
                    aria-label={`Remove search ${letter}`}
                    title={tokens.some((t) => t.kind === 'ref' && t.letter === letter)
                      ? `Remove ${letter}. The formula still uses it, so it will be underlined until you take it out.`
                      : `Remove ${letter}`}
                  >
                    ×
                  </Button>
                </div>
              ))}
              {nextLetter(terms) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
                  {letterBadge(nextLetter(terms)!)}
                  <Select aria-label="Add a saved search" value="" onChange={(e) => addSearch(e.target.value)} style={{ minWidth: 180, maxWidth: 260 }}>
                    <option value="">+ Add a saved search…</option>
                    {searches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </div>
              )}
            </div>
          </div>

          {/* The formula, as chips. Click a chip to take it out. */}
          <div>
            <Text size="small" weight="medium" tone="secondary">Formula</Text>
            <div
              data-formula
              aria-label="Formula"
              style={{
                display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4,
                minHeight: 40, marginTop: 6, padding: '6px 8px',
                border: `1px solid ${check.ok ? color.border.subtle : color.danger.base}`,
                borderRadius: radius.md, background: color.surface.raised,
              }}
            >
              {tokens.length === 0 && !errAtEnd && <Text tone="muted" size="small">Click a search or a number below to start.</Text>}
              {tokens.map((t, i) => {
                const bad = i >= errFrom && i < errTo;
                const isRef = t.kind === 'ref';
                return (
                  <button
                    key={i}
                    type="button"
                    data-token={i}
                    data-invalid={bad || undefined}
                    onClick={() => removeAt(i)}
                    title={isRef ? `${t.letter}: ${nameOf(t.letter) || 'no search'} — click to remove` : 'Click to remove'}
                    aria-label={`${tokenLabel(t)}${isRef && nameOf(t.letter) ? ` (${nameOf(t.letter)})` : ''}, remove`}
                    style={{
                      border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, lineHeight: 1.2,
                      padding: isRef ? '3px 8px' : '3px 4px', borderRadius: isRef ? 11 : radius.sm,
                      background: isRef ? color.accent.base : 'transparent',
                      color: isRef ? color.surface.raised : color.text.primary,
                      ...(bad ? underline : null),
                      ...(bad && isRef ? { outline: `2px solid ${color.danger.base}`, outlineOffset: 1 } : null),
                    }}
                  >
                    {tokenLabel(t)}
                  </button>
                );
              })}
              {errAtEnd && (
                <span
                  data-invalid
                  aria-hidden="true"
                  style={{ ...underline, color: color.danger.base, padding: '0 6px', fontSize: 14 }}
                >
                  {' ? '}
                </span>
              )}
            </div>
            {!check.ok && (
              <Text as="div" size="small" tone="danger" role="status" style={{ marginTop: 4 }}>
                {check.error.message}
              </Text>
            )}
          </div>

          {/* The palette. Only plain numbers can be typed. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.xs }}>
            {Object.keys(terms).sort().map((letter) => (
              <Button key={letter} size="sm" onClick={() => push({ kind: 'ref', letter })} title={nameOf(letter) || `Search ${letter}`}>
                {letter}
              </Button>
            ))}
            <span style={{ width: 8 }} />
            {OPERATORS.map(({ op, title }) => (
              <Button key={op} size="sm" onClick={() => push({ kind: 'op', op })} title={title} aria-label={title}>
                {OP_LABEL[op]}
              </Button>
            ))}
            <Button size="sm" onClick={() => push({ kind: 'lparen' })} aria-label="Open parenthesis">(</Button>
            <Button size="sm" onClick={() => push({ kind: 'rparen' })} aria-label="Close parenthesis">)</Button>
            <span style={{ width: 8 }} />
            <Input
              value={numberDraft}
              inputMode="decimal"
              aria-label="Number to add"
              placeholder="Number"
              onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setNumberDraft(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNumber(); } }}
              style={{ width: 80 }}
            />
            <Button size="sm" onClick={addNumber} disabled={numberDraft === '' || numberDraft === '.'}>Add number</Button>
            <span style={{ width: 8 }} />
            <Button size="sm" variant="ghost" onClick={() => removeAt(tokens.length - 1)} disabled={tokens.length === 0} aria-label="Remove last">⌫</Button>
            <Button size="sm" variant="ghost" onClick={() => setTokens([])} disabled={tokens.length === 0}>Clear</Button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', marginBottom: 16 }}>
        <Text size="small" weight="medium" tone="secondary">Show as</Text>
        <div role="radiogroup" aria-label="Show the result as" style={{ display: 'flex', gap: space.xs }}>
          {TILE_FORMATS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              role="radio"
              aria-checked={format === f.value}
              variant={format === f.value ? 'primary' : 'secondary'}
              onClick={() => setFormat(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <span style={{ marginLeft: 'auto' }}>
          {advanced ? (
            <Button size="sm" variant={confirmSimple ? 'danger' : 'ghost'} onClick={goSimple}>
              {confirmSimple ? 'Replace formula with “A out of B”?' : 'Back to simple'}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setAdvanced(true)} title="Build your own formula from these searches">
              Advanced
            </Button>
          )}
        </span>
      </div>

      <div
        aria-live="polite"
        data-preview
        style={{ padding: '12px 14px', borderRadius: radius.md, background: color.surface.sunken, marginBottom: 14 }}
      >
        <Text size="small" weight="medium" tone="secondary" as="div" style={{ marginBottom: 4 }}>Preview</Text>
        {preview}
        {check.ok && fraction && (describeSide(fraction.num) || describeSide(fraction.den)) && (
          <Text as="div" size="small" tone="muted" style={{ marginTop: 4 }}>
            {describeSide(fraction.num) ?? 'top'} ÷ {describeSide(fraction.den) ?? 'bottom'}
          </Text>
        )}
      </div>

      <div style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
        <Button variant="primary" onClick={() => void save()} disabled={!ready || saving}>
          {isNew ? 'Save tile' : 'Save changes'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        {!ready && (
          <Text size="small" tone="muted">
            {!trimmedName ? 'Give the tile a name to save it.'
              : advanced ? 'Fix the formula to save it.'
              : 'Pick both searches to save it.'}
          </Text>
        )}
      </div>
    </div>
  );
}
