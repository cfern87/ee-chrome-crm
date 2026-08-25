// Spintax: {one|the other} in a campaign template, picked per recipient.
//
// WHY: fifty identical messages is what an automated sender looks like, both to
// the people receiving them and to Facebook. Varying the wording is the cheapest
// defence there is, and doing it by hand means running fifty campaigns.
//
// SYNTAX
//   {a|b}            → "a" or "b"
//   {a|b|c}          → any of the three
//   {a{x|y}|b}       → "ax", "ay" or "b" — groups nest, and a nested group is
//                      only rolled when the branch containing it is chosen
//   {a|}             → "a" or nothing. A deliberately empty alternative is
//                      legal: "{Hey|Hi} there{, friend|}" is exactly the kind
//                      of thing this is for.
//
// {{name}} AND {{firstName}} ARE NOT GROUPS. They predate this and share the
// brace character, so the parser recognizes a doubled brace as a template token
// and copies it through untouched — otherwise "{{name}}" would parse as a group
// containing the group "{name}" and render as "name".
//
// A MALFORMED TEMPLATE IS NEVER SILENTLY REWRITTEN. An unclosed "{" is emitted
// as the literal text the user typed, matching how renderTemplate leaves
// unknown {{tokens}} intact — a visible mistake beats a message that quietly
// lost half its text. The composer calls variationIssue() to say so before the
// campaign starts, which is where a typo should be caught.

/** A parsed template: literal text and choices, in order. */
type Node = string | Node[][]; // string = literal; Node[][] = one group's alternatives

export interface VariationParse {
  nodes: Node[];
  /** Set when the template is malformed; the parse is still usable. */
  error?: string;
}

const OPEN = '{';
const CLOSE = '}';
const SEP = '|';

/**
 * Parse `template` into literals and choice groups.
 *
 * Written as an explicit scanner rather than a regex because the syntax nests,
 * and because "{{" has to be able to win over "{" — neither of which a regex
 * expresses without becoming unreadable.
 */
export function parseVariations(template: string): VariationParse {
  const src = template || '';
  let i = 0;
  let error: string | undefined;

  // One alternative's worth of nodes, plus the sibling alternatives collected
  // so far. `depth` is only used to tell a top-level '}' (a stray character the
  // user typed) from a closing brace that belongs to us.
  function parseAlternatives(depth: number): { alts: Node[][]; closed: boolean } {
    const alts: Node[][] = [];
    let current: Node[] = [];
    let literal = '';

    const flush = () => { if (literal) { current.push(literal); literal = ''; } };
    const endAlt = () => { flush(); alts.push(current); current = []; };

    while (i < src.length) {
      const ch = src[i];

      // A template token: {{name}}, {{firstName}}, or anything else doubled.
      // Copied through verbatim, braces included, for renderTemplate to deal
      // with later.
      //
      // THREE braces is a group opening on a token — "{{{firstName}}|Hi}" is a
      // choice whose first branch starts with {{firstName}}. Without the third
      // check this reads as a token called "{firstName" and the group is lost,
      // which is a real template shape: putting a personalized branch first is
      // the obvious thing to write.
      if (ch === OPEN && src[i + 1] === OPEN && src[i + 2] !== OPEN) {
        const end = src.indexOf('}}', i + 2);
        if (end === -1) {
          // No closing "}}" anywhere — treat the pair as literal text rather
          // than swallowing the rest of the message into a token.
          literal += src.slice(i);
          i = src.length;
          continue;
        }
        literal += src.slice(i, end + 2);
        i = end + 2;
        continue;
      }

      if (ch === OPEN) {
        flush();
        i++; // past '{'
        const inner = parseAlternatives(depth + 1);
        if (!inner.closed) {
          // Unclosed group. Put the text back exactly as typed — including the
          // '{' and any '|' inside it, which are now just characters.
          if (!error) error = 'Unclosed { in the message — every { needs a matching }.';
          current.push(OPEN + inner.alts.map((a) => renderNodesLiteral(a)).join(SEP));
          continue;
        }
        current.push(inner.alts);
        continue;
      }

      if (ch === SEP && depth > 0) { endAlt(); i++; continue; }

      if (ch === CLOSE) {
        if (depth === 0) {
          // A '}' with nothing open. The user's character, not our syntax.
          if (!error) error = 'Unmatched } in the message.';
          literal += ch;
          i++;
          continue;
        }
        endAlt();
        i++; // past '}'
        return { alts, closed: true };
      }

      literal += ch;
      i++;
    }

    endAlt();
    return { alts, closed: depth === 0 };
  }

  const { alts } = parseAlternatives(0);
  // At depth 0 there is exactly one "alternative": the whole template.
  return { nodes: alts[0] || [], error };
}

