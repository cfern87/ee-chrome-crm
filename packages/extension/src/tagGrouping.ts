// Bucketing tags by tag group — the one piece of tag-list logic every surface
// that shows a list of tags needs: the dashboard's contact detail, its tag
// picker and its tag filter, and the in-page panel's own two tag sections.
//
// Kept as a plain module (no React) rather than folded into dashboard/shared.tsx,
// which is TSX. The in-page panel (content.ts) is built as a standalone IIFE
// without the React plugin — see build.mjs — so anything it imports has to be
// import-clean of JSX or the content-script build breaks.

import type { Tag, TagGroup } from './storage';

/** A tag group and the subset of tags that fell into it. */
export interface TagBucket {
  key: string;
  label: string;
  color?: string;
  tags: Tag[];
}

const UNGROUPED_KEY = '__ungrouped__';

/**
 * Bucket `tags` by their tag group, in the same order the Tags tab uses
 * (`order`, then `createdAt`), with ungrouped tags last. Input order is
 * preserved inside each bucket.
 *
 * Empty buckets are dropped, so a profile shows headings only for groups the
 * contact actually has tags in. A `groupId` pointing at a deleted group counts
 * as ungrouped — the same reading as the Tags tab, so a tag can never vanish
 * from a list just because its group went away.
 */
export function bucketTagsByGroup(tags: Tag[], groups: Record<string, TagGroup>): TagBucket[] {
  const ordered = Object.values(groups).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const byGroup = new Map<string, Tag[]>();
  const ungrouped: Tag[] = [];

  for (const t of tags) {
    if (t.groupId && groups[t.groupId]) {
      const list = byGroup.get(t.groupId);
      if (list) list.push(t);
      else byGroup.set(t.groupId, [t]);
    } else {
      ungrouped.push(t);
    }
  }

  const out: TagBucket[] = [];
  for (const g of ordered) {
    const list = byGroup.get(g.id);
    if (list?.length) out.push({ key: g.id, label: g.name, color: g.color, tags: list });
  }
  if (ungrouped.length) out.push({ key: UNGROUPED_KEY, label: 'Ungrouped', tags: ungrouped });
  return out;
}

/**
 * `bucketTagsByGroup`, or one flat bucket when grouping is switched off.
 *
 * Grouping earns its keep — it's how you find a tag you half-remember — but it
 * costs a heading row per group, and in a column a few hundred pixels wide a
 * store with a dozen groups spends more height on headings than on chips. The
 * two readings are both legitimate, so this is a preference rather than a
 * layout someone has to live with.
 */
export function bucketTags(tags: Tag[], groups: Record<string, TagGroup>, grouped: boolean): TagBucket[] {
  if (grouped) return bucketTagsByGroup(tags, groups);
  // UNGROUPED_KEY deliberately: showsGroupLabels already reads that as "nothing
  // here is worth a heading", which is exactly what flat mode means.
  return tags.length ? [{ key: UNGROUPED_KEY, label: 'Ungrouped', tags }] : [];
}

/**
 * Whether to draw group headings at all. A single bucket of ungrouped tags is
 * just a flat list, and labelling it "Ungrouped" would be noise.
 */
export function showsGroupLabels(buckets: TagBucket[]): boolean {
  return buckets.some((b) => b.key !== UNGROUPED_KEY);
}
