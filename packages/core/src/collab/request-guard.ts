/**
 * The room a request acts on comes from its connection or its address, never
 * from its body.
 *
 * A body that names a room, board or doc is refused whole, before any
 * handler runs, even when the name it carries matches the connection's own
 * room: a handler that never sees such a field cannot be talked into using
 * it, and a caller that sends one has misunderstood where the room comes
 * from.
 *
 * A tripwire, not the boundary: it checks these exact top-level names only.
 * What keeps a request in its room is that the core takes the room from the
 * caller's address and never reads it from the body at all.
 */

/** Body keys that would name where a request acts. */
export const ROOM_KEYS = [
  'room',
  'roomId',
  'board',
  'boardId',
  'workspace',
  'workspaceId',
  'doc',
  'docId',
] as const;

/** The first room-naming key `body` carries, or null when it carries none. */
export function roomKeyInBody(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const key of ROOM_KEYS) {
    if (Object.hasOwn(body, key)) return key;
  }
  return null;
}
