// CSV import/export for CRM contacts.
//
// Import accepts a contacts CSV with these columns (header names are matched
// case/space/underscore-insensitively, with common aliases):
//
//   * Full Name      — OR First Name + Last Name        (REQUIRED)
//   * Email                                              (optional)
//   * Facebook Profile URL                               (REQUIRED)
//   * Tags           — separated by ; , or |             (optional)
//
// Dedup: rows are matched against existing contacts by a normalized Facebook
// profile URL. A match UPDATES the existing contact (fills in a missing
// name/email, unions tags) rather than creating a duplicate.
//
// Export is the inverse: the same columns plus a little metadata, produced from
// whatever (filtered) set of contacts the caller passes in.
//
// Import history is verbose and machine-specific, so — like campaign history —
// it lives in chrome.storage.local (not the tiny chrome.storage.sync quota).

import { Store, Conversation, Tag, CustomFieldDef } from './storage';

// ---------------------------------------------------------------------------
// Low-level CSV parse / serialize (RFC 4180-ish: quotes, escaped quotes,
// embedded commas/newlines, optional BOM).
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  // Strip a leading UTF-8 BOM if present (Excel loves to add one).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    sawAny = true;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue; // handle \r\n and lone \r
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (sawAny) { row.push(field); rows.push(row); }

  // Drop fully-empty trailing rows (e.g. trailing newline).
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

export function csvField(v: string): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map((c) => csvField(c == null ? '' : String(c))).join(',')).join('\r\n');
}

// ---------------------------------------------------------------------------
// Header mapping
// ---------------------------------------------------------------------------

export type Field = 'firstName' | 'lastName' | 'fullName' | 'email' | 'profileUrl' | 'fbUserId' | 'fbUsername' | 'tags';

const HEADER_ALIASES: Record<Field, string[]> = {
  firstName: ['firstname', 'first', 'givenname', 'fname'],
  lastName: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  fullName: ['fullname', 'name', 'contactname', 'participantname', 'displayname'],
  email: ['email', 'emailaddress', 'e-mail', 'mail'],
  profileUrl: [
    'facebookprofileurl', 'facebookprofile', 'profileurl', 'facebookurl',
    'fburl', 'fbprofile', 'facebook', 'profile', 'profilelink', 'url', 'link',
  ],
  fbUserId: [
    'fbuserid', 'facebookuserid', 'facebookid', 'fbid', 'userid', 'uid',
    'fbuid', 'profileid', 'fbprofileid', 'id',
  ],
  fbUsername: [
    'fbusername', 'facebookusername', 'username', 'fbhandle', 'handle',
    'vanity', 'vanityname', 'fbvanity', 'screenname',
  ],
  tags: ['tags', 'tag', 'labels', 'label', 'groups'],
};

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_]+/g, '').trim();
}

export type Mapping = Partial<Record<Field, number>>; // field -> column index

// Fields the user can map a CSV column onto, in display order, grouped so the
// UI can show which are required (a name + at least one identity).
export const MAPPABLE_FIELDS: { field: Field; label: string; group: 'name' | 'identity' | 'other' }[] = [
  { field: 'fullName', label: 'Full Name', group: 'name' },
  { field: 'firstName', label: 'First Name', group: 'name' },
  { field: 'lastName', label: 'Last Name', group: 'name' },
  { field: 'email', label: 'Email', group: 'other' },
  { field: 'profileUrl', label: 'Facebook Profile URL', group: 'identity' },
  { field: 'fbUserId', label: 'FB User ID', group: 'identity' },
  { field: 'fbUsername', label: 'FB Username', group: 'identity' },
  { field: 'tags', label: 'Tags', group: 'other' },
];

export function detectMapping(headers: string[]): Mapping {
  const norm = headers.map(normHeader);
  const mapping: Mapping = {};
  const taken = new Set<number>();
  (Object.keys(HEADER_ALIASES) as Field[]).forEach((field) => {
    for (const alias of HEADER_ALIASES[field]) {
      const idx = norm.indexOf(alias);
      if (idx !== -1 && !taken.has(idx)) { mapping[field] = idx; taken.add(idx); return; }
    }
  });
  return mapping;
}

/** The (trimmed) header row of a CSV, for building a field-mapping UI. */
export function csvHeaders(text: string): string[] {
  const rows = parseCsv(text);
  return rows.length ? rows[0].map((h) => h.trim()) : [];
}

