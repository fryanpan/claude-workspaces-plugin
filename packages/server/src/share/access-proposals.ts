/**
 * ACCESS PROPOSALS: an agent's share call that would let somebody new in
 * files one of these instead of changing anything, and only the owner's
 * Approve in the browser applies it (Bryan, 29 Oct: only he changes who is
 * in).
 *
 * What counts as letting somebody new in: an address or `@domain` the board's
 * audience does not already admit, a promotion to Owner, or a link that makes
 * its redeemers Owners. Everything that narrows — a removal, a demotion, a
 * link for people the board already names — still applies at once, because
 * taking access away must never wait on a person.
 *
 * A proposal is an `access` review item on a task the agent names, so it
 * sits on Bryan's queue beside the work that wanted it. Its words come from
 * the change (`accessChangeLine`); the change is on the item's wrapper, where
 * no caller's payload reaches; and the door that applies it
 * (`routes/task-access.ts`) re-reads it and requires the browser to echo it
 * exactly.
 *
 * `apply` re-checks what may have changed since filing — the board's lock,
 * the member still being in — because an approval is for the change as it
 * would land now, not as it would have landed then.
 */
import { type TaskReviewItem, type User, agentIdForName, agentSlug } from '@claude-workspaces/core';
import {
  ACCESS_LABEL_MAX,
  type ReviewAccessChange,
  accessChangeLine,
  readAccessChange,
} from '@claude-workspaces/core/review-access';
import type { Task } from '@claude-workspaces/core/task-wire';
import { taskDeepLink } from '../home-brief.ts';
import { ACCESS_APPROVE } from '../review-items/owner-steps.ts';
import type { TaskStore } from '../tasks.ts';
import { entriesWidenAudience } from './board-audience.ts';
import { parseShareLanding } from './share-landing.ts';
import { type ShareLinks, shareLinkUrl } from './share-links.ts';

/** Longest `why` a proposal carries; the card's detail. */
export const ACCESS_WHY_MAX = 600;

export interface AccessProposalDeps {
  taskStore: TaskStore;
  shareLinks: ShareLinks;
  /** The share hostname links are minted on; empty when none is set. */
  shareLinkBaseHost: string;
  isBoardLocked: (workspaceId: string) => boolean;
  /** Reopen one board, or clear its lock, when the owner approves it. Absent
   *  where the server has no sharing gate; the change is then refused. */
  setBoardEnabled?: (workspaceId: string) => { ok: boolean; error?: string };
  setBoardUnlocked?: (workspaceId: string) => { ok: boolean; error?: string };
  /** Turn the master switch back on, logged with the approver as the actor:
   *  the sharing notice's card. Absent where there is no sharing gate. */
  setSharingOn?: (by: string) => { ok: boolean; error?: string };
  /** Re-project the task and tell the queue, as the review-item route does. */
  announce: (task: Task, item: TaskReviewItem, author: User) => void;
  /** Told after a proposal is filed or answered, for the access page. */
  onChanged?: () => void;
}

export type ProposeResult =
  | { ok: true; taskId: string; reviewItemId: string; url: string; line: string }
  | {
      ok: false;
      status: 400 | 404;
      error: 'task-required' | 'task-not-on-board' | 'why-required' | 'label-too-long';
      message: string;
    };

export type ApplyResult =
  | { ok: true; text: string; url?: string }
  | { ok: false; error: string; message: string };

/** One open or answered proposal, as the access page shows it. */
export interface AccessProposalRow {
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  reviewItemId: string;
  change: ReviewAccessChange;
  line: string;
  why: string;
  proposedBy: string;
  proposedAt: number;
  answer?: { text: string; by: string; ts: number; approved: boolean };
}

export class AccessProposals {
  constructor(private readonly deps: AccessProposalDeps) {}

  /** The entries in `entries` the board does not already admit. */
  widening(workspaceId: string, entries: readonly string[]): string[] {
    return entriesWidenAudience(this.deps.shareLinks.audienceOf(workspaceId), entries);
  }

