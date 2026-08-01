// Advanced contact search: a nestable boolean query over every field the CRM
// tracks, plus the named presets the dashboard saves.
//
// A query is a tree. Groups combine their children with AND or OR and can be
// negated (NOT); conditions are leaves of the form <field> <operator> <value>.
// Because groups nest arbitrarily, "(A or B) and not (C and D)" is expressible
// without a query language — the dashboard renders the tree directly.
//
// Two rules keep the builder usable while it's being edited:
//   * An INCOMPLETE condition (no value chosen yet, an unparseable number, a
//     bad regex) is IGNORED rather than treated as false — otherwise the result
//     list would collapse to zero the moment you add a row. `conditionIssue`
//     reports why, so the UI can flag the row instead of silently dropping it.
//   * An EMPTY group matches everything, so a fresh query shows all contacts.

import type { Conversation, Tag, TagGroup, CustomFieldDef } from './storage';
import { lastTaggedAt, firstTaggedAt } from './storage';

// ---------------------------------------------------------------------------
// Query model
// ---------------------------------------------------------------------------

export type Combinator = 'and' | 'or';

export type DurationUnit = 'hours' | 'days' | 'weeks' | 'months' | 'years';

export interface Condition {
  type: 'condition';
  id: string;
  /** Field key — see FIELDS, or `custom:<fieldDefId>` for a user-defined field. */
  field: string;
  op: string;
  /** Primary scalar operand (text, number, or a YYYY-MM-DD date). */
  value?: string;
  /** Second operand, for the `between` operators. */
  value2?: string;
  /** Multi-operand: tag ids, tag group ids, or dropdown choices. */
  values?: string[];
  /** Unit for the relative-date operators (`inLast` / `notInLast` / `inNext`). */
  unit?: DurationUnit;
  /** For `tagDate`: which tags to look at. Empty = any tag. */
  tagIds?: string[];
}

export interface QueryGroup {
  type: 'group';
  id: string;
  combinator: Combinator;
  /** Invert the whole group — this is the NOT in "and not (...)". */
  negate?: boolean;
  children: QueryNode[];
}

export type QueryNode = QueryGroup | Condition;

/** A named, re-runnable search. Persisted as its own store shard (`q:<id>`). */
export interface SavedSearch {
  id: string;
  name: string;
  /** Optional note about what the preset is for. */
  description?: string;
  query: QueryGroup;
  /** View settings captured with the preset, so applying it restores the whole view. */
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  archiveScope?: ArchiveScope;
  /** Pinned presets get a one-click chip above the contact list. */
  pinned?: boolean;
  order: number;
  createdAt: number;
  updatedAt: number;
}

/** Which side of the archive line a view shows. */
export type ArchiveScope = 'active' | 'archived' | 'all';

export interface QueryContext {
  now: number;
  tags: Record<string, Tag>;
  tagGroups: Record<string, TagGroup>;
  fieldDefs: Record<string, CustomFieldDef>;
}

// ---------------------------------------------------------------------------
// Field registry
// ---------------------------------------------------------------------------

export type FieldKind =
  | 'text'
  | 'number'
  | 'date'
  | 'tags'
  | 'tagGroups'
  | 'tagDate'
  | 'boolean'
  | 'enum';

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  /** Heading the field is listed under in the field picker. */
  category: string;
  hint?: string;
  /** Choices for `enum` fields. */
  options?: string[];
}

