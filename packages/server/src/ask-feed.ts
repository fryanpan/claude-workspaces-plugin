/**
 * The plan lead's feed of new asks: every review item filed on any board,
 * batched, to the one agent that ranks them.
 *
 * Team Lead leads the plan board (`review-plan.ts`) and ranks each new ask
 * against the week's goals (`review-ranks.ts`), so Home follows the goals.
 * It could not do that while `review_item.added` went only to the owning
 * board's stream. Now each new ask joins a 10-minute window
 * (`held-window.ts`, the coach's mechanism), and when the window closes the
 * lead gets one addressed `workspace.new_asks` frame on the plan board. About
 * 30 asks a day comes to a few frames a day.
 *
 * Each item carries its board, its row (task or doc), its queue key, its
 * headline and when it was filed. Nothing from the detail is sent. An ask
 * that stops work also carries what it stops and that goal's title
 * (`review-blocks.ts`), so the lead ranks it knowing the cost of the wait.
 *
 * **Every board.** The lead sees every board the owner does (the owner,
 * 2026-10-23: "They should have the same visibility I do"), so a board kept
 * on this machine, locked private or with the coach turned off still sends
 * its asks here; the coach's own exclusion (`coach/exclusion.ts`) is the
 * coach's alone. Asks on the plan board itself are not sent, because
 * the lead already hears them on that board's own stream, and neither is an
 * ask the lead filed itself (code-health.md, "An agent is only woken by news
 * it can act on").
 *
 * With no lead, or a lead holding no stream, nothing is held: an addressed
 * frame is replayed to a stream that comes back, and a session that returns
 * should not read a backlog of stale asks.
 */
import type { ReviewBlocks, ThreadWebhookPayload } from '@claude-workspaces/core';
import { HeldWindow } from './held-window.ts';

/** How long a window stays open before it goes as one frame. */
export const ASK_WINDOW_MS = 10 * 60_000;

/** The most items one frame carries; the rest are counted, not sent. */
export const MAX_ASKS_PER_FRAME = 50;

/** The longest headline sent, in characters. */
export const MAX_HEADLINE = 200;

export type AskRow =
  | { kind: 'task-review'; taskId: string; reviewItemId: string }
  | {
      kind: 'task-thread' | 'goal-thread' | 'doc-thread';
      docId: string;
      threadId: string;
      taskId?: string;
    };

export interface NewAsk {
  /** The board the ask is on. */
  workspaceId: string;
  board?: string;
  row: AskRow;
  /** The queue key `rank_review_item` takes: `<workspaceId>:<row key>`. */
  key: string;
  headline: string;
  createdAt: number;
  /** Set when the ask stops work: the stopped work, and its goal's title. */
  stops?: { what: string; goal?: string };
}

/** A goal id's title, when the server knows the goal. */
export type GoalTitleOf = (goalId: string) => string | undefined;

/** `stops` for an ask, or nothing for one that stops no work. */
function stopsOf(blocks: ReviewBlocks | undefined, titleOf?: GoalTitleOf): NewAsk['stops'] {
  if (!blocks) return undefined;
  const goal = blocks.goalId ? titleOf?.(blocks.goalId) : undefined;
  return { what: blocks.what, ...(goal ? { goal } : {}) };
}

export interface AskFrame {
  event: 'workspace.new_asks';
  /** The plan board, which the frame is addressed on. */
  workspaceId: string;
  at: number;
  from: number;
  to: number;
  items: NewAsk[];
  /** Asks in the window past `MAX_ASKS_PER_FRAME`, not sent. */
  more?: number;
}

/** An ask as offered: the item, and who filed it. */
export interface OfferedAsk extends NewAsk {
  actorId: string;
}

export interface AskFeedDeps {
  /** The plan board and its lead, or null when there is no plan or no lead. */
  lead: () => { workspaceId: string; agentId: string } | null;
  /** Sends one addressed frame; answers how many of the lead's streams took it. */
  send: (workspaceId: string, agentId: string, frame: AskFrame) => number;
  /** Whether the lead is holding a stream on its board now. */
  connected: (workspaceId: string, agentId: string) => boolean;
  /** How long a window stays open (default `ASK_WINDOW_MS`). A test seam. */
  windowMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

const clip = (s: string): string =>
  s.length > MAX_HEADLINE ? `${s.slice(0, MAX_HEADLINE - 1)}…` : s;

export class AskFeed {
  private readonly window: HeldWindow<NewAsk>;