  propose(input: {
    change: ReviewAccessChange;
    taskId: unknown;
    why: unknown;
    actor: User;
  }): ProposeResult {
    const { change } = input;
    const verb = accessChangeLine(change);
    if (typeof input.taskId !== 'string' || input.taskId === '') {
      return {
        ok: false,
        status: 400,
        error: 'task-required',
        message: `This needs the owner's approval: ${verb} Pass taskId (the task that needs it) and why, and an approval card is filed on that task.`,
      };
    }
    const task = this.deps.taskStore.getTask(input.taskId);
    if (!task || task.workspaceId !== change.workspaceId) {
      return {
        ok: false,
        status: 404,
        error: 'task-not-on-board',
        message: 'taskId must name a task on the board being shared',
      };
    }
    if (change.op === 'share-link' && (change.link.label?.length ?? 0) > ACCESS_LABEL_MAX) {
      return {
        ok: false,
        status: 400,
        error: 'label-too-long',
        message: `label must be ${ACCESS_LABEL_MAX} characters or fewer; the owner reads it on the card`,
      };
    }
    const why = typeof input.why === 'string' ? input.why.trim() : '';
    if (why === '' || why.length > ACCESS_WHY_MAX) {
      return {
        ok: false,
        status: 400,
        error: 'why-required',
        message: `why must say, in ${ACCESS_WHY_MAX} characters or fewer, what the access is for`,
      };
    }
    const res = this.deps.taskStore.addAccessReviewItem(task.id, change, why, {
      actor: input.actor,
    });
    if (!res.ok) {
      return {
        ok: false,
        status: 400,
        error: 'why-required',
        message: res.message ?? res.error,
      };
    }
    this.deps.announce(res.task, res.item, input.actor);
    this.deps.onChanged?.();
    return {
      ok: true,
      taskId: task.id,
      reviewItemId: res.item.id,
      url: taskDeepLink(task.workspaceId, task.id),
      line: verb,
    };
  }

  /** Tell the access page a proposal was answered. */
  changed(): void {
    this.deps.onChanged?.();
  }

  /** Make the approved change, as it would land now. */
  apply(change: ReviewAccessChange, by: string): ApplyResult {
    const { shareLinks } = this.deps;
    const ws = change.workspaceId;
    if (change.op === 'sharing-on') {
      const res = this.deps.setSharingOn?.(by) ?? { ok: false, error: 'no_sharing_gate' };
      if (!res.ok) {
        return {
          ok: false,
          error: res.error ?? 'refused',
          message:
            'sharing is fixed in the environment (CW_SHARING_DISABLED), so it cannot be turned back on here',
        };
      }
      return { ok: true, text: `Approved. ${accessChangeLine(change)}` };
    }
    if (change.op === 'unlock-board' || change.op === 'open-board') {
      if (change.op === 'open-board' && this.deps.isBoardLocked(ws)) {
        return {
          ok: false,
          error: 'board-locked',
          message: 'this board is locked against sharing; unlock it first',
        };
      }
      const set =
        change.op === 'open-board' ? this.deps.setBoardEnabled : this.deps.setBoardUnlocked;
      const res = set?.(ws) ?? { ok: false, error: 'no_sharing_gate' };
      if (!res.ok) {
        return {
          ok: false,
          error: res.error ?? 'refused',
          message:
            'sharing is fixed in the environment (CW_SHARING_DISABLED), so this board cannot change',
        };
      }
      return { ok: true, text: `Approved. ${accessChangeLine(change)}` };
    }
    if (change.op !== 'set-role' && this.deps.isBoardLocked(ws)) {
      return {
        ok: false,
        error: 'board-locked',
        message: 'this board is locked against sharing; unlock it first',
      };
    }
    switch (change.op) {
      case 'add-audience': {
        const before = JSON.stringify(shareLinks.audienceOf(ws)?.entries ?? []);
        const after = JSON.stringify(shareLinks.addToAudience(ws, change.entries, by).entries);
        return {
          ok: true,
          text:
            before === after
              ? 'Approved. Nothing changed: the board already lets them sign in.'
              : `Approved. ${accessChangeLine(change)}`,
        };
      }
      case 'set-role': {
        if (shareLinks.roleOf(ws, change.email) === null) {
          return {
            ok: false,
            error: 'not-a-member',
            message: `${change.email} is no longer on this board`,
          };
        }
        shareLinks.setMemberRole(ws, change.email, change.role);
        return { ok: true, text: `Approved. ${accessChangeLine(change)}` };
      }
      case 'share-link': {
        if (!this.deps.shareLinkBaseHost) {
          return {
            ok: false,
            error: 'share_hostname_not_configured',
            message: 'this server has no share hostname, so no link can be minted',
          };
        }
        const landing = parseShareLanding(change.link.landing);
        if (!landing.ok) return { ok: false, error: 'bad_landing', message: landing.error };
        if (change.entries.length > 0) shareLinks.addToAudience(ws, change.entries, by);
        const link = shareLinks.create({
          workspaceId: ws,
          createdBy: by,
          ...(change.link.ttlSeconds !== undefined ? { ttlSeconds: change.link.ttlSeconds } : {}),
          ...(change.link.label ? { label: change.link.label } : {}),
          ...(change.link.role ? { role: change.link.role } : {}),
          ...(landing.landing ? { landing: landing.landing } : {}),
          ...(change.link.allowDomains ? { allowDomains: change.link.allowDomains } : {}),
        });
        const url = shareLinkUrl(this.deps.shareLinkBaseHost, link.linkId);
        return { ok: true, text: `Approved. The link is ${url}`, url };
      }
    }
  }

