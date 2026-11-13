import { type DocMeta, attachmentIdOf, isAttachmentMember } from '@claude-workspaces/core';
import type { LibraryRow } from './library.ts';

/**
 * The diff reviews a board's Library lists: ONE row per review, never one
 * per changed file.
 *
 * A review is filed on a board under its own id (the set id), so its member
 * docs are in no board's `docIds` and `buildLibrary` skips them. This module
 * turns the set back into a single item a person can star, find in Recently
 * Viewed, and see in Recently Created. Its row opens the review's own address,
 * `/workspaces/<ws>/attachments/<setId>`, which redirects to the review's
 * entry file.
 *
 * Only diff reviews. A folder bind is a browse of a whole folder, not an item
 * somebody made, so it stays off the list.
 */
export interface LibrarySet {
  setId: string;
  name: string;
  /** When the review was made: its oldest member's record. */
  created: number;
  /** Its newest member activity, when any is known. */
  at?: number;
}

/** A diff review's member: any member of a set that carries a diff. */
const isDiffMember = (m: DocMeta): boolean => m.type === 'diff' || m.diffBase !== undefined;

/** The diff reviews among `metas` whose set id `onBoard` accepts. */
export function diffReviewsOn(
  metas: readonly DocMeta[],
  onBoard: (setId: string) => boolean,
): LibrarySet[] {
  const sets = new Map<string, LibrarySet & { diff: boolean }>();
  for (const m of metas) {
    if (!isAttachmentMember(m)) continue;
    const setId = attachmentIdOf(m) as string;
    if (!onBoard(setId)) continue;
    let s = sets.get(setId);
    if (!s) {
      s = { setId, name: `Diff: ${setId}`, created: m.createdAt, diff: false };
      sets.set(setId, s);
    }
    if (isDiffMember(m)) s.diff = true;
    if (m.createdAt < s.created) s.created = m.createdAt;
    const last = m.lastActivityAt;
    if (last !== undefined && (s.at === undefined || last > s.at)) s.at = last;
  }
  return [...sets.values()].filter((s) => s.diff).map(({ diff: _diff, ...s }) => s);
}

/** The Library row a review is listed as. */
export function setRow(workspaceId: string, s: LibrarySet): LibraryRow {
  const href = `/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(s.setId)}`;
  return { name: s.name, at: s.at ?? s.created, created: s.created, href, docId: s.setId };
}