// ---------------------------------------------------------------------------
// Profile-URL normalization (dedup key + display normalization)
// ---------------------------------------------------------------------------

/** Normalize a Facebook profile URL for storage; returns null if unusable. */
export function normalizeProfileUrl(raw: string): string | null {
  let s = (raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  let path = u.pathname.replace(/\/+$/, '');
  // profile.php?id=123 — the id is the identity, keep it.
  const search = /profile\.php$/i.test(path) && u.searchParams.get('id')
    ? `?id=${u.searchParams.get('id')}`
    : '';
  return `https://${host}${path}${search}`;
}

/** Stable dedup key derived from a profile URL (lowercased, no trailing slash). */
export function profileKey(raw: string | undefined | null): string | null {
  const norm = normalizeProfileUrl(raw || '');
  return norm ? norm.toLowerCase() : null;
}

const FB_HOST_RE = /(facebook\.com|fb\.com|fb\.me|messenger\.com)/i;

// ---------------------------------------------------------------------------
// Profile URL → Messenger thread (so imported contacts are messageable)
// ---------------------------------------------------------------------------
//
// For a 1:1 Messenger chat the thread id IS the contact's id in the /t/<id>
// path segment — numeric for most users, or a vanity username (Facebook
// accepts both, which is why content.ts preserves whatever segment it sees).
// We map a profile URL onto that segment and build the canonical chat URL in
// the exact format the rest of the extension already uses:
//   https://www.facebook.com/messages/t/<threadId>/
//
//   * profile.php?id=<N>            → threadId = N         (numeric, exact)
//   * facebook.com/<username>       → threadId = username  (vanity; later
//                                     upgraded to the numeric id when the
//                                     profile is viewed — see content.ts)
//   * m.me/<x>, messenger.com/t/<x> → threadId = x
//
// App/section paths (groups, pages, watch, …) are NOT user profiles, so they
// resolve to null and the contact is imported without a chat URL.

export const RESERVED_FB_PATHS = new Set([
  'messages', 'profile.php', 'pages', 'page', 'pg', 'groups', 'group', 'watch',
  'marketplace', 'events', 'event', 'gaming', 'games', 'photo', 'photo.php',
  'story.php', 'permalink.php', 'media', 'sharer', 'sharer.php', 'share', 'login',
  'recover', 'settings', 'bookmarks', 'friends', 'notifications', 'search',
  'home.php', 'public', 'people', 'policies', 'privacy', 'terms', 'help',
  'business', 'developers', 'careers', 'about', 'reel', 'reels', 'stories',
]);

export interface ThreadRef {
  threadId: string;   // the /t/<id> segment
  chatUrl: string;    // canonical https://www.facebook.com/messages/t/<id>/
  numeric: boolean;   // true for an exact numeric fbid
}

export function extractThreadFromProfileUrl(raw: string | undefined | null): ThreadRef | null {
  const norm = normalizeProfileUrl(raw || '');
  if (!norm) return null;
  let u: URL;
  try { u = new URL(norm); } catch { return null; }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);

  const make = (segRaw: string | undefined): ThreadRef | null => {
    const seg = (segRaw || '').trim();
    if (!seg) return null;
    return { threadId: seg, chatUrl: `https://www.facebook.com/messages/t/${seg}/`, numeric: /^\d+$/.test(seg) };
  };

  const isFb = /(^|\.)facebook\.com$/i.test(host);

  // profile.php?id=N → numeric thread id (exact).
  if (isFb && segs[0]?.toLowerCase() === 'profile.php') {
    const id = u.searchParams.get('id');
    return id && /^\d+$/.test(id) ? make(id) : null;
  }
  // Already a chat/deep link.
  if (host === 'm.me') return make(segs[0]);
  if (isFb && segs[0]?.toLowerCase() === 'messages' && segs[1]?.toLowerCase() === 't') return make(segs[2]);
  if (host.endsWith('messenger.com') && segs[0]?.toLowerCase() === 't') return make(segs[1]);
  // Vanity profile: first path segment is the username (skip app/section paths).
  if (isFb && segs.length >= 1) {
    if (RESERVED_FB_PATHS.has(segs[0].toLowerCase())) return null;
    return make(segs[0]);
  }
  return null;
}

// A contact's Facebook identity can arrive as any combination of a profile URL,
// a numeric user id, or a vanity username (the profile URL may be absent when
// an id/username is supplied). These normalize each piece.

