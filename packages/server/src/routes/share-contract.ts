/**
 * The contract for the sharing routes the MCP calls (`route-contract.ts`
 * says what a contract is). Two families serve them: `auth-share.ts` (the
 * `/api/share` operator routes, with the switch in `share-switch.ts` and the
 * lock in `board-lock.ts`) and `workspace-members.ts` (a member's role and a
 * board's audience, the same door the board's Settings panel uses).
 */
import { Hono } from 'hono';
import type { LockRequest } from '../share/board-lock.ts';
import type { FlipRequest } from '../share/sharing-flip.ts';
import type { SharingStatus } from '../share/sharing-gate.ts';
import { answers, contractOnly, json } from './route-contract.ts';

/** Filed on a task as an approval card when the change needs the owner. */
type Approval = { taskId?: string; why?: string };

/**
 * `share_workspace` forwards its arguments as sent, so the route refuses or
 * honours each key by name. These are the keys it reads.
 */
export interface ShareWorkspaceBody extends Approval {
  workspaceId: string;
  /** An older bundle's single-doc share: refused by name. */
  docId?: string;
  entryDocId?: string;
  label?: string;
  role?: string;
  landing?: unknown;
  allowDomains?: unknown;
  ttl?: unknown;
  ttlSeconds?: unknown;
  createdBy?: string;
}
export interface RemoveMemberBody {
  workspaceId: string;
  email: string;
}
export interface ShareTtlBody {
  ttlSeconds?: number;
  ttl?: unknown;
}
/**
 * The switch and the lock are read by strict parsers that refuse a key they
 * do not know, so each body IS what its parser returns: a field renamed there
 * fails typecheck in the parser and in the tool that sends it.
 */
export type SharingSwitchBody = FlipRequest;
export type BoardLockBody = LockRequest;
export interface MemberRoleBody extends Approval {
  role: string;
  author?: unknown;
  createdBy?: unknown;
}
export interface AudienceBody extends Approval {
  add?: string[];
  remove?: string[];
  author?: unknown;
  createdBy?: unknown;
}

/**
 * `GET /api/share`. Two tools read `sharing`: the board's closed and locked
 * lists. The other lists are named so a rename shows here, and typed as
 * unknown because no tool reads into them.
 */
export interface ShareListAnswer {
  shares: unknown[];
  links: unknown[];
  members: unknown;
  audiences: unknown;
  sharing: SharingStatus;
}

export const shareContract = new Hono()
  .get('/api/share', answers<ShareListAnswer>())
  .post('/api/share/workspace', json<ShareWorkspaceBody>(), contractOnly)
  .post('/api/share/member/remove', json<RemoveMemberBody>(), contractOnly)
  .post('/api/share/:shareId/ttl', json<ShareTtlBody>(), contractOnly)
  .delete('/api/share/:shareId', contractOnly)
  .post('/api/share/enabled', json<SharingSwitchBody>(), contractOnly)
  .post('/api/share/lock', json<BoardLockBody>(), contractOnly)
  .post('/workspaces/:ws/members/:email/role', json<MemberRoleBody>(), contractOnly)
  .post('/workspaces/:ws/audience', json<AudienceBody>(), contractOnly);

export type ShareContract = typeof shareContract;
