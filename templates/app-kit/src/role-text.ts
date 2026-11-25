/**
 * What the doc page says about the reader's role. One table for the server's
 * first paint (`page.ts`) and the page script that follows a role change
 * (`client/main.ts`), so the two never word it differently.
 *
 * `comment` reads "You can read" on purpose: the kit has no comments, so a
 * commenter here can do exactly what a viewer can.
 */
import type { CollabRole } from '@claude-workspaces/app-kit/collab';

export const ROLE_TEXT: Record<CollabRole, string> = {
  owner: 'You own this doc',
  edit: 'You can edit',
  comment: 'You can read',
  view: 'You can read',
};

/** Whether the server keeps this role's typing. */
export const mayType = (role: string): boolean => role === 'owner' || role === 'edit';
