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
 *  4. the bundle carries exactly one ref, the branch (or `HEAD`);
 *  5. every commit it builds on is on upstream's default branch or on
 *     upstream's copy of the branch;
 *  6. its tip descends from upstream's tip of the branch, so it is never a
 *     force-push.
 *
 * On a repo marked `approval`, the push is then held as a decision review
 * item with `step: 'push'` (owner-only when the board reserves that step).
 * It runs only when the item's answer chose Push AND carries `answeredBy`,
 * which the store writes for a person and never for an agent
 * (`review-items/approver.ts`), so the lead cannot approve its own push.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskStore } from '../tasks.ts';
import type { PushCredential } from './credential.ts';
import { type GitRunner, ScratchRepo, type Upstream, realGit, redact } from './git.ts';
import { ruleFor } from './policy.ts';

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
  /** Upstream's URL for `owner/name`. Tests point it at a local bare repo. */
  remoteUrlFor?: (repo: string) => string;
  runGit?: GitRunner;
  now?: () => number;
}

const MAX_RECORDS = 500;

type Judged =
  | { ok: true; sha: string; tip: string | null; subjects: string[]; upToDate: boolean }
  | { ok: false; status: number; error: string; message: string };

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
    const judged = await this.judge(record);
    if (!judged.ok) return this.finish(record, judged.status, judged.error, judged.message);
    record.sha = judged.sha;
    if (judged.upToDate) {
      record.state = 'up-to-date';
      record.message = `${input.branch} is already at ${judged.sha.slice(0, 12)}`;
      return this.done(record, 200);
    }
    if (rule.approval) return this.hold(record, judged);
    return this.pushNow(record, judged.sha);
  }

  /** Steps 2–6, under the repo's lock. */
  private judge(record: PushRecord): Promise<Judged> {
    return this.locked(record.repo, async (): Promise<Judged> => {
      const token = await this.o.credential();
      if (!token) {
        return {
          ok: false,
          status: 503,
          error: 'no-credential',
          message: 'this server holds no GitHub credential to push with',
        };
      }
      const up: Upstream = { url: this.remoteUrlFor(record.repo), token };
      const scratch = this.scratch(record.repo);
      if (!(await scratch.ensure())) {
        return {
          ok: false,
          status: 500,
          error: 'scratch',
          message: 'could not prepare a repository',
        };
      }
      const state = await scratch.upstreamState(up, record.branch);
      if ('error' in state) {
        return {
          ok: false,
          status: 502,
          error: 'upstream-unreadable',
          message: `could not read ${record.repo}: ${redact(state.error, token)}`,
        };
      }
      if (state.defaultBranch === record.branch) {
        return {
          ok: false,
          status: 403,
          error: 'default-branch',
          message: `${record.branch} is ${record.repo}'s default branch; push a feature branch and open a PR`,
        };
      }
      const bundle = this.bundlePath(record.id);
      const heads = await scratch.bundleHeads(bundle);
      const named = heads?.length === 1 ? heads[0] : undefined;
      const ref = named?.[1];
      if (!named || (ref !== `refs/heads/${record.branch}` && ref !== 'HEAD')) {
        return {
          ok: false,
          status: 400,
          error: 'bundle-heads',
          message: `the body must be a git bundle carrying one ref, refs/heads/${record.branch} or HEAD`,
        };
      }
      const fetches = [scratch.fetchUpstream(up, state.defaultBranch)];
      if (state.tip) fetches.push(scratch.fetchUpstream(up, record.branch));
      for (const r of await Promise.all(fetches)) {
        if (r.code !== 0) {
          return {
            ok: false,
            status: 502,
            error: 'upstream-unreadable',
            message: `could not fetch ${record.repo}: ${redact(r.stderr.trim().slice(-300), token)}`,
          };
        }
      }
      if (!(await scratch.bundleApplies(bundle))) {
        return {
          ok: false,
          status: 409,
          error: 'bundle-base-missing',
          message: `the bundle builds on commits ${record.repo} does not have; make it from origin/${state.defaultBranch}..${record.branch}`,
        };
      }
      if (!(await scratch.fetchBundle(bundle, ref, record.id))) {
        return {
          ok: false,
          status: 400,
          error: 'bundle-unreadable',
          message: 'could not read the bundle',
        };
      }
      const sha = named[0];
      if (state.tip === sha) return { ok: true, sha, tip: state.tip, subjects: [], upToDate: true };
      if (state.tip && !(await scratch.isAncestor(state.tip, sha))) {
        await scratch.dropIncoming(record.id);
        return {
          ok: false,
          status: 403,
          error: 'not-fast-forward',
          message: `${sha.slice(0, 12)} does not descend from ${record.repo}'s ${record.branch} at ${state.tip.slice(0, 12)}; this server never force-pushes`,
        };
      }
      const base = state.tip ?? `refs/up/${state.defaultBranch}`;
      const subjects = await scratch.subjects(base, sha, 10);
      return { ok: true, sha, tip: state.tip, subjects, upToDate: false };
    });
  }

  private async pushNow(record: PushRecord, sha: string): Promise<PushOutcome> {
    const res = await this.locked(record.repo, async () => {
      const token = await this.o.credential();
      if (!token) return { code: -1, stderr: 'no credential' };
      const r = await this.scratch(record.repo).push(
        { url: this.remoteUrlFor(record.repo), token },
        sha,
        record.branch,
      );
      await this.scratch(record.repo).dropIncoming(record.id);
      return { code: r.code, stderr: redact(r.stderr, token) };
    });
    if (res.code !== 0) {
      const why = res.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
      return this.finish(record, 502, 'push-failed', `upstream refused the push: ${why}`, 'failed');
    }
    record.state = 'pushed';
    record.message = `pushed ${sha.slice(0, 12)} to ${record.repo} ${record.branch}`;
    record.error = undefined;
    return this.done(record, 200);
  }

  private hold(record: PushRecord, judged: Extract<Judged, { ok: true }>): PushOutcome {
    const taskId = record.taskId ?? '';
    const commits = judged.subjects.map((s) => `- ${oneLine(s)}`).join('\n');
    const res = this.o.taskStore.addReviewItem(
      taskId,
      {
        review_type: 'decision',
        headline: `Push ${record.branch} to ${record.repo}?`,
        detail: [
          `${record.requestedBy} asks this server to push \`${record.branch}\` to ${record.repo} at \`${judged.sha.slice(0, 12)}\`, ${judged.tip ? `on top of \`${judged.tip.slice(0, 12)}\`` : 'as a new branch'}.`,
          commits ? `Newest commits:\n${commits}` : '',
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
    if (answer.answeredWith === PUSH_REJECT) {
      this.finish(record, 200, 'rejected', `${answer.by} chose not to push`, 'rejected');
      this.note(record);
      return;
    }
    if (answer.answeredWith !== PUSH_APPROVE || !answer.answeredBy) {
      this.finish(
        record,
        403,
        'not-approved',
        'the item was answered without a person choosing Push; nothing was sent — ask again',
      );
      this.note(record);
      return;
    }
    record.updatedAt = this.now();
    const judged = await this.judge(record);
    if (!judged.ok) this.finish(record, judged.status, judged.error, judged.message);
    else if (judged.upToDate) {
      record.state = 'up-to-date';
      this.done(record, 200);
    } else await this.pushNow(record, judged.sha);
    this.note(record);
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

  private scratch(repo: string): ScratchRepo {
    return new ScratchRepo(join(this.root, 'repos', `${repo.replace('/', '__')}.git`), this.runGit);
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
    const rows = [...this.records.values()].sort((a, b) => a.at - b.at).slice(-MAX_RECORDS);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function oneLine(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: commit subjects come from the lead
  return s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, 120);
}
