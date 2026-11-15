/**
 * The collaboration core: rooms that sync a Yjs doc between pages over an
 * app's storage, behind the app's own sign-in check and role function;
 * presence and one-tab follow scoped by that role function; and a
 * private-message store kept apart from every room.
 *
 * Nothing in this folder imports anything outside it but `yjs`,
 * `y-protocols` and `lib0` (`collab-imports.test.ts` holds that), so another
 * app can take it without Workspaces. Workspaces runs a board's sockets on
 * it when that board and the server are both switched on
 * (`packages/server/src/collab-core-switch.ts`).
 */
export * from './follow.ts';
export * from './presence.ts';
export * from './private-messages.ts';
export * from './request-guard.ts';
export * from './roles.ts';
export * from './room-host.ts';
export * from './storage.ts';
