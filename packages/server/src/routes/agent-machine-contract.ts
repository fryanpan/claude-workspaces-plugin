/**
 * The contract for the machine-level routes the MCP calls (what a contract
 * is: `route-contract.ts`): the repo registry (`repos.ts`), the plugin
 * refresh (`ops.ts`), the plan lead's rank for a review item
 * (`review-queue.ts`) and the coach's moment (`coach.ts`). Each is
 * loopback-only or holds to the agent token, as its handler says.
 *
 * `coach_moment` reads the moment's id; every other answer is passed to the
 * agent whole.
 */
import { Hono } from 'hono';
import type { CoachMomentBody } from '../coach/judge.ts';
import { answers, contractOnly, json } from './route-contract.ts';

export type { CoachMomentBody } from '../coach/judge.ts';

/** An absolute host path to a checkout, checked by `readPath`. */
export interface RepoCheckoutBody {
  path: string;
}
/** A field left out is left as it was; `null` clears it. */
export interface RankReviewItemBody {
  agentId: string;
  key: string;
  rank?: number | null;
  goal?: string | null;
}
export interface CoachMomentAnswer {
  id: string;
}

export const agentMachineContract = new Hono()
  .get('/api/repos', contractOnly)
  .post('/api/repos/checkouts', json<RepoCheckoutBody>(), contractOnly)
  .delete('/api/repos/checkouts', json<RepoCheckoutBody>(), contractOnly)
  .post('/api/plugin/refresh', contractOnly)
  .post('/api/review-queue/rank', json<RankReviewItemBody>(), contractOnly)
  .post('/coach/moments', json<CoachMomentBody>(), answers<CoachMomentAnswer>());

export type AgentMachineContract = typeof agentMachineContract;
