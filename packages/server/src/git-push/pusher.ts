/**
 * A lead's push, from the bundle it sent to the ref on GitHub.
 *
 * Each push is judged twice when it waits for approval: once when it is
 * asked for, so a person is only ever asked about a push that would land,
 * and again when they answer, because the list, upstream or the branch may
 * have moved in between. Judging means, in order:
 *
 *  1. the repo is on the board's list (`policy.ts`);
 *  2. the host has a credential (`credential.ts`);
 *  3. upstream names a default branch, and the branch is not it;
 *  4. the bundle carries exactly one ref, `refs/heads/<branch>`;
 *  5. every commit it builds on came from upstream (`run.ts`);
 *  6. its tip descends from upstream's tip of the branch, so it is never a
 *     force-push.
 *
 * On a repo marked `approval`, the push is then held as a decision review
 * item with `step: 'push'` (owner-only when the board reserves that step),
 * at most `MAX_HELD_PER_BOARD` at a time. It runs only when the item's
 * answer chose Push AND carries `answeredBy`, which the store writes for a
 * person and never for an agent (`review-items/approver.ts`), so the lead
 * cannot approve its own push. An agent's answer is taken back: the push stays
 * held for a person.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyActor } from '../actor-identity.ts';
import type { TaskStore } from '../tasks.ts';
import type { PushCredential } from './credential.ts';
import { type GitRunner, realGit } from './git.ts';
import { ruleFor } from './policy.ts';
import { type RunResult, runPush } from './run.ts';

export const PUSH_APPROVE = 'o-push';
export const PUSH_REJECT = 'o-no-push';

/** Who files the approval item: the server, on the lead's behalf. */
export const GIT_PUSH_ACTOR = {
  id: 'agent-workspaces-server',
  name: 'Claude Workspaces',
  kind: 'agent',
};

export type PushState =
  | 'pushed'
  | 'up-to-date'
  | 'awaiting-approval'
  | 'rejected'
  | 'refused'
  | 'failed';

export interface PushRecord {
  id: string;
  boardId: string;
  repo: string;
  branch: string;
  state: PushState;
  /** Why it was refused or failed, in words a lead can act on. No credential. */
  error?: string;
  message?: string;
  sha?: string;
  taskId?: string;
  reviewItemId?: string;
  requestedBy: string;
  at: number;
  updatedAt: number;
}

export interface PushOutcome {
  status: number;
  record: PushRecord;
}

export interface GitPusherOptions {
  dataDir: string;
  taskStore: TaskStore;
  credential: PushCredential;
  /** What a person may do on a board, or null for a non-member (`FeatureDeps`). */
  personRoleOn: (
    boardId: string,
    person: { id: string; email?: string },
  ) => 'owner' | 'member' | null;
  /** Upstream's URL for `owner/name`. Tests point it at a local bare repo. */
  remoteUrlFor?: (repo: string) => string;
  runGit?: GitRunner;
  now?: () => number;
}

const MAX_RECORDS = 500;
/** Pushes one board may have waiting for a person at once. */
export const MAX_HELD_PER_BOARD = 5;

export class GitPusher {
  private readonly root: string;
  private readonly records = new Map<string, PushRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly remoteUrlFor: (repo: string) => string;
  private readonly runGit: GitRunner;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;
  /** Held pushes whose answer is being acted on, so a second event waits. */
  private readonly answering = new Set<string>();

  constructor(private readonly o: GitPusherOptions) {
    this.root = join(o.dataDir, 'git-push');
    mkdirSync(join(this.root, 'bundles'), { recursive: true, mode: 0o700 });
    this.remoteUrlFor = o.remoteUrlFor ?? ((repo) => `https://github.com/${repo}.git`);
    this.runGit = o.runGit ?? realGit;
    this.now = o.now ?? Date.now;
    this.load();
    this.unsubscribe = o.taskStore.onEvent((e) => {
      if (e.type !== 'decision.answered' || !e.reviewItemId) return;
      const held = [...this.records.values()].find(
        (r) => r.state === 'awaiting-approval' && r.reviewItemId === e.reviewItemId,
      );
      if (held && !this.answering.has(held.id)) {
        this.answering.add(held.id);
        void this.answered(held).finally(() => this.answering.delete(held.id));
      }
    });
  }

  stop(): void {
    this.unsubscribe();
  }

  /** Where the route writes an incoming bundle before calling `submit`. */
  bundlePath(id: string): string {
    return join(this.root, 'bundles', `${id}.bundle`);
  }

  get(boardId: string, id: string): PushRecord | null {
    const r = this.records.get(id);
    return r && r.boardId === boardId ? r : null;
  }