  /** Every access proposal on these boards, open ones first, newest first. */
  rows(workspaceIds: readonly string[]): AccessProposalRow[] {
    const out: AccessProposalRow[] = [];
    for (const ws of workspaceIds) {
      for (const task of this.deps.taskStore.listTasks(ws)) {
        for (const item of this.deps.taskStore.listReviewItems(task.id)) {
          const change = readAccessChange(item.access);
          if (!change) continue;
          out.push({
            workspaceId: ws,
            taskId: task.id,
            taskTitle: task.title,
            reviewItemId: item.id,
            change,
            line: accessChangeLine(change),
            why: item.review.detail ?? '',
            proposedBy: item.createdBy,
            proposedAt: item.createdAt,
            ...(item.answer
              ? {
                  answer: {
                    text: item.answer.text,
                    by: item.answer.by,
                    ts: item.answer.ts,
                    approved: item.answer.answeredWith === ACCESS_APPROVE,
                  },
                }
              : {}),
          });
        }
      }
    }
    return out.sort(
      (a, b) =>
        Number(a.answer !== undefined) - Number(b.answer !== undefined) ||
        b.proposedAt - a.proposedAt,
    );
  }
}

/**
 * The agent a loopback share call speaks for: the name it gives, or "agent".
 * Always an AGENT, whatever name it claims: a body cannot file a card as a
 * person, and a name that is a person's is marked as an agent's on the card.
 */
export function proposingAgent(claimed: unknown): User {
  const raw =
    claimed && typeof claimed === 'object' ? (claimed as { name?: unknown }).name : claimed;
  const name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().slice(0, 80) : 'agent';
  const known = agentIdForName(name);
  const isAgentId = known.startsWith('agent-') || known === 'known-agent';
  return {
    id: isAgentId ? known : `agent-${agentSlug(name)}`,
    name: isAgentId ? name : `${name} (agent)`,
    kind: 'known',
    color: '#888888',
  };
}

/** The reply a call that became a proposal gets: 202, and what to tell the person. */
export function proposalReply(
  j: (status: number, body: unknown) => Response,
  res: ProposeResult,
): Response {
  if (!res.ok) return j(res.status, { error: res.error, message: res.message });
  return j(202, {
    proposed: true,
    taskId: res.taskId,
    reviewItemId: res.reviewItemId,
    url: res.url,
    message: `Filed for the owner's approval on the task: ${res.line} Nothing has changed yet; you are told when they answer.`,
  });
}