/** Fields that exist regardless of how the user has configured their CRM. */
export const BUILTIN_FIELDS: FieldDef[] = [
  { key: 'anyText', label: 'Any text field', kind: 'text', category: 'Contact', hint: 'Name, last message, email, username and profile URL at once' },
  { key: 'name', label: 'Name', kind: 'text', category: 'Contact' },
  { key: 'lastMessage', label: 'Last message', kind: 'text', category: 'Contact' },
  { key: 'email', label: 'Email', kind: 'text', category: 'Contact' },
  { key: 'profileUrl', label: 'Facebook profile URL', kind: 'text', category: 'Contact' },
  { key: 'fbUsername', label: 'Facebook username', kind: 'text', category: 'Contact' },
  { key: 'fbUserId', label: 'Facebook user id', kind: 'text', category: 'Contact' },
  { key: 'chatUrl', label: 'Messenger chat URL', kind: 'text', category: 'Contact', hint: 'Use "is not empty" to find contacts you can actually message' },

  { key: 'tags', label: 'Tags', kind: 'tags', category: 'Tags' },
  { key: 'tagGroup', label: 'Tag group', kind: 'tagGroups', category: 'Tags', hint: 'Matches on any tag belonging to the chosen group' },
  { key: 'tagCount', label: 'Number of tags', kind: 'number', category: 'Tags' },
  { key: 'tagDate', label: 'Date a specific tag was added', kind: 'tagDate', category: 'Tags' },
  { key: 'lastTagAt', label: 'Last tagged', kind: 'date', category: 'Tags', hint: 'Most recent tag application. Only recorded for tags added since tag dates were introduced.' },
  { key: 'firstTagAt', label: 'First tagged', kind: 'date', category: 'Tags' },

  { key: 'updatedAt', label: 'Last activity', kind: 'date', category: 'Dates' },
  { key: 'createdAt', label: 'Date added', kind: 'date', category: 'Dates' },
  { key: 'lastContactedAt', label: 'Last contacted', kind: 'date', category: 'Dates' },
  { key: 'lastOpenedAt', label: 'Last opened', kind: 'date', category: 'Dates' },
  { key: 'lastMessageTime', label: 'Last message date', kind: 'date', category: 'Dates' },

  { key: 'archived', label: 'Archived', kind: 'boolean', category: 'Status' },
  { key: 'source', label: 'Source', kind: 'enum', category: 'Status', options: ['messenger', 'import'] },
  { key: 'nameManual', label: 'Name edited by hand', kind: 'boolean', category: 'Status' },
];

const CUSTOM_PREFIX = 'custom:';

const CUSTOM_KIND: Record<CustomFieldDef['type'], FieldKind> = {
  text: 'text',
  number: 'number',
  date: 'date',
  select: 'enum',
};

/** Every searchable field, including the user's custom field definitions. */
export function buildFields(fieldDefs: Record<string, CustomFieldDef>): FieldDef[] {
  const custom = Object.values(fieldDefs)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    .map<FieldDef>((d) => ({
      key: CUSTOM_PREFIX + d.id,
      label: d.name,
      kind: CUSTOM_KIND[d.type],
      category: 'Custom fields',
      options: d.type === 'select' ? d.options || [] : undefined,
    }));
  return [...BUILTIN_FIELDS, ...custom];
}

