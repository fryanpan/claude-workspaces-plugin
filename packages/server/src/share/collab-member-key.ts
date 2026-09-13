/**
 * The stamp a COLLABORATION-hostname connection carries, and the sweep
 * predicate that finds the ones whose access has ended.
 *
 * Beside `shareMemberKey` in spirit and apart from it in spelling: both live
 * in the same `shareMember` field on a socket or stream, and the difference
 * between the two spellings is what keeps one verb from ending the other's
 * connection.
 */
import { shareMemberKey } from './share-links.ts';

/** The prefix that keeps a collaboration-hostname key apart from a share-link one. */
const COLLAB_KEY_PREFIX = 'collab\u0000';

/**
 * The key a COLLABORATION-hostname connection carries, in the same field as
 * `shareMemberKey` and for the same reason: its upgrade is authorized once.
 *
 * A different spelling, because a different verb ends it. A share-link member
 * is ejected by `remove_share_member`, and the same address may ALSO be
 * admitted on the collaboration hostname by a live share's allow list — so
 * removing the one membership must not reach the other connection. Turning
 * sharing off matches every key of both kinds, which is what it should do.
 */
export function collabMemberKey(workspaceId: string, email: string): string {
  return `${COLLAB_KEY_PREFIX}${shareMemberKey(workspaceId, email)}`;
}

/**
 * A sweep predicate: the collaboration-hostname keys whose membership no
 * longer holds, asked of `isMember` — the question the gate asked at the
 * upgrade, asked again now.
 *
 * Re-asked rather than matched on the share that ended, because no one share
 * admits a collaborator: membership is every live share's allow list plus the
 * owner allowlist. Someone a second share still names keeps their connection
 * when the first is revoked.
 */
export function collabMembershipEnded(
  isMember: (workspaceId: string, email: string) => boolean,
): (memberKey: string) => boolean {
  return (memberKey) => {
    if (!memberKey.startsWith(COLLAB_KEY_PREFIX)) return false;
    const [workspaceId, email, ...rest] = memberKey.slice(COLLAB_KEY_PREFIX.length).split('\u0000');
    if (!workspaceId || !email || rest.length > 0) return false;
    return !isMember(workspaceId, email);
  };
}