/** Numeric fbid, or '' if the value isn't a clean numeric id. */
export function cleanFbUserId(raw: string | undefined | null): string {
  const s = (raw || '').trim();
  if (/^\d+$/.test(s)) return s;
  // Tolerate a profile.php?id= URL or "id=123" dropped in the id column.
  const m = s.match(/(?:[?&]id=|\bid[:=]\s*|profile\/)(\d{5,})/i);
  return m ? m[1] : '';
}

/** Bare vanity username (no @, no URL), or '' if not usable. */
export function cleanFbUsername(raw: string | undefined | null): string {
  let s = (raw || '').trim();
  if (!s) return '';
  // If a full URL was dropped in the username column, pull the handle out.
  if (/facebook\.com|fb\.com|fb\.me|m\.me|messenger\.com/i.test(s) || /^https?:\/\//i.test(s)) {
    const t = extractThreadFromProfileUrl(s);
    if (t && !t.numeric) return t.threadId;
    if (t && t.numeric) return ''; // it's actually an id, not a username
  }
  s = s.replace(/^@+/, '').replace(/\/+$/, '').trim();
  // Facebook usernames are letters, digits and dots.
  return /^[a-zA-Z0-9.]+$/.test(s) && !/^\d+$/.test(s) ? s : '';
}

export interface IdentityInput {
  profileUrl?: string;
  fbUserId?: string;
  fbUsername?: string;
}

/**
 * Resolve a contact's Messenger thread from any mix of identity fields, in
 * order of reliability:
 *   1. numeric FB user id        (exact thread id)
 *   2. profile URL → numeric id  (profile.php?id=N)
 *   3. FB username               (vanity thread, upgraded later on profile view)
 *   4. profile URL → vanity
 */
export function resolveThread(input: IdentityInput): ThreadRef | null {
  const uid = cleanFbUserId(input.fbUserId);
  if (uid) return { threadId: uid, chatUrl: `https://www.facebook.com/messages/t/${uid}/`, numeric: true };

  const fromUrl = extractThreadFromProfileUrl(input.profileUrl);
  if (fromUrl?.numeric) return fromUrl;

  const uname = cleanFbUsername(input.fbUsername);
  if (uname) return { threadId: uname, chatUrl: `https://www.facebook.com/messages/t/${uname}/`, numeric: false };

  return fromUrl; // vanity from the profile URL, or null
}

/**
 * The profile URL to store/display for a contact. Uses the supplied URL when
 * present, otherwise synthesizes one from the id or username so "Open Profile",
 * export and profile-page matching all work.
 */
export function deriveProfileUrl(input: IdentityInput): string {
  const norm = normalizeProfileUrl(input.profileUrl || '');
  if (norm) return norm;
  const uid = cleanFbUserId(input.fbUserId);
  if (uid) return `https://facebook.com/profile.php?id=${uid}`;
  const uname = cleanFbUsername(input.fbUsername);
  if (uname) return `https://facebook.com/${uname}`;
  return '';
}

// ---------------------------------------------------------------------------
// Parse + validate rows into contacts
// ---------------------------------------------------------------------------

export interface ParsedContact {
  rowNumber: number;      // 1-based source row (data rows only, header excluded)
  name: string;
  email: string;
  profileUrl: string;     // provided or synthesized, normalized; '' if none
  fbUserId: string;       // numeric fbid, or ''
  fbUsername: string;     // vanity handle, or ''
  tags: string[];         // tag names (not ids)
}

export interface RowError {
  rowNumber: number;
  reason: string;
}

export interface ParseResult {
  headers: string[];
  mapping: Mapping;
  missingRequired: string[];   // required columns not found in the header
  contacts: ParsedContact[];   // valid rows
  errors: RowError[];          // invalid rows, with reasons
  warnings: RowError[];        // imported, but worth flagging (e.g. non-FB URL)
  totalDataRows: number;
}

