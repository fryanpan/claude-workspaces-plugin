/**
 * Whether a comment's words reach an agent as an instruction or as quoted
 * data, decided when the server stamps the frame.
 *
 * Bryan, 29 Oct: every member of a board directs its lead. So a comment is
 * `member` when its author is a person the board's audience admits right
 * now, on every board the comment's doc reaches. The MCP child renders
 * `owner` and `member` the same way and quotes everything else.
 *
 * Five rules, each closing a way in:
 *
 *  - **By identity id, never by name.** The id resolves through the roster
 *    and the link map (`resolveIdentityId`) to a person record, and the
 *    record's email is what the audience is asked about. A typed name, an
 *    `anon-*` id nobody linked, and an agent row have no email, so none of
 *    them is a member.
 *  - **Every board, not any board.** One frame is stamped once and fanned out
 *    to every board holding the doc. A member of one of them commenting on a
 *    doc another board also holds would otherwise reach that board's lead as
 *    trusted. A doc on no board is on nobody's audience.
 *  - **Asked per comment.** Nothing is cached, so a person removed from the
 *    audience is quoted again from their next comment.
 *  - **Not the owner's name.** The rendered line names the author by the name
 *    on the comment, and a member chooses their own. A name that contains an
 *    owner name ("Bryan Chan", "Bryan (owner)", after NFKC and case
 *    folding), or that mixes Latin letters with another script (a
 *    Cyrillic "В" standing in for "B"), would put the owner's name on an
 *    unwrapped line, so that comment is quoted instead.
 *  - **Fails closed.** A throw anywhere is `untrusted`. An unreadable
 *    share-link registry already holds no audiences, which admits nobody.
 */
import {
  type CommentTrust,
  authorFields,
  commentTrustOf,
  ownerDisplayNames,
  resolveIdentityId,
} from './actor-identity.ts';

export interface CommentTrustContext {
  /** The roster row an identity id names, or null. */
  identityOf: (id: string) => { kind: string; status: string; email?: string } | null;
  /** Every board a doc's discussion reaches (`board-membership.ts`). */
  boardsForDoc: (docId: string) => Set<string>;
  /** Does this board's audience admit this address as a member now? */
  memberOf: (workspaceId: string, email: string) => boolean;
}

const fold = (text: string): string => text.normalize('NFKC').toLowerCase();

/** Latin letters beside letters of another script: the homoglyph shape. */
const MIXED_SCRIPT = (name: string): boolean =>
  /\p{Script=Latin}/u.test(name) && /(?=\p{L})\P{Script=Latin}/u.test(name);

/** Could this name be read as the owner's on a channel line? */
export function readsAsOwner(name: string): boolean {
  const folded = fold(name);
  if (MIXED_SCRIPT(folded)) return true;
  return ownerDisplayNames().some((owner) => folded.includes(fold(owner)));
}

export type CommentTrustFor = (docId: string, author: unknown) => CommentTrust;

export function createCommentTrust(ctx: CommentTrustContext): CommentTrustFor {
  const memberOfDocBoards = (docId: string, author: unknown): boolean => {
    const { id, name } = authorFields(author);
    if (!id) return false;
    if (readsAsOwner(name ?? '')) return false;
    const rec = ctx.identityOf(resolveIdentityId(id));
    if (!rec || rec.kind !== 'person' || rec.status !== 'active' || !rec.email) return false;
    const boards = ctx.boardsForDoc(docId);
    if (boards.size === 0) return false;
    for (const board of boards) if (!ctx.memberOf(board, rec.email)) return false;
    return true;
  };
  return (docId, author) => {
    const base = commentTrustOf(author);
    if (base === 'owner') return base;
    try {
      return memberOfDocBoards(docId, author) ? 'member' : 'untrusted';
    } catch {
      return 'untrusted';
    }
  };
}
