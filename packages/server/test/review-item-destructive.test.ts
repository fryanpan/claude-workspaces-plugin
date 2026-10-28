/**
 * An ask about a destructive git step always reaches the reader, through the
 * real routes, whatever the judge says.
 *
 * The replayed item is the shape of the one the gate refused on 2026-10-17: a
 * rebased PR branch that needs a force-push, refused under the "ship" rule
 * with "your ship method already carries consent". A ship method's consent
 * never covers a force-push, a history rewrite, a branch or tag deletion or a
 * hard reset, so the gate must not tell an agent that it does.
 *
 * The judge is a STUB that makes exactly that mistake: it refuses under
 * "ship" any ask that mentions a push, a merge or a pull request, provided
 * the system turn it is handed names the rule. So the assertion is on the
 * gate's own path, not on what a model would say. The control — an ordinary
 * "open the PR now?" — is still refused by the same stub. All fixtures are
 * invented; the repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewJudgePrompt } from '@claude-workspaces/core/review-judge-prompt';
import type { ReviewJudgeInput, ReviewJudgeVerdict } from '../src/review-judge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { FILER, LEAD } from './review-judge-harness.ts';

/** The replayed item: approve a force-push of a rebased PR branch. */
const FORCE_PUSH = {
  headline: 'Approve a force-push of the rebased Riverbend export branch?',
  detail:
    'I rebased fix/riverbend-export onto main to clear the merge conflict on its pull request. Updating the PR needs git push --force-with-lease, which replaces the branch the reviewers have already read.',
};

/** The other destructive steps, one ask each. */
const DESTRUCTIVE = [
  FORCE_PUSH,
  {
    headline: 'Rewrite the Harborlight branch history before the merge?',
    detail:
      'Squashing the pushed commits with filter-repo drops the fixture file from every commit.',
  },
  {
    headline: 'Delete the stale Saltmarsh release branch after the merge?',
    detail: 'git push origin --delete release/saltmarsh removes it for everyone.',
  },
  {
    headline: 'Delete the v2.3.0 tag and push it again on the fixed commit?',
    detail: 'The tag was pushed on the wrong commit before the merge.',
  },
  {
    headline: 'Hard reset the shared Riverbend branch to main and push?',
    detail: 'git reset --hard origin/main throws away the two commits nobody merged.',
  },
];

/** The control: an ask the ship rule really does answer. */
const PLAIN_SHIP = {
  headline: 'Open the pull request for the Riverbend export fix now?',
  detail: 'The fix is done and its tests pass.',
};

const judge = async (input: ReviewJudgeInput): Promise<ReviewJudgeVerdict> => {
  const { system } = buildReviewJudgePrompt(input.criteria, input.item);
  const text = `${input.item.headline} ${input.item.detail ?? ''}`;
  if (system.includes('- "ship":') && /push|merge|pull request|PR\b/i.test(text)) {
    return { ok: false, reason: '', refuse: 'ship' };
  }
  return { ok: true, reason: 'Answerable from the card.' };
};

let handle: ServerHandle | undefined;
let dataDir = '';
let base = '';

function boot(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'destructive-'));
  handle = createServer({ port: 0, dataDir, reviewJudge: judge, keepMovingCadenceMs: 0 });
  base = `http://127.0.0.1:${handle.port}`;
}

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const jj = async <T>(res: Response | Promise<Response>): Promise<T> => {
  const r = await res;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

interface Filed {
  held?: boolean;
  refused?: string;
  message?: string;
  item?: { id: string; judge?: { verdict: string; refused?: string } };
}

async function board(): Promise<{ workspaceId: string; taskId: string }> {
  const { workspace } = await jj<{ workspace: { id: string } }>(
    post('/workspaces', { name: 'export-fix', leadAgentId: LEAD.id }),
  );
  const { task } = await jj<{ task: { id: string } }>(
    post(`/workspaces/${workspace.id}/tasks`, {
      title: 'Ship the Riverbend export fix',
      body: 'Agent can ship the export fix so that sailors get whole files.',
      assignee: FILER.name,
      assigneeKind: 'agent',
      author: FILER,
    }),
  );
  return { workspaceId: workspace.id, taskId: task.id };
}

const fileItem = (workspaceId: string, taskId: string, ask: { headline: string; detail: string }) =>
  jj<Filed>(
    post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
      author: FILER,
      review: { shape: 'question', ...ask },
    }),
  );

const homeIds = async (workspaceId: string) =>
  (
    await jj<{ items: { reviewItemId?: string }[] }>(
      fetch(`${base}/workspaces/${workspaceId}/review-items`),
    )
  ).items.map((r) => r.reviewItemId);

describe('an ask about a destructive git step', () => {
  it('replays the force-push ask: it is not refused and reaches Home', async () => {
    boot();
    const { workspaceId, taskId } = await board();
    // The positive control: the same stub, on an ask the rule does answer.
    const control = await fileItem(workspaceId, taskId, PLAIN_SHIP);
    expect(control.refused).toBe('ship');
    const res = await fileItem(workspaceId, taskId, FORCE_PUSH);
    expect(res.held).toBeUndefined();
    expect(res.item?.judge?.refused).toBeUndefined();
    expect(JSON.stringify(res.item)).not.toContain('already carries consent');
    const home = await homeIds(workspaceId);
    expect(home).toContain(res.item?.id);
    expect(home).not.toContain(control.item?.id);
  });

  it('reaches Home for a history rewrite, a branch or tag deletion and a hard reset', async () => {
    boot();
    const { workspaceId, taskId } = await board();
    const ids: string[] = [];
    for (const ask of DESTRUCTIVE) {
      const res = await fileItem(workspaceId, taskId, ask);
      expect({ headline: ask.headline, refused: res.refused }).toEqual({
        headline: ask.headline,
        refused: undefined,
      });
      ids.push(res.item?.id ?? '');
    }
    const home = await homeIds(workspaceId);
    for (const id of ids) expect(home).toContain(id);
  });
});