/** Re-emit nodes as the source text they came from. Used to restore a broken group. */
function renderNodesLiteral(nodes: Node[]): string {
  return nodes.map((n) => (typeof n === 'string' ? n : OPEN + n.map(renderNodesLiteral).join(SEP) + CLOSE)).join('');
}

/**
 * Roll one message out of a parsed template.
 *
 * `rng` returns a float in [0,1) — injectable so tests are deterministic and so
 * a preview can be re-rolled without touching Math.random's sequence.
 */
function pickNodes(nodes: Node[], rng: () => number): string {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') { out += n; continue; }
    if (n.length === 0) continue;
    const chosen = n[Math.min(n.length - 1, Math.floor(rng() * n.length))];
    out += pickNodes(chosen, rng);
  }
  return out;
}

/**
 * Pick one variation of `template`. Templates with no groups come back
 * unchanged, so this is safe to run over every message whether or not anyone
 * is using the syntax.
 */
export function pickVariation(template: string, rng: () => number = Math.random): string {
  const parsed = parseVariations(template);
  return pickNodes(parsed.nodes, rng);
}

/**
 * How many distinct messages the template can produce — the product of every
 * group's alternatives, with nesting counted properly (a group inside one
 * branch multiplies only that branch).
 *
 * Capped: twelve nested groups of three is over half a million, and the exact
 * figure stops being information long before that. The cap is reported as-is
 * and the UI says "500,000+".
 */
export const VARIATION_COUNT_CAP = 500_000;

function countNodes(nodes: Node[]): number {
  let total = 1;
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    let branches = 0;
    for (const alt of n) branches += countNodes(alt);
    total *= Math.max(1, branches);
    if (total >= VARIATION_COUNT_CAP) return VARIATION_COUNT_CAP;
  }
  return total;
}

export function countVariations(template: string): number {
  return countNodes(parseVariations(template).nodes);
}

/** True when the template actually uses the syntax — i.e. has something to roll. */
export function hasVariations(template: string): boolean {
  return parseVariations(template).nodes.some((n) => typeof n !== 'string');
}

/**
 * What's wrong with this template, or null. Shown in the composer BEFORE a
 * campaign starts: a mistake found here costs a re-type, and the same mistake
 * found afterwards has already gone out to everyone.
 */
export function variationIssue(template: string): string | null {
  const parsed = parseVariations(template);
  if (parsed.error) return parsed.error;
  const emptyGroup = (nodes: Node[]): boolean => nodes.some((n) => {
    if (typeof n === 'string') return false;
    // A group with one alternative isn't a choice — almost always a missing
    // '|', and silently rendering it as plain text would hide the typo.
    if (n.length < 2) return true;
    return n.some(emptyGroup);
  });
  if (emptyGroup(parsed.nodes)) return 'A { } group has no | in it — write {this|that}, or remove the braces.';
  return null;
}

/**
 * Every message the template can produce, for a preview list. Bounded by
 * `limit`, and enumerated in a stable order so the preview doesn't reshuffle
 * on every keystroke.
 */
export function enumerateVariations(template: string, limit = 20): string[] {
  const nodes = parseVariations(template).nodes;
  let out: string[] = [''];
  for (const n of nodes) {
    if (typeof n === 'string') { out = out.map((s) => s + n); continue; }
    const expansions = n.flatMap((alt) => enumerateNodes(alt, limit));
    const next: string[] = [];
    for (const prefix of out) {
      for (const e of expansions.length ? expansions : ['']) {
        if (next.length >= limit) break;
        next.push(prefix + e);
      }
      if (next.length >= limit) break;
    }
    out = next;
  }
  return out.slice(0, limit);
}

function enumerateNodes(nodes: Node[], limit: number): string[] {
  let out: string[] = [''];
  for (const n of nodes) {
    if (typeof n === 'string') { out = out.map((s) => s + n); continue; }
    const expansions = n.flatMap((alt) => enumerateNodes(alt, limit));
    const next: string[] = [];
    for (const prefix of out) {
      for (const e of expansions.length ? expansions : ['']) {
        if (next.length >= limit) break;
        next.push(prefix + e);
      }
      if (next.length >= limit) break;
    }
    out = next;
  }
  return out;
}