  constructor(private readonly deps: AskFeedDeps) {
    this.window = new HeldWindow<NewAsk>({
      windowMs: deps.windowMs ?? ASK_WINDOW_MS,
      close: (held, from, to) => this.close(held, from, to),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.schedule ? { schedule: deps.schedule } : {}),
    });
  }

  /** Offers one new ask. True when it was held for the next frame. */
  offer(ask: OfferedAsk): boolean {
    const lead = this.deps.lead();
    if (!lead || !this.deps.connected(lead.workspaceId, lead.agentId)) return false;
    if (ask.workspaceId === lead.workspaceId || ask.actorId === lead.agentId) return false;
    const { actorId: _actor, ...item } = ask;
    this.window.hold({ ...item, headline: clip(item.headline) });
    return true;
  }

  /** Drops a window still open, sending nothing. */
  stop(): void {
    this.window.stop();
  }

  private close(held: NewAsk[], from: number, to: number): void {
    const lead = this.deps.lead();
    if (!lead || !this.deps.connected(lead.workspaceId, lead.agentId)) return;
    const seen = new Set<string>();
    const items = held.filter((ask) => {
      if (seen.has(ask.key) || ask.workspaceId === lead.workspaceId) return false;
      seen.add(ask.key);
      return true;
    });
    if (items.length === 0) return;
    const sent = items.slice(0, MAX_ASKS_PER_FRAME);
    const more = items.length - sent.length;
    this.deps.send(lead.workspaceId, lead.agentId, {
      event: 'workspace.new_asks',
      workspaceId: lead.workspaceId,
      at: to,
      from,
      to,
      items: sent,
      ...(more > 0 ? { more } : {}),
    });
  }
}

/** A ticket's review item, from its `review_item.added` event. */
export function askFromReviewItemAdded(
  ev: {
    workspaceId: string;
    taskId: string;
    reviewItemId: string;
    headline: string;
    blocks?: ReviewBlocks;
    actor: { id: string };
    ts: number;
  },
  board: string | undefined,
  titleOf?: GoalTitleOf,
): OfferedAsk {
  const stops = stopsOf(ev.blocks, titleOf);
  return {
    workspaceId: ev.workspaceId,
    ...(board ? { board } : {}),
    row: { kind: 'task-review', taskId: ev.taskId, reviewItemId: ev.reviewItemId },
    key: `${ev.workspaceId}:task-review:${ev.taskId}:${ev.reviewItemId}`,
    headline: ev.headline,
    createdAt: ev.ts,
    ...(stops ? { stops } : {}),
    actorId: ev.actor.id,
  };
}

/** Where a doc's threads sit: one entry per board, and the kind of row. */
export interface ThreadHome {
  workspaceId: string;
  board?: string;
  kind: 'task-thread' | 'goal-thread' | 'doc-thread';
  taskId?: string;
}

/**
 * The asks a thread event filed: a new thread or a reply whose comment
 * declares a review item, once per board the doc sits on. Any other event
 * files none.
 */
export function asksFromThreadEvent(
  payload: Pick<ThreadWebhookPayload, 'event' | 'docId' | 'threadId' | 'thread' | 'comment'>,
  homes: readonly ThreadHome[],
  titleOf?: GoalTitleOf,
): OfferedAsk[] {
  if (payload.event !== 'thread.created' && payload.event !== 'thread.replied') return [];
  const id = payload.comment?.id;
  const comment = id ? payload.thread.comments.find((c) => c.id === id) : undefined;
  const headline = comment?.review?.headline;
  if (!comment || !headline) return [];
  const stops = stopsOf(comment.review?.blocks, titleOf);
  return homes.map((home) => ({
    workspaceId: home.workspaceId,
    ...(home.board ? { board: home.board } : {}),
    row: {
      kind: home.kind,
      docId: payload.docId,
      threadId: payload.threadId,
      ...(home.taskId ? { taskId: home.taskId } : {}),
    },
    key: `${home.workspaceId}:${home.kind}:${payload.docId}:${payload.threadId}`,
    headline,
    createdAt: comment.ts,
    ...(stops ? { stops } : {}),
    actorId: comment.author.id,
  }));
}
