/**
 * The collaboration core: rooms that sync a Yjs doc between pages over an
 * app's storage, behind the app's own sign-in check and role function;
 * presence and one-tab follow scoped by that role function; and a
 * private-message store kept apart from every room.
 *
 * Nothing in this folder imports anything outside it but `yjs`,
 * `y-protocols` and `lib0` (`collab-imports.test.ts` holds that), so another
 * app can take it without Workspaces. Workspaces itself does not run on it
 * yet: it moves onto the core in step 5 of the D1 plan.
 */
export * from './follow.ts';
export * from './presence.ts';
export * from './private-messages.ts';
export * from './request-guard.ts';
export * from './roles.ts';
export * from './room-host.ts';
export * from './storage.ts';