function splitTags(cell: string): string[] {
  return (cell || '')
    .split(/[;,|]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function dedupeTags(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const k = n.toLowerCase();
    if (n && !seen.has(k)) { seen.add(k); out.push(n); }
  }
  return out;
}

export interface ParseOptions {
  /** Explicit field→column mapping. When omitted, headers are auto-detected. */
  mapping?: Mapping;
  /** Tag names applied to EVERY imported contact (regardless of a Tags column). */
  applyTags?: string[];
  /** Whether to read per-row tags from the mapped Tags column. Default true. */
  importFileTags?: boolean;
}

export function parseContactsCsv(text: string, opts: ParseOptions = {}): ParseResult {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { headers: [], mapping: {}, missingRequired: ['Full Name (or First Name / Last Name)', 'Facebook Profile URL, FB User ID, or FB Username'], contacts: [], errors: [], warnings: [], totalDataRows: 0 };
  }

  const headers = rows[0].map((h) => h.trim());
  const mapping = opts.mapping ?? detectMapping(headers);
  const applyTags = (opts.applyTags || []).map((t) => t.trim()).filter(Boolean);
  const importFileTags = opts.importFileTags !== false;

  const hasName = mapping.fullName != null || mapping.firstName != null || mapping.lastName != null;
  // Identity can come from any of: profile URL, FB user id, or FB username.
  const hasIdentity = mapping.profileUrl != null || mapping.fbUserId != null || mapping.fbUsername != null;
  const missingRequired: string[] = [];
  if (!hasName) missingRequired.push('Full Name (or First Name / Last Name)');
  if (!hasIdentity) missingRequired.push('Facebook Profile URL, FB User ID, or FB Username');

  const contacts: ParsedContact[] = [];
  const errors: RowError[] = [];
  const warnings: RowError[] = [];

  // If required headers are missing we can't validate rows meaningfully.
  if (missingRequired.length > 0) {
    return { headers, mapping, missingRequired, contacts, errors, warnings, totalDataRows: Math.max(0, rows.length - 1) };
  }

  const at = (cols: string[], idx?: number) => (idx == null ? '' : (cols[idx] || '').trim());

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const rowNumber = i; // 1-based data row
    const fullName = at(cols, mapping.fullName);
    const first = at(cols, mapping.firstName);
    const last = at(cols, mapping.lastName);
    const name = (fullName || `${first} ${last}`).trim();
    const email = at(cols, mapping.email);
    const rawProfile = at(cols, mapping.profileUrl);
    const rawUserId = at(cols, mapping.fbUserId);
    const rawUsername = at(cols, mapping.fbUsername);
    const fileTags = importFileTags && mapping.tags != null ? splitTags(cols[mapping.tags] || '') : [];

    // Skip a row that is entirely blank (ignore applyTags here, since those
    // would otherwise make every empty trailing line look non-blank).
    if (!name && !email && !rawProfile && !rawUserId && !rawUsername && fileTags.length === 0) continue;

    if (!name) { errors.push({ rowNumber, reason: 'Missing name (Full Name, or First + Last Name)' }); continue; }

    const anyIdentityRaw = !!(rawProfile || rawUserId || rawUsername);
    if (!anyIdentityRaw) { errors.push({ rowNumber, reason: 'Missing Facebook identity (profile URL, user id, or username)' }); continue; }

    const id = { profileUrl: rawProfile, fbUserId: rawUserId, fbUsername: rawUsername };
    const fbUserId = cleanFbUserId(rawUserId);
    const fbUsername = cleanFbUsername(rawUsername);
    const profileUrl = deriveProfileUrl(id);
    const thread = resolveThread(id);

    // A row is usable if we could derive a profile URL or resolve a thread.
    if (!profileUrl && !thread) {
      errors.push({ rowNumber, reason: 'No usable Facebook identity — profile URL, user id and username were all invalid' });
      continue;
    }

    if (rawUserId && !fbUserId) {
      warnings.push({ rowNumber, reason: `FB User ID "${rawUserId}" is not a numeric id — ignored` });
    }
    if (rawProfile && !normalizeProfileUrl(rawProfile)) {
      warnings.push({ rowNumber, reason: `Profile URL "${rawProfile}" couldn't be parsed — used id/username instead` });
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      warnings.push({ rowNumber, reason: `Email "${email}" looks malformed — imported as-is` });
    }
    if (profileUrl && !FB_HOST_RE.test(profileUrl)) {
      warnings.push({ rowNumber, reason: `URL "${profileUrl}" is not a Facebook domain — imported anyway` });
    }

    const tags = dedupeTags([...fileTags, ...applyTags]);
    contacts.push({ rowNumber, name, email, profileUrl, fbUserId, fbUsername, tags });
  }

  return { headers, mapping, missingRequired, contacts, errors, warnings, totalDataRows: Math.max(0, rows.length - 1) };
}

// ---------------------------------------------------------------------------
// Apply parsed contacts to the store (dedup + tag creation)
// ---------------------------------------------------------------------------

const TAG_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7B801', '#9B5DE5', '#00BBF9', '#F15BB5', '#06D6A0'];