  async submit(input: {
    id: string;
    boardId: string;
    repo: string;
    branch: string;
    taskId?: string;
    requestedBy: string;
  }): Promise<PushOutcome> {
    const at = this.now();
    const record: PushRecord = {
      id: input.id,
      boardId: input.boardId,
      repo: input.repo,
      branch: input.branch,
      state: 'refused',
      requestedBy: input.requestedBy,
      at,
      updatedAt: at,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    const rule = ruleFor(this.o.dataDir, input.boardId, input.repo);
    if (!rule) {
      return this.finish(
        record,
        403,
        'repo-not-listed',
        `${input.repo} is not on this board's push list`,
      );
    }
    if (rule.approval) {
      const task = input.taskId ? this.o.taskStore.getTask(input.taskId) : undefined;
      if (!task || task.workspaceId !== input.boardId) {
        return this.finish(
          record,
          400,
          'task-required',
          `pushes to ${input.repo} wait for a person's approval; name a task on this board with ?task=<taskId>`,
        );
      }
    }
    if (rule.approval && this.heldOn(input.boardId) >= MAX_HELD_PER_BOARD) {
      return this.finish(
        record,
        429,
        'too-many-held',
        `this board already has ${MAX_HELD_PER_BOARD} pushes waiting for a person; wait for an answer first`,
      );
    }
    const judged = await this.run(record, !rule.approval);
    if (!judged.ok) return this.refuse(record, judged);
    record.sha = judged.sha;
    if (judged.upToDate) {
      record.state = 'up-to-date';
      record.message = `${input.branch} is already at ${judged.sha.slice(0, 12)}`;
      return this.done(record, 200);
    }
    if (rule.approval) return this.hold(record, judged);
    return this.pushed(record, judged.sha);
  }

  /** Judge, and push when `push` is set, under the repo's lock. */
  private run(record: PushRecord, push: boolean): Promise<RunResult> {
    return this.locked(record.repo, () =>
      runPush(
        {
          root: this.root,
          credential: this.o.credential,
          remoteUrlFor: this.remoteUrlFor,
          runGit: this.runGit,
        },
        {
          id: record.id,
          repo: record.repo,
          branch: record.branch,
          bundle: this.bundlePath(record.id),
        },
        push,
      ),
    );
  }

  private refuse(record: PushRecord, r: Extract<RunResult, { ok: false }>): PushOutcome {
    const state: PushState = r.error === 'push-failed' ? 'failed' : 'refused';
    return this.finish(record, r.status, r.error, r.message, state);
  }

  private pushed(record: PushRecord, sha: string): PushOutcome {
    record.state = 'pushed';
    record.message = `pushed ${sha.slice(0, 12)} to ${record.repo} ${record.branch}`;
    record.error = undefined;
    return this.done(record, 200);
  }

  private heldOn(boardId: string): number {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.boardId === boardId && r.state === 'awaiting-approval') n++;
    }
    return n;
  }

  private hold(record: PushRecord, judged: Extract<RunResult, { ok: true }>): PushOutcome {
    const taskId = record.taskId ?? '';
    // The lead wrote these subjects. In a fenced block they render as text,
    // and every line starts with `- `, so none can close the fence.
    const commits = judged.subjects.length
      ? `Newest commits:\n\n\`\`\`text\n${judged.subjects.map((s) => `- ${oneLine(s)}`).join('\n')}\n\`\`\``
      : '';
    const res = this.o.taskStore.addReviewItem(
      taskId,
      {
        review_type: 'decision',
        headline: `Push ${record.branch} to ${record.repo}?`,
        detail: [
          `\`${record.requestedBy}\` asks this server to push \`${record.branch}\` to \`${record.repo}\` at \`${judged.sha.slice(0, 12)}\`, ${judged.tip ? `on top of \`${judged.tip.slice(0, 12)}\`` : 'as a new branch'}.`,
          commits,
          'Only a person’s Push sends it. An agent’s answer sends nothing.',
        ]
          .filter(Boolean)
          .join('\n\n'),
        options: [
          { id: PUSH_APPROVE, label: 'Push', detail: 'The server pushes this branch now' },
          { id: PUSH_REJECT, label: 'Don’t push', detail: 'Nothing is sent, and the lead is told' },
        ],
        step: 'push',
      },
      { actor: { ...GIT_PUSH_ACTOR } },
    );
    if (!res.ok) {
      return this.finish(
        record,
        400,
        'approval-unfiled',
        `could not file the approval item: ${res.error}`,
      );
    }
    record.state = 'awaiting-approval';
    record.reviewItemId = res.item.id;
    record.message = `waiting for a person to answer the review item on task ${taskId}`;
    record.error = undefined;
    this.records.set(record.id, record);
    this.save();
    return { status: 202, record };
  }

  /** The held push's item was answered: push only on a person's Push. */
  private async answered(record: PushRecord): Promise<void> {
    const item = this.o.taskStore
      .listReviewItems(record.taskId ?? '')
      .find((r) => r.id === record.reviewItemId);
    const answer = item?.answer;
    if (!answer) return;
    // An agent's answer, either way, is not a decision. The store lets only
    // the answerer change an answer, so it is taken back in that answerer's
    // name (it stays in `priorAnswers`): the item is open again and the push
    // stays held for a person.
    if (!this.byPerson(answer.answeredBy)) {
      this.o.taskStore.undoTaskReviewAnswer(record.taskId ?? '', record.reviewItemId ?? '', {
        actor: { id: GIT_PUSH_ACTOR.id, name: answer.by, kind: 'agent' },
      });
      this.o.taskStore.appendNote(record.taskId ?? '', {
        kind: 'status',
        text: `Push ${record.branch} to ${record.repo}: ${answer.by} answered for an agent, so nothing was sent; it waits for a person.`,
        agent: GIT_PUSH_ACTOR.name,
        ts: this.now(),
      });
      return;
    }
    if (answer.answeredWith === PUSH_REJECT) {
      this.finish(record, 200, 'rejected', `${answer.by} chose not to push`, 'rejected');
      this.note(record);
      return;
    }
    const refusal = this.approvalRefusal(record, answer);
    if (refusal) {
      this.finish(record, 403, 'not-approved', `${refusal}; nothing was sent — ask again`);
      this.note(record);
      return;
    }
    record.updatedAt = this.now();
    const judged = await this.run(record, true);
    if (!judged.ok) this.refuse(record, judged);
    else if (judged.upToDate) {
      record.state = 'up-to-date';
      this.done(record, 200);
    } else this.pushed(record, judged.sha);
    this.note(record);
  }

  /**
   * Why this answer does not approve the push, or null when it does. It must
   * choose Push, carry `answeredBy` (written only for a person proved by
   * their own sign-in), name no agent id, and come from a human member of
   * the push's board — its owner when the board reserves the `push` step.
   */
  private approvalRefusal(
    record: PushRecord,
    answer: { answeredWith?: string; answeredBy?: { id: string; email?: string } },
  ): string | null {
    if (answer.answeredWith !== PUSH_APPROVE) return 'the answer did not choose Push';
    const who = answer.answeredBy;
    if (!who || !this.byPerson(who)) return 'the item was answered by an agent, not a person';
    const role = this.o.personRoleOn(record.boardId, who);
    if (role === null) return 'the person who answered is not a member of this board';
    if (role !== 'owner' && this.o.taskStore.requireOwnerFor(record.boardId).includes('push')) {
      return "this board reserves pushes for its owner's approval";
    }
    return null;
  }

  /** `answeredBy` is written only for a proven person; an agent id never counts. */
  private byPerson(who: { id: string } | undefined): who is { id: string; email?: string } {
    return !!who && classifyActor({ id: who.id, kind: 'person' }) === 'person';
  }

  private note(record: PushRecord): void {
    if (!record.taskId) return;
    this.o.taskStore.appendNote(record.taskId, {
      kind: 'status',
      text: `Push ${record.branch} to ${record.repo}: ${record.state}. ${record.message ?? ''}`.trim(),
      agent: GIT_PUSH_ACTOR.name,
      ts: this.now(),
    });
  }

  private finish(
    record: PushRecord,
    status: number,
    error: string,
    message: string,
    state: PushState = 'refused',
  ): PushOutcome {
    record.state = state;
    if (state !== 'rejected') record.error = error;
    record.message = message;
    return this.done(record, status);
  }

  /** A push that is over: its bundle goes (transient, so a hard delete). */
  private done(record: PushRecord, status: number): PushOutcome {
    record.updatedAt = this.now();
    rmSync(this.bundlePath(record.id), { force: true });
    this.records.set(record.id, record);
    this.save();
    return { status, record };
  }

  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private get file(): string {
    return join(this.root, 'pushes.json');
  }

  private load(): void {
    try {
      const rows = JSON.parse(readFileSync(this.file, 'utf8')) as PushRecord[];
      if (Array.isArray(rows)) for (const r of rows) if (r?.id) this.records.set(r.id, r);
    } catch {}
  }

  private save(): void {
    const all = [...this.records.values()].sort((a, b) => a.at - b.at);
    // A record pruned off the end takes its bundle with it, held or not.
    for (const old of all.slice(0, Math.max(0, all.length - MAX_RECORDS))) {
      rmSync(this.bundlePath(old.id), { force: true });
      this.records.delete(old.id);
    }
    const rows = all.slice(-MAX_RECORDS);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function oneLine(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: commit subjects come from the lead
  return s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, 120);
}
