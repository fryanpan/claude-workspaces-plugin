/**
 * Who a connection is, and what it may do in a room.
 *
 * The app supplies both. Its own sign-in check turns a request into a
 * `Principal`; its role function says what that principal may do in one room.
 * The core never decides either, and never reads them from a message body.
 */

/** Someone the app's sign-in check vouched for. Opaque to the core. */
export interface Principal {
  id: string;
  name?: string;
}

/** What a connection may do. `null` from a role function refuses the room. */
export type CollabRole = 'owner' | 'edit' | 'comment' | 'view';

/**
 * The app's answer to "may this principal be in this room, and as what?".
 * Called at connect and on every action, so a role the app has since taken
 * away is taken away here too.
 */
export type RoleFn = (who: Principal, roomId: string) => CollabRole | null;

/** Roles whose connections may change the doc. */
export function canEdit(role: CollabRole): boolean {
  return role === 'owner' || role === 'edit';
}

/** A room id: what the address names. Letters, digits, `_` and `-`, 1 to 128. */
export const ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/;
