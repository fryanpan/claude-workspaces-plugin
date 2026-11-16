/**
 * The contract for the routes the MCP calls about a board itself
 * (`route-contract.ts` says what a contract is): its record, name, archive
 * state, settings and parallelism cap, filing a doc onto it, the related
 * work it already holds, its GitHub subscriptions, its embeds and its lead.
 * `workspace-settings.ts`, `workspace-content.ts`, `workspace-related.ts`,
 * `workspaces-create-read.ts`, `github-hub.ts` and `workspace-embeds.ts`
 * serve them.
 *
 * Each answer declares only the fields a tool reads, so it is a floor on the
 * answer rather than its whole shape. `author` is resolved by `authorFor`, so
 * it is `unknown` here.
 */
import { Hono } from 'hono';
import type { SetLeadAgentResult } from '../tasks.ts';
import { answers, contractOnly, json, query } from './route-contract.ts';

export interface RetiredBody {
  retired: boolean;
  reason?: string;
  author?: unknown;
}
export interface RenameBoardBody {
  name: string;
  author?: unknown;
}
/** The board's settings; a named key is written, `null` restores its default. */
export interface BoardSettingsBody {
  reviewItemCriteria?: string | null;
  effortEstimatePrompt?: string | null;
  parallelismCap?: number | null;
  notesHome?: unknown;
  showEstimates?: unknown;
  requireOwnerFor?: unknown;
  author?: unknown;
}
/** `cap: null` restores the default. */
export interface ParallelismCapBody {
  cap: number | null;
  author?: unknown;
}
export interface AttachDocBody {
  docId: string;
}
/** Checked whole by `parseGithubSubscriptions`. */
export interface GithubSubscriptionsBody {
  subscriptions: unknown;
}
/** Checked whole by `parseBoardEmbeds`. */
export interface BoardEmbedsBody {
  embeds: unknown;
}
/** `takeover` displaces a live lead; without it a held seat is declined. */
export interface SetLeadBody {
  leadAgentId: string;
  author?: unknown;
  takeover?: boolean;
}
export type BoardReadQuery = { format: 'json' };
export type RelatedWorkQuery = { q: string; docId?: string; limit?: string };

/** A visitor is told who moved the cap without the actor's id. */
type Actor = { id?: string; name: string; kind?: string };
type CapChange = { actor: Actor; ts: number; from: number; to: number };
type RetiredNotice = { since: number; reason?: string; notice: string };

export interface RetiredAnswer {
  changed: boolean;
  workspace: { name: string; retiredAt?: number };
}
export interface RenameBoardAnswer {
  changed: boolean;
  workspace: { name: string };
  /** Live boards that already had the name the rename landed on. */
  sameName?: Array<{ workspaceId: string; name: string }>;
}
export interface BoardSettingsAnswer {
  reviewItemCriteria: {
    value: string;
    isDefault: boolean;
    default: string;
    writtenBeforeMarkdown?: true;
  };
}
export interface ParallelismCapAnswer {
  cap: number;
  isDefault: boolean;
  default: number;
  inUse: number;
  free: number;
  holders: Array<{ taskId: string; title?: string; agentName?: string }>;
  lastChange?: CapChange;
}
export interface AttachDocAnswer {
  workspace: { docIds: string[] } | undefined;
  url?: string;
}
export interface BoardReadAnswer {
  workspace: { id: string; name: string; leadAgentId?: string; reviewItemCriteria?: string };
  goalSummary: unknown[];
  parallelismCap?: {
    value: number;
    isDefault: boolean;
    inUse: number;
    free: number;
    lastChange?: CapChange;
  };
  retired?: RetiredNotice;
}
export type SetLeadAnswer = Extract<SetLeadAgentResult, { ok: true }>;
export interface RelatedWorkAnswer {
  considered: number;
  matches: unknown[];
}

const BOARD = '/workspaces/:ws';

export const workspaceBoardContract = new Hono()
  .get(BOARD, query<BoardReadQuery>(), answers<BoardReadAnswer>())
  .put(`${BOARD}/retired`, json<RetiredBody>(), answers<RetiredAnswer>())
  .post(`${BOARD}/rename`, json<RenameBoardBody>(), answers<RenameBoardAnswer>())
  .put(`${BOARD}/settings`, json<BoardSettingsBody>(), answers<BoardSettingsAnswer>())
  .put(`${BOARD}/parallelism-cap`, json<ParallelismCapBody>(), answers<ParallelismCapAnswer>())
  .post(`${BOARD}/docs:attach`, json<AttachDocBody>(), answers<AttachDocAnswer>())
  .get(`${BOARD}/related-work`, query<RelatedWorkQuery>(), answers<RelatedWorkAnswer>())
  .put(`${BOARD}/github-subscriptions`, json<GithubSubscriptionsBody>(), contractOnly)
  .put(`${BOARD}/embeds`, json<BoardEmbedsBody>(), contractOnly)
  .put(`${BOARD}/lead`, json<SetLeadBody>(), answers<SetLeadAnswer>());

export type WorkspaceBoardContract = typeof workspaceBoardContract;