function randomColor(seed: number): string {
  return TAG_COLORS[seed % TAG_COLORS.length];
}

export interface ApplyResult {
  store: Store;
  added: number;
  updated: number;
  tagsCreated: string[];
}

/**
 * Build a new store from the current one plus the parsed contacts.
 * - Matches existing contacts by normalized profile URL → updates in place
 *   (fills a missing name/email, sets profileUrl, unions tags).
 * - Creates missing tags by name (case-insensitive), assigning a color.
 * - Pure: does not mutate `store`.
 */
export function applyContacts(store: Store, contacts: ParsedContact[]): ApplyResult {
  const conversations: Record<string, Conversation> = { ...store.conversations };
  const tags: Record<string, Tag> = { ...store.tags };

  // Index existing tags by lowercased name for case-insensitive matching.
  const tagIdByName = new Map<string, string>();
  for (const t of Object.values(tags)) tagIdByName.set(t.name.toLowerCase(), t.id);

  const tagsCreated: string[] = [];
  const ensureTag = (name: string): string => {
    const key = name.toLowerCase();
    const existing = tagIdByName.get(key);
    if (existing) return existing;
    const id = `tag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    tags[id] = { id, name, color: randomColor(tagIdByName.size), createdAt: Date.now() };
    tagIdByName.set(key, id);
    tagsCreated.push(name);
    return id;
  };

  // Index existing conversations by every identity facet (profile URL, fbid,
  // username, thread id), so an imported row matches the same person regardless
  // of which identity field the file happened to carry — and merges with a
  // contact already captured from Messenger instead of duplicating them.
  const index = new Map<string, string>(); // facet key -> conversation id
  const facetKeys = (c: Conversation): string[] => {
    const ks: string[] = [];
    const pk = profileKey(c.profileUrl);
    if (pk) ks.push('p:' + pk);
    if (c.fbUserId) ks.push('u:' + c.fbUserId);
    if (c.fbUsername) ks.push('n:' + c.fbUsername.toLowerCase());
    ks.push('t:' + String(c.id).toLowerCase());
    if (c.participantId) ks.push('t:' + String(c.participantId).toLowerCase());
    return ks;
  };
  const reindex = (c: Conversation) => { for (const k of facetKeys(c)) index.set(k, c.id); };
  for (const c of Object.values(conversations)) reindex(c);

  let added = 0;
  let updated = 0;
  const now = Date.now();

  for (const pc of contacts) {
    const tagIds = pc.tags.map(ensureTag);
    const thread = resolveThread(pc);

    // Candidate identity keys for this row, in the same namespaces as the index.
    const cands: string[] = [];
    const pk = profileKey(pc.profileUrl);
    if (pk) cands.push('p:' + pk);
    if (pc.fbUserId) cands.push('u:' + pc.fbUserId);
    if (pc.fbUsername) cands.push('n:' + pc.fbUsername.toLowerCase());
    if (thread) cands.push('t:' + thread.threadId.toLowerCase());

    let existingId: string | undefined;
    for (const k of cands) {
      const hit = index.get(k);
      if (hit && conversations[hit]) { existingId = hit; break; }
    }

    if (existingId) {
      const prev = conversations[existingId];
      // Only fill fields that are currently empty — never clobber data the user
      // may have curated, or a real thread id/chat URL captured from Messenger.
      const next: Conversation = {
        ...prev,
        participantName: prev.participantName?.trim() || pc.name,
        email: prev.email || pc.email || undefined,
        profileUrl: prev.profileUrl || pc.profileUrl || undefined,
        fbUserId: prev.fbUserId || pc.fbUserId || undefined,
        fbUsername: prev.fbUsername || pc.fbUsername || undefined,
        chatUrl: prev.chatUrl || thread?.chatUrl,
        participantId: prev.participantId || thread?.threadId || prev.id,
        tags: Array.from(new Set([...prev.tags, ...tagIds])),
        updatedAt: now,
      };
      conversations[existingId] = next;
      reindex(next);
      updated++;
    } else {
      // Key new contacts by their resolved thread id when we have one, so they
      // line up with Messenger-captured conversations (which use the same key);
      // otherwise fall back to a synthetic id derived from the identity.
      const seed = (pk || pc.fbUsername || pc.fbUserId || Math.random().toString(36).slice(2));
      const id = thread?.threadId || `imp_${seed.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}_${Math.random().toString(36).slice(2, 6)}`;
      const conv: Conversation = {
        id,
        participantName: pc.name,
        participantId: id,
        lastMessage: '',
        lastMessageTime: now,
        tags: tagIds,
        email: pc.email || undefined,
        profileUrl: pc.profileUrl || undefined,
        fbUserId: pc.fbUserId || undefined,
        fbUsername: pc.fbUsername || undefined,
        chatUrl: thread?.chatUrl,
        source: 'import',
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
      conversations[id] = conv;
      reindex(conv);
      added++;
    }
  }

  return { store: { ...store, conversations, tags }, added, updated, tagsCreated };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXPORT_COLUMNS = ['Full Name', 'Email', 'Facebook Profile URL', 'FB User ID', 'FB Username', 'Tags', 'Archived', 'Date Added', 'Last Contacted'];

/**
 * Serialize contacts to a re-importable CSV. `tagsById` resolves tag ids →
 * names. When `fieldDefs` are supplied, one extra column per custom field is
 * appended (in the given order), carrying each contact's value.
 */
export function contactsToCsv(convs: Conversation[], tagsById: Record<string, Tag>, fieldDefs: CustomFieldDef[] = []): string {
  const header = [...EXPORT_COLUMNS, ...fieldDefs.map((f) => f.name)];
  const rows: (string | number)[][] = [header];
  for (const c of convs) {
    const tagNames = c.tags.map((id) => tagsById[id]?.name).filter(Boolean).join('; ');
    rows.push([
      c.participantName || '',
      c.email || '',
      // Prefer the real profile URL; fall back to the Messenger thread URL so
      // every exported row carries a usable link.
      c.profileUrl || c.chatUrl || '',
      c.fbUserId || '',
      c.fbUsername || '',
      tagNames,
      c.archived ? 'yes' : 'no',
      c.createdAt ? new Date(c.createdAt).toISOString() : '',
      c.lastContactedAt ? new Date(c.lastContactedAt).toISOString() : '',
      ...fieldDefs.map((f) => c.customFields?.[f.id] ?? ''),
    ]);
  }
  return toCsv(rows);
}

/** A small sample CSV users can download as a template. */
export function sampleCsv(): string {
  return toCsv([
    ['Full Name', 'Email', 'Facebook Profile URL', 'FB User ID', 'FB Username', 'Tags'],
    ['Jane Doe', 'jane@example.com', 'https://www.facebook.com/jane.doe', '', '', 'lead; vip'],
    ['John Smith', '', 'https://www.facebook.com/profile.php?id=100012345678', '', '', 'lead'],
    ['Mary Major', 'mary@example.com', '', '100098765432', '', 'customer'],
    ['Sam Spade', '', '', '', 'sam.spade', 'lead'],
  ]);
}

// ---------------------------------------------------------------------------
// Import history (machine-local, chrome.storage.local)
// ---------------------------------------------------------------------------

export const IMPORT_HISTORY_KEY = 'facebook_crm_import_history';
export const MAX_IMPORT_HISTORY = 50;
const MAX_ERROR_SAMPLES = 25;

export interface ImportHistoryEntry {
  id: string;
  fileName: string;
  importedAt: number;
  totalRows: number;
  added: number;
  updated: number;
  errors: number;
  warnings: number;
  tagsCreated: string[];
  errorSamples: RowError[];   // capped
}

function localGet<T>(key: string): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) { resolve(null); return; }
      chrome.storage.local.get(key, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve((res?.[key] as T) ?? null);
      });
    } catch { resolve(null); }
  });
}

function localSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) { resolve(); return; }
      chrome.storage.local.set({ [key]: value }, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

export async function loadImportHistory(): Promise<ImportHistoryEntry[]> {
  const list = await localGet<ImportHistoryEntry[]>(IMPORT_HISTORY_KEY);
  return Array.isArray(list) ? list : [];
}

/** Prepend an entry to the import history, capping total retained entries. */
export async function recordImport(
  entry: Omit<ImportHistoryEntry, 'id' | 'importedAt' | 'errorSamples'> & { errorSamples: RowError[] },
): Promise<ImportHistoryEntry> {
  const full: ImportHistoryEntry = {
    id: `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    importedAt: Date.now(),
    ...entry,
    errorSamples: entry.errorSamples.slice(0, MAX_ERROR_SAMPLES),
  };
  const prev = await loadImportHistory();
  const next = [full, ...prev].slice(0, MAX_IMPORT_HISTORY);
  await localSet(IMPORT_HISTORY_KEY, next);
  return full;
}
