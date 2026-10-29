/**
 * What the access page draws (`GET /api/access`): every board somebody other
 * than the owner can reach, the entries that let them in, the people who
 * came in under each, and the access changes agents proposed.
 *
 * One reading, built from the same stores the gate reads, so the page cannot
 * list a person the next request would refuse: `membersOf` already drops a
 * row its audience no longer admits.
 */
import { type AccessProposalRow } from './access-proposals.ts';
import { type AudienceEntry, admittingEntry } from './board-audience.ts';
import type { BoardRole } from './board-role.ts';
import type { ShareLinks } from './share-links.ts';

export interface AccessPerson {
  email: string;
  role: BoardRole;
  /** When they first signed in through a link. */
  addedAt: number;
  /** The audience entry that admits them: their address, or an `@domain`. */
  entry?: string;
  /** The label of the link they came through, when it had one. */
  link?: string;
}

export interface AccessBoard {
  workspaceId: string;
  name: string;
  audience: AudienceEntry[];
  people: AccessPerson[];
}

export interface AccessView {
  boards: AccessBoard[];
  proposals: AccessProposalRow[];
}

/** One board's people, each filed under the entry that admits them. */
export function accessPeople(shareLinks: ShareLinks, workspaceId: string): AccessPerson[] {
  const audience = shareLinks.audienceOf(workspaceId);
  return shareLinks.membersOf(workspaceId).map((m) => {
    const entry = admittingEntry(audience, m.email);
    const link = shareLinks.get(m.viaLinkId)?.label;
    return {
      email: m.email,
      role: m.role ?? 'member',
      addedAt: m.addedAt,
      ...(entry ? { entry } : {}),
      ...(link ? { link } : {}),
    };
  });
}

export function buildAccessView(deps: {
  boards: ReadonlyArray<{ id: string; name: string; retiredAt?: number }>;
  shareLinks: ShareLinks;
  proposals: (workspaceIds: readonly string[]) => AccessProposalRow[];
}): AccessView {
  const live = deps.boards.filter((b) => b.retiredAt === undefined);
  const proposals = deps.proposals(live.map((b) => b.id));
  const proposed = new Set(proposals.map((p) => p.workspaceId));
  const boards: AccessBoard[] = [];
  for (const b of live) {
    const audience = deps.shareLinks.audienceOf(b.id)?.entries ?? [];
    const people = accessPeople(deps.shareLinks, b.id);
    // A board nobody else can reach, and nothing proposed for, is not about
    // access at all; listing every board would bury the few that are.
    if (audience.length === 0 && people.length === 0 && !proposed.has(b.id)) continue;
    boards.push({ workspaceId: b.id, name: b.name, audience, people });
  }
  return { boards, proposals };
}
