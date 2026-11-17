import type { User } from '@claude-workspaces/core';

/** The part of an awareness the announce needs. */
interface LocalAwareness {
  setLocalStateField(field: string, value: unknown): void;
}

/**
 * Put this page's `user` in its awareness state: its stable id, name and
 * colour. The server replaces the id and name with the ones it proved for
 * the socket (`presence-identity.ts` on the server). For a guest it derives
 * the id from the id announced here, so a guest who sends none shares one
 * id with every other such guest, and two tabs of one browser stop matching.
 */
export function announceUser(awareness: LocalAwareness, user: User): void {
  awareness.setLocalStateField('user', { id: user.id, name: user.name, color: user.color });
}
