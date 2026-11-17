/**
 * Is this comment frame addressed to somebody other than this session?
 *
 * A comment that names who it is for (`addressedTo`, written by the server)
 * wakes only the agents it names. The server keeps it off other agents'
 * board streams, but a doc channel cannot tell an agent's stream from a
 * page's (code-health.md: `skipAgentStreams` is exact only on board
 * channels), so the frame reaches every session watching the doc and is
 * dropped here, beside the self-echo rule in `self-authored.ts`.
 *
 * Fails open: a frame with no `addressedTo`, an empty one, or a session
 * whose id does not identify one session is delivered.
 */
const COMMENT_EVENTS = new Set(['thread.created', 'thread.replied']);

function commentOf(event: string, payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as { comment?: unknown; thread?: { comments?: unknown } };
  if (p.comment && typeof p.comment === 'object') return p.comment as Record<string, unknown>;
  if (event !== 'thread.created') return undefined;
  const comments = p.thread?.comments;
  if (!Array.isArray(comments) || comments.length === 0) return undefined;
  const lastComment = comments[comments.length - 1];
  return lastComment && typeof lastComment === 'object'
    ? (lastComment as Record<string, unknown>)
    : undefined;
}

export function isAddressedElsewhere(event: string, payload: unknown, selfId: string): boolean {
  if (!COMMENT_EVENTS.has(event)) return false;
  const self = selfId.trim().toLowerCase();
  if (self === '' || self.startsWith('known-')) return false;
  const to = commentOf(event, payload)?.addressedTo;
  if (!Array.isArray(to) || to.length === 0) return false;
  return !to.some(
    (a) =>
      a !== null &&
      typeof a === 'object' &&
      typeof (a as { id?: unknown }).id === 'string' &&
      (a as { id: string }).id.trim().toLowerCase() === self,
  );
}
