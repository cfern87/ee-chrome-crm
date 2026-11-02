// Saved message templates: named messages to reuse in bulk sends, quick
// actions and automations.
//
// Kept in `store.settings` as a synced collection (settingsMerge.ts), like
// presets and automations: they are configuration and belong on every machine.
//
// Bulk sends COPY a template into the composer — a one-off send is edited
// freely before it goes. Quick actions and automations LINK to one by id
// (`templateId`), so editing the template changes what they send from then on.
// They also keep a copy of the text in their own `template` field, written
// when they're saved: older builds, which don't know templates, send that, and
// so does this one if the template is deleted.
//
// Pure module: no chrome, no DOM.

import type { Store } from './storage';
import { writeCollection, type SettingsBag, type SettingsCollection } from './settingsMerge';

export interface MessageTemplate {
  id: string;
  name: string;
  /** The message, with the same {{firstName}} / {a|b} syntax as any campaign. */
  body: string;
  order: number;
  createdAt: number;
  updatedAt?: number;
}

export const TEMPLATES_KEY = 'messageTemplates';
export const TEMPLATES_DELETED_KEY = 'messageTemplatesDeleted';
export const MAX_TEMPLATES = 50;

export function readTemplates(store: Pick<Store, 'settings'>): MessageTemplate[] {
  return allTemplatesIn(store.settings as SettingsBag).slice(0, MAX_TEMPLATES);
}

function allTemplatesIn(settings: SettingsBag | undefined): MessageTemplate[] {
  const raw = settings?.[TEMPLATES_KEY];
  if (!Array.isArray(raw)) return [];
  const out: MessageTemplate[] = [];
  for (const item of raw) {
    const t = normalizeTemplate(item);
    if (t) out.push(t);
  }
  return out.sort(compareTemplates);
}

function compareTemplates(a: MessageTemplate, b: MessageTemplate): number {
  return a.order - b.order || a.createdAt - b.createdAt;
}

function normalizeTemplate(raw: unknown): MessageTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || typeof o.body !== 'string') return null;
  return {
    id: o.id,
    name: typeof o.name === 'string' && o.name.trim() ? o.name : 'Untitled template',
    body: o.body,
    order: typeof o.order === 'number' ? o.order : 0,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    ...(typeof o.updatedAt === 'number' ? { updatedAt: o.updatedAt } : {}),
  };
}

export const TEMPLATE_COLLECTION: SettingsCollection<MessageTemplate> = {
  key: TEMPLATES_KEY,
  deletedKey: TEMPLATES_DELETED_KEY,
  max: MAX_TEMPLATES,
  readAll: allTemplatesIn,
  id: (t) => t.id,
  compare: compareTemplates,
  revision: (t) => t.updatedAt ?? t.createdAt ?? 0,
  stamp: (t, now) => ({ ...t, updatedAt: now }),
  content: (t) => {
    const { updatedAt: _rev, ...rest } = normalizeTemplate(t) as MessageTemplate;
    return JSON.stringify(rest);
  },
  arrange: (list) => list.map((t, i) => (t.order === i ? t : { ...t, order: i })),
};

/** The only supported way to save templates. See writeCollection. */
export function writeTemplates(settings: SettingsBag | undefined, next: MessageTemplate[], now = Date.now()): SettingsBag {
  return writeCollection(TEMPLATE_COLLECTION, settings, next, now);
}

export function newTemplate(name: string, body: string, order: number, now = Date.now()): MessageTemplate {
  return {
    id: `mt_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim() || 'Untitled template',
    body,
    order,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The message a linked step or automation sends: the template's current text
 * when it still exists, otherwise the copy saved alongside the link.
 */
export function resolveMessage(store: Pick<Store, 'settings'>, templateId: string | undefined, fallback: string): string {
  if (templateId) {
    const t = readTemplates(store).find((x) => x.id === templateId);
    if (t && t.body.trim()) return t.body;
  }
  return fallback;
}

/** A template's name, for describing a step that links to it. Undefined when it's gone. */
export function templateName(store: Pick<Store, 'settings'>, templateId: string | undefined): string | undefined {
  if (!templateId) return undefined;
  return readTemplates(store).find((x) => x.id === templateId)?.name;
}