export function findField(fields: FieldDef[], key: string): FieldDef | undefined {
  return fields.find((f) => f.key === key);
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

/** How many operands an operator takes, which is what the UI renders. */
export type Arity = 'none' | 'one' | 'two' | 'multi' | 'duration';

export interface OperatorDef {
  op: string;
  label: string;
  arity: Arity;
}

const TEXT_OPS: OperatorDef[] = [
  { op: 'contains', label: 'contains', arity: 'one' },
  { op: 'notContains', label: "doesn't contain", arity: 'one' },
  { op: 'is', label: 'is exactly', arity: 'one' },
  { op: 'isNot', label: 'is not', arity: 'one' },
  { op: 'startsWith', label: 'starts with', arity: 'one' },
  { op: 'endsWith', label: 'ends with', arity: 'one' },
  { op: 'regex', label: 'matches regex', arity: 'one' },
  { op: 'isEmpty', label: 'is empty', arity: 'none' },
  { op: 'isNotEmpty', label: 'is not empty', arity: 'none' },
];

const NUMBER_OPS: OperatorDef[] = [
  { op: 'eq', label: '=', arity: 'one' },
  { op: 'neq', label: '≠', arity: 'one' },
  { op: 'gt', label: '>', arity: 'one' },
  { op: 'gte', label: '≥', arity: 'one' },
  { op: 'lt', label: '<', arity: 'one' },
  { op: 'lte', label: '≤', arity: 'one' },
  { op: 'between', label: 'is between', arity: 'two' },
  { op: 'isEmpty', label: 'is empty', arity: 'none' },
  { op: 'isNotEmpty', label: 'is not empty', arity: 'none' },
];

const DATE_OPS: OperatorDef[] = [
  { op: 'inLast', label: 'is in the last', arity: 'duration' },
  { op: 'notInLast', label: 'is not in the last', arity: 'duration' },
  { op: 'inNext', label: 'is in the next', arity: 'duration' },
  { op: 'on', label: 'is on', arity: 'one' },
  { op: 'before', label: 'is before', arity: 'one' },
  { op: 'after', label: 'is after', arity: 'one' },
  { op: 'between', label: 'is between', arity: 'two' },
  { op: 'isEmpty', label: 'is never / unknown', arity: 'none' },
  { op: 'isNotEmpty', label: 'is known', arity: 'none' },
];

const TAGS_OPS: OperatorDef[] = [
  { op: 'hasAny', label: 'has any of', arity: 'multi' },
  { op: 'hasAll', label: 'has all of', arity: 'multi' },
  { op: 'hasNone', label: 'has none of', arity: 'multi' },
  { op: 'isExactly', label: 'is exactly', arity: 'multi' },
  { op: 'isEmpty', label: 'has no tags', arity: 'none' },
  { op: 'isNotEmpty', label: 'has any tag', arity: 'none' },
];

const TAG_GROUP_OPS: OperatorDef[] = [
  { op: 'inAny', label: 'has a tag in any of', arity: 'multi' },
  { op: 'inAll', label: 'has a tag in each of', arity: 'multi' },
  { op: 'inNone', label: 'has no tag in', arity: 'multi' },
];

const BOOLEAN_OPS: OperatorDef[] = [
  { op: 'isTrue', label: 'is yes', arity: 'none' },
  { op: 'isFalse', label: 'is no', arity: 'none' },
];

const ENUM_OPS: OperatorDef[] = [
  { op: 'isAnyOf', label: 'is any of', arity: 'multi' },
  { op: 'isNoneOf', label: 'is none of', arity: 'multi' },
  { op: 'isEmpty', label: 'is empty', arity: 'none' },
  { op: 'isNotEmpty', label: 'is not empty', arity: 'none' },
];

const OPS_BY_KIND: Record<FieldKind, OperatorDef[]> = {
  text: TEXT_OPS,
  number: NUMBER_OPS,
  date: DATE_OPS,
  tags: TAGS_OPS,
  tagGroups: TAG_GROUP_OPS,
  tagDate: DATE_OPS,
  boolean: BOOLEAN_OPS,
  enum: ENUM_OPS,
};

export function operatorsFor(kind: FieldKind): OperatorDef[] {
  return OPS_BY_KIND[kind];
}

export function operatorDef(kind: FieldKind, op: string): OperatorDef | undefined {
  return OPS_BY_KIND[kind].find((o) => o.op === op);
}

/** The operator a freshly-picked field starts on. */
export function defaultOperator(kind: FieldKind): string {
  return OPS_BY_KIND[kind][0].op;
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

let idSeq = 0;
function nodeId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

export function newGroup(combinator: Combinator = 'and', children: QueryNode[] = []): QueryGroup {
  return { type: 'group', id: nodeId('g'), combinator, children };
}

export function newCondition(field = 'name', kind: FieldKind = 'text'): Condition {
  const cond: Condition = { type: 'condition', id: nodeId('c'), field, op: defaultOperator(kind) };
  if (kind === 'date' || kind === 'tagDate') { cond.value = '30'; cond.unit = 'days'; }
  return cond;
}

export function emptyQuery(): QueryGroup {
  return newGroup('and', []);
}

/** True when the query would match every contact (nothing to apply). */
export function isQueryEmpty(q: QueryGroup | null | undefined): boolean {
  if (!q) return true;
  return countConditions(q) === 0;
}

export function countConditions(node: QueryNode): number {
  if (node.type === 'condition') return 1;
  return node.children.reduce((n, c) => n + countConditions(c), 0);
}

/**
 * Defensive parse of a query loaded from storage (a preset written by a newer
 * version, or hand-edited JSON from a restored backup). Anything unrecognized
 * is dropped rather than allowed to throw inside the evaluator.
 */
export function normalizeQuery(raw: unknown): QueryGroup {
  const node = normalizeNode(raw);
  if (node && node.type === 'group') return node;
  if (node) return newGroup('and', [node]);
  return emptyQuery();
}

function normalizeNode(raw: unknown): QueryNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.type === 'group' || Array.isArray(o.children)) {
    const children = (Array.isArray(o.children) ? o.children : [])
      .map(normalizeNode)
      .filter((n): n is QueryNode => n !== null);
    return {
      type: 'group',
      id: typeof o.id === 'string' ? o.id : nodeId('g'),
      combinator: o.combinator === 'or' ? 'or' : 'and',
      ...(o.negate === true ? { negate: true } : {}),
      children,
    };
  }
  if (typeof o.field !== 'string' || typeof o.op !== 'string') return null;
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  return {
    type: 'condition',
    id: typeof o.id === 'string' ? o.id : nodeId('c'),
    field: o.field,
    op: o.op,
    ...(typeof o.value === 'string' ? { value: o.value } : {}),
    ...(typeof o.value2 === 'string' ? { value2: o.value2 } : {}),
    ...(strArray(o.values) ? { values: strArray(o.values) } : {}),
    ...(typeof o.unit === 'string' ? { unit: o.unit as DurationUnit } : {}),
    ...(strArray(o.tagIds) ? { tagIds: strArray(o.tagIds) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Why a condition can't be applied yet, or null when it's ready. The evaluator
 * skips conditions with an issue; the builder shows the message on the row.
 */
export function conditionIssue(cond: Condition, fields: FieldDef[]): string | null {
  const field = findField(fields, cond.field);
  if (!field) return 'This field no longer exists.';
  const def = operatorDef(field.kind, cond.op);
  if (!def) return 'Pick a condition.';

  switch (def.arity) {
    case 'none':
      return null;
    case 'multi':
      return cond.values && cond.values.length > 0 ? null : 'Choose at least one option.';
    case 'duration': {
      const n = Number(cond.value);
      if (!cond.value || !Number.isFinite(n) || n <= 0) return 'Enter a number of days.';
      return null;
    }
    case 'two': {
      if (!cond.value || !cond.value2) return 'Enter both ends of the range.';
      if (field.kind === 'number' && (!Number.isFinite(Number(cond.value)) || !Number.isFinite(Number(cond.value2)))) {
        return 'Both ends must be numbers.';
      }
      return null;
    }
    case 'one':
    default: {
      if (cond.value === undefined || cond.value === '') return 'Enter a value.';
      if (field.kind === 'number' && !Number.isFinite(Number(cond.value))) return 'Enter a number.';
      if (cond.op === 'regex') {
        try { new RegExp(cond.value, 'i'); } catch { return 'That regular expression is invalid.'; }
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Value access
// ---------------------------------------------------------------------------

function textOf(conv: Conversation, key: string): string {
  switch (key) {
    case 'name': return conv.participantName || '';
    case 'lastMessage': return conv.lastMessage || '';
    case 'email': return conv.email || '';
    case 'profileUrl': return conv.profileUrl || '';
    case 'fbUsername': return conv.fbUsername || '';
    case 'fbUserId': return conv.fbUserId || '';
    case 'chatUrl': return conv.chatUrl || '';
    case 'anyText':
      return [conv.participantName, conv.lastMessage, conv.email, conv.fbUsername, conv.profileUrl]
        .filter(Boolean).join('   ');
    default: return '';
  }
}

function dateOf(conv: Conversation, key: string): number | undefined {
  switch (key) {
    case 'updatedAt': return conv.updatedAt || undefined;
    case 'createdAt': return conv.createdAt || undefined;
    case 'lastContactedAt': return conv.lastContactedAt || undefined;
    case 'lastOpenedAt': return conv.lastOpenedAt || undefined;
    case 'lastMessageTime': return conv.lastMessageTime || undefined;
    case 'lastTagAt': return lastTaggedAt(conv);
    case 'firstTagAt': return firstTaggedAt(conv);
    default: return undefined;
  }
}

function customValue(conv: Conversation, key: string): string {
  return conv.customFields?.[key.slice(CUSTOM_PREFIX.length)] ?? '';
}

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function matchesText(raw: string, cond: Condition): boolean {
  const value = cond.value ?? '';
  switch (cond.op) {
    case 'isEmpty': return raw.trim() === '';
    case 'isNotEmpty': return raw.trim() !== '';
    case 'regex': {
      try { return new RegExp(value, 'i').test(raw); } catch { return false; }
    }
    default: break;
  }
  const hay = norm(raw);
  const needle = norm(value);
  switch (cond.op) {
    case 'contains': return hay.includes(needle);
    case 'notContains': return !hay.includes(needle);
    case 'is': return hay === needle;
    case 'isNot': return hay !== needle;
    case 'startsWith': return hay.startsWith(needle);
    case 'endsWith': return hay.endsWith(needle);
    default: return true;
  }
}

function matchesNumber(raw: number | undefined, cond: Condition): boolean {
  if (cond.op === 'isEmpty') return raw === undefined;
  if (cond.op === 'isNotEmpty') return raw !== undefined;
  if (raw === undefined) return false;
  const a = Number(cond.value);
  const b = Number(cond.value2);
  switch (cond.op) {
    case 'eq': return raw === a;
    case 'neq': return raw !== a;
    case 'gt': return raw > a;
    case 'gte': return raw >= a;
    case 'lt': return raw < a;
    case 'lte': return raw <= a;
    case 'between': return raw >= Math.min(a, b) && raw <= Math.max(a, b);
    default: return true;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight local time on a YYYY-MM-DD string, or null if unparseable. */
function startOfDay(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/**
 * Shift a timestamp by a whole number of units. Calendar-aware, so "in the last
 * 3 months" means three calendar months back, not 90 days.
 */
function shift(from: number, n: number, unit: DurationUnit): number {
  const d = new Date(from);
  switch (unit) {
    case 'hours': d.setHours(d.getHours() + n); break;
    case 'weeks': d.setDate(d.getDate() + n * 7); break;
    case 'months': d.setMonth(d.getMonth() + n); break;
    case 'years': d.setFullYear(d.getFullYear() + n); break;
    case 'days':
    default: d.setDate(d.getDate() + n); break;
  }
  return d.getTime();
}

function matchesDate(ts: number | undefined, cond: Condition, now: number): boolean {
  if (cond.op === 'isEmpty') return ts === undefined;
  if (cond.op === 'isNotEmpty') return ts !== undefined;
  if (ts === undefined) return false;

  const n = Number(cond.value);
  const unit = cond.unit || 'days';
  switch (cond.op) {
    case 'inLast': return ts <= now && ts >= shift(now, -n, unit);
    case 'notInLast': return !(ts <= now && ts >= shift(now, -n, unit));
    case 'inNext': return ts >= now && ts <= shift(now, n, unit);
    case 'on': {
      const start = startOfDay(cond.value);
      return start !== null && ts >= start && ts < start + DAY_MS;
    }
    case 'before': {
      const start = startOfDay(cond.value);
      return start !== null && ts < start;
    }
    case 'after': {
      const start = startOfDay(cond.value);
      return start !== null && ts >= start + DAY_MS;
    }
    case 'between': {
      const a = startOfDay(cond.value);
      const b = startOfDay(cond.value2);
      if (a === null || b === null) return false;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b) + DAY_MS;
      return ts >= lo && ts < hi;
    }
    default: return true;
  }
}

function matchesTags(convTags: string[], cond: Condition): boolean {
  const want = cond.values || [];
  const have = new Set(convTags);
  switch (cond.op) {
    case 'isEmpty': return convTags.length === 0;
    case 'isNotEmpty': return convTags.length > 0;
    case 'hasAny': return want.some((t) => have.has(t));
    case 'hasAll': return want.every((t) => have.has(t));
    case 'hasNone': return !want.some((t) => have.has(t));
    case 'isExactly': return convTags.length === want.length && want.every((t) => have.has(t));
    default: return true;
  }
}

function matchesTagGroups(conv: Conversation, cond: Condition, ctx: QueryContext): boolean {
  const wantGroups = cond.values || [];
  // Which of the selected groups this contact has at least one tag in.
  const hit = new Set<string>();
  for (const tagId of conv.tags) {
    const g = ctx.tags[tagId]?.groupId;
    if (g && wantGroups.includes(g)) hit.add(g);
  }
  switch (cond.op) {
    case 'inAny': return hit.size > 0;
    case 'inAll': return wantGroups.every((g) => hit.has(g));
    case 'inNone': return hit.size === 0;
    default: return true;
  }
}

/**
 * Per-tag dates: "was <tag> added in the last 30 days". The condition passes
 * when ANY of the selected tags (or any tag at all, when none are selected) has
 * a recorded date satisfying the date operator.
 */
function matchesTagDate(conv: Conversation, cond: Condition, now: number): boolean {
  const stamps = conv.tagAddedAt || {};
  const scope = cond.tagIds && cond.tagIds.length > 0
    ? cond.tagIds.filter((id) => conv.tags.includes(id))
    : conv.tags;

  if (cond.op === 'isEmpty') return scope.every((id) => stamps[id] === undefined);
  if (cond.op === 'isNotEmpty') return scope.some((id) => stamps[id] !== undefined);
  return scope.some((id) => stamps[id] !== undefined && matchesDate(stamps[id], cond, now));
}

function matchesEnum(raw: string, cond: Condition): boolean {
  const want = cond.values || [];
  switch (cond.op) {
    case 'isEmpty': return raw === '';
    case 'isNotEmpty': return raw !== '';
    case 'isAnyOf': return want.includes(raw);
    case 'isNoneOf': return !want.includes(raw);
    default: return true;
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function evaluateCondition(conv: Conversation, cond: Condition, fields: FieldDef[], ctx: QueryContext): boolean {
  const field = findField(fields, cond.field);
  // An unusable condition is skipped, not failed — see the file header.
  if (!field || conditionIssue(cond, fields)) return true;

  const isCustom = cond.field.startsWith(CUSTOM_PREFIX);

  switch (field.kind) {
    case 'text':
      return matchesText(isCustom ? customValue(conv, cond.field) : textOf(conv, cond.field), cond);

    case 'number': {
      if (cond.field === 'tagCount') return matchesNumber(conv.tags.length, cond);
      const raw = customValue(conv, cond.field);
      const parsed = raw === '' ? undefined : Number(raw);
      return matchesNumber(parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined, cond);
    }

    case 'date': {
      const ts = isCustom ? startOfDay(customValue(conv, cond.field)) ?? undefined : dateOf(conv, cond.field);
      return matchesDate(ts, cond, ctx.now);
    }

    case 'tags': return matchesTags(conv.tags, cond);
    case 'tagGroups': return matchesTagGroups(conv, cond, ctx);
    case 'tagDate': return matchesTagDate(conv, cond, ctx.now);

    case 'boolean': {
      const v = cond.field === 'archived' ? !!conv.archived : !!conv.nameManual;
      return cond.op === 'isTrue' ? v : !v;
    }

    case 'enum': {
      // Contacts captured before `source` existed came from Messenger.
      const raw = isCustom ? customValue(conv, cond.field)
        : cond.field === 'source' ? (conv.source || 'messenger')
        : '';
      return matchesEnum(raw, cond);
    }

    default:
      return true;
  }
}

function evaluateNode(conv: Conversation, node: QueryNode, fields: FieldDef[], ctx: QueryContext): boolean {
  if (node.type === 'condition') return evaluateCondition(conv, node, fields, ctx);

  // Only children that can actually be applied get a vote, so a half-finished
  // row never turns an OR group into a match-everything.
  const votes = node.children
    .filter((c) => c.type === 'group' || !conditionIssue(c, fields))
    .map((c) => evaluateNode(conv, c, fields, ctx));

  if (votes.length === 0) return true; // empty group matches everything
  const result = node.combinator === 'and' ? votes.every(Boolean) : votes.some(Boolean);
  return node.negate ? !result : result;
}

/** Does this contact satisfy the query? An empty query matches everything. */
export function matchesQuery(conv: Conversation, query: QueryGroup | null | undefined, ctx: QueryContext): boolean {
  if (!query) return true;
  return evaluateNode(conv, query, buildFields(ctx.fieldDefs), ctx);
}

/** Filter a list in one pass, building the field registry only once. */
export function filterByQuery(convs: Conversation[], query: QueryGroup | null | undefined, ctx: QueryContext): Conversation[] {
  if (isQueryEmpty(query)) return convs;
  const fields = buildFields(ctx.fieldDefs);
  return convs.filter((c) => evaluateNode(c, query!, fields, ctx));
}

// ---------------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------------

function quote(s: string | undefined): string {
  return `"${s ?? ''}"`;
}

function describeCondition(cond: Condition, fields: FieldDef[], ctx: QueryContext): string {
  const field = findField(fields, cond.field);
  if (!field) return `(unknown field)`;
  const def = operatorDef(field.kind, cond.op);
  const opLabel = def?.label || cond.op;

  const tagName = (id: string) => ctx.tags[id]?.name || 'deleted tag';
  const groupName = (id: string) => ctx.tagGroups[id]?.name || 'deleted group';

  // tagDate reads as "<tag> added is in the last 30 days" rather than repeating
  // the generic field label, because the tag scope is the real subject.
  const subject = field.kind === 'tagDate'
    ? `${cond.tagIds && cond.tagIds.length ? cond.tagIds.map(tagName).join(' / ') : 'Any tag'} added`
    : field.label;
  const phrase = `${subject} ${opLabel}`;

  switch (def?.arity) {
    case 'none':
      return phrase;
    case 'duration':
      return `${phrase} ${cond.value || '?'} ${cond.unit || 'days'}`;
    case 'two':
      return `${phrase} ${quote(cond.value)} and ${quote(cond.value2)}`;
    case 'multi': {
      const names = (cond.values || []).map(field.kind === 'tags' ? tagName : field.kind === 'tagGroups' ? groupName : (v: string) => v);
      return `${phrase} [${names.join(', ')}]`;
    }
    case 'one':
    default:
      return `${phrase} ${quote(cond.value)}`;
  }
}

function describeNode(node: QueryNode, fields: FieldDef[], ctx: QueryContext, depth: number): string {
  // Describe only what actually runs — an incomplete condition is skipped by
  // the evaluator, so listing it here would misstate the filter.
  if (node.type === 'condition') {
    return conditionIssue(node, fields) ? '' : describeCondition(node, fields, ctx);
  }

  const parts = node.children.map((c) => describeNode(c, fields, ctx, depth + 1)).filter(Boolean);
  if (parts.length === 0) return '';
  const joined = parts.join(node.combinator === 'and' ? ' AND ' : ' OR ');
  const needsParens = depth > 0 && parts.length > 1;
  const body = needsParens ? `(${joined})` : joined;
  return node.negate ? `NOT (${joined})` : body;
}

/** One-line plain-English rendering of a query, for preset lists and tooltips. */
export function describeQuery(query: QueryGroup | null | undefined, ctx: QueryContext): string {
  if (isQueryEmpty(query)) return 'All contacts';
  return describeNode(query!, buildFields(ctx.fieldDefs), ctx, 0) || 'All contacts';
}

// ---------------------------------------------------------------------------
// Saved searches
// ---------------------------------------------------------------------------

export function newSavedSearch(name: string, query: QueryGroup, order: number): SavedSearch {
  const now = Date.now();
  return {
    id: `sq_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    query: JSON.parse(JSON.stringify(query)),
    order,
    createdAt: now,
    updatedAt: now,
  };
}

export function sortSavedSearches(searches: Record<string, SavedSearch>): SavedSearch[] {
  return Object.values(searches).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}
