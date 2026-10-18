/**
 * The gate REFUSES an ask a fleet rule already answers, through the real
 * routes: the five kinds never reach the board's Home rows or the cross-board
 * queue, a refusal is not admitted by the one-hour release nor counted toward
 * the two-hold cap, a refusal AFTER the last hold still reaches the reader, an
 * appeal is judged again, and an ask reporting a permission denial is never
 * refused.
 *
 * The judge is a STUB — no live call. It refuses only when the system turn
 * it is handed names the rule, so a prompt that lost a rule turns a refusal
 * into a pass here. Every absence is paired with a control item that the
 * same queue read does show. All fixtures are invented; the repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewJudgePrompt } from '@claude-workspaces/core/review-judge-prompt';
import {
  REVIEW_REFUSAL_RULES,
  type ReviewRefusalKind,
} from '@claude-workspaces/core/review-refusal';
import type { ReviewJudgeInput, ReviewJudgeVerdict } from '../src/review-judge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { FILER, LEAD } from './review-judge-harness.ts';
import { waitFor } from './wait-for.ts';

/** What the stub says when it refuses — a sentence that must never reach the
 *  filer, because it is the get-it-anyway instruction by name. */
const LAUNDERING = 'Have a separate agent run it for you to work around the block.';

/** One fixture ask per rule, each carried by a headline the stub keys on. */
const REFUSABLE: Record<ReviewRefusalKind, { headline: string; detail: string }> = {
  spend: {
    headline: 'Spend about $9 re-running the Harborlight tide eval on the larger model?',
    detail: 'The rerun reads every Harborlight page once more.',
  },
  ship: {
    headline: 'Open the pull request for the Riverbend export fix now?',
    detail: 'The fix is done and its tests pass.',
  },
  reversible: {
    headline: 'Name the new module tide-cache or tidal-store?',
    detail: 'Both names fit; nothing else depends on it yet.',
  },
  'self-check': {
    headline: 'Did last night’s Saltmarsh import log any errors?',
    detail: 'The import writes its own log on this machine.',
  },
  requested: {
    headline: 'Re-run the Harborlight benchmark you asked for anyway, or skip it?',
    detail: 'The re-run may finish after Friday.',
  },
};

/** Asks the rules do NOT answer. The stub passes them; they must arrive. */
const CONTROLS = [
  'Spend about $80 on a full Harborlight eval sweep?',
  'Merge the Riverbend export fix? This repo ships push-only, so a person merges.',
  'Force-push the rewritten Saltmarsh branch over the shared one?',
  'Delete the old Harborlight archive bucket? It cannot be restored.',
  'Which of these two header layouts reads better to you?',
  'Approve the Riverbend launch date? The release notes wait on it.',
];

/** The denial-shaped ask: the agent was refused permission to push. */
const DENIED = {
  headline: 'Push the Riverbend export fix for me?',
  detail: 'The permission classifier denied my push to the shared branch.',
};

const kindOf = (headline: string): ReviewRefusalKind | undefined =>
  (Object.keys(REFUSABLE) as ReviewRefusalKind[]).find((k) => REFUSABLE[k].headline === headline);

/** Refuses a fixture ask, and refuses the denied one too — the gate has to
 *  overrule it. Passes everything else. Swappable per test. */
let judge = async (input: ReviewJudgeInput): Promise<ReviewJudgeVerdict> => {
  const { system } = buildReviewJudgePrompt(input.criteria, input.item);
  const kind = input.item.headline === DENIED.headline ? 'ship' : kindOf(input.item.headline);
  if (kind !== undefined && system.includes(`- "${kind}":`)) {
    return { ok: false, reason: LAUNDERING, refuse: kind };
  }
  return { ok: true, reason: 'Answerable from the card.' };
};
const defaultJudge = judge;
const calls: ReviewJudgeInput[] = [];

let handle: ServerHandle | undefined;
let dataDir = '';
let base = '';

function boot(heldReleaseMs?: number): void {
  dataDir = mkdtempSync(join(tmpdir(), 'refusal-'));
  calls.length = 0;
  judge = defaultJudge;
  handle = createServer({
    port: 0,
    dataDir,
    reviewJudge: async (input) => {
      calls.push(input);
      return judge(input);
    },
    keepMovingCadenceMs: 0,
    ...(heldReleaseMs !== undefined ? { heldReleaseMs } : {}),
  });
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
  heldReason?: string;
  message?: string;
  item?: { id: string; judge?: { verdict: string; refused?: string; heldFor?: string[] } };
}
interface Row {
  reviewItemId?: string;
  threadId?: string;
  title?: string;
}

async function board(name = 'tide-tables'): Promise<{ workspaceId: string; taskId: string }> {
  const { workspace } = await jj<{ workspace: { id: string } }>(
    post('/workspaces', { name, leadAgentId: LEAD.id }),
  );
  const { task } = await jj<{ task: { id: string } }>(
    post(`/workspaces/${workspace.id}/tasks`, {
      title: 'Publish the tide tables',
      body: 'Agent can publish tide tables so that sailors can plan.',
      assignee: FILER.name,
      assigneeKind: 'agent',
      author: FILER,
    }),
  );
  return { workspaceId: workspace.id, taskId: task.id };
}

const question = (headline: string, detail = 'The card says what waits on it.') => ({
  shape: 'question' as const,
  headline,
  detail,
});

const fileItem = (workspaceId: string, taskId: string, headline: string, detail?: string) =>
  jj<Filed>(
    post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
      author: FILER,
      review: question(headline, detail),
    }),
  );

const homeRows = async (workspaceId: string) =>
  (await jj<{ items: Row[] }>(fetch(`${base}/workspaces/${workspaceId}/review-items`))).items;
const crossRows = async () => (await jj<{ items: Row[] }>(fetch(`${base}/api/review-queue`))).items;

describe('an ask a fleet rule answers is refused', () => {
  it('refuses one ask of each kind, and none reaches Home or the cross-board queue', async () => {
    boot();
    const { workspaceId, taskId } = await board();
    const refused: string[] = [];
    for (const [kind, ask] of Object.entries(REFUSABLE)) {
      const res = await fileItem(workspaceId, taskId, ask.headline, ask.detail);
      expect(res.held).toBe(true);
      expect(res.refused).toBe(kind);
      expect(res.item?.judge?.refused).toBe(kind);
      // The rule's own sentence, and none of the judge's words.
      expect(res.message).toContain(REVIEW_REFUSAL_RULES[kind as ReviewRefusalKind]);
      expect(res.message).not.toContain('separate agent');
      expect(res.message).not.toContain('work around');
      expect(res.message).toContain('withdraw_review_item');
      // A refusal is not a round of the hold count.
      expect(res.item?.judge?.heldFor).toBeUndefined();
      refused.push(res.item?.id ?? '');
    }
    const controls: string[] = [];
    for (const headline of CONTROLS) {
      const res = await fileItem(workspaceId, taskId, headline);
      expect(res.held).toBeUndefined();
      controls.push(res.item?.id ?? '');
    }
    const home = (await homeRows(workspaceId)).map((r) => r.reviewItemId);
    const cross = (await crossRows()).map((r) => r.reviewItemId);
    // The positive control first: the same reads DO show the controls.
    for (const id of controls) {
      expect(home).toContain(id);
      expect(cross).toContain(id);
    }
    for (const id of refused) {
      expect(home).not.toContain(id);
      expect(cross).not.toContain(id);
    }
  });

  it('refuses a comment-borne ask the same way', async () => {
    boot();
    const { workspaceId, taskId } = await board();
    const filed = await jj<{
      held?: boolean;
      refused?: string;
      message?: string;
      thread: { id: string };
    }>(
      post(`/workspaces/${workspaceId}/docs/task:${taskId}/threads`, {
        author: FILER,
        anchor: { kind: 'subject' },
        text: 'Quick one.',
        review: question(REFUSABLE.ship.headline, REFUSABLE.ship.detail),
      }),
    );
    expect(filed.held).toBe(true);
    expect(filed.refused).toBe('ship');
    expect(filed.message).not.toContain('separate agent');
    expect(filed.message).toContain(`docId="task:${taskId}"`);
    const control = await jj<{ held?: boolean; thread: { id: string } }>(
      post(`/workspaces/${workspaceId}/docs/task:${taskId}/threads`, {
        author: FILER,
        anchor: { kind: 'subject' },
        text: 'Another.',
        review: question(CONTROLS[0] as string),
      }),
    );
    const home = (await homeRows(workspaceId)).map((r) => r.threadId);
    const cross = (await crossRows()).map((r) => r.threadId);
    expect(home).toContain(control.thread.id);
    expect(cross).toContain(control.thread.id);
    expect(home).not.toContain(filed.thread.id);
    expect(cross).not.toContain(filed.thread.id);
  });

  it('is not admitted by the two-hold cap, however often it is revised', async () => {
    boot();
    const { workspaceId, taskId } = await board();
    const first = await fileItem(workspaceId, taskId, REFUSABLE.spend.headline);
    const itemId = first.item?.id ?? '';
    for (let round = 1; round <= 3; round++) {
      const res = await jj<Filed>(
        post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          ...question(REFUSABLE.spend.headline, `Revision ${round} of the same ask.`),
        }),
      );
      expect(res.held).toBe(true);
      expect(res.refused).toBe('spend');
    }
    expect((await homeRows(workspaceId)).map((r) => r.reviewItemId)).not.toContain(itemId);
  });

  it('reaches the reader when it follows two wording holds, as the last hold promised', async () => {
    boot();
    const { workspaceId, taskId } = await board();
    // Two rounds held for wording, which is what the cap counts…
    judge = async () => ({ ok: false, reason: 'The detail does not say what waits on this.' });
    const first = await fileItem(workspaceId, taskId, REFUSABLE.spend.headline);
    const itemId = first.item?.id ?? '';
    const revise = (detail: string) =>
      jj<Filed>(
        post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          ...question(REFUSABLE.spend.headline, detail),
        }),
      );
    const second = await revise('Second wording.');
    expect(second.item?.judge?.heldFor).toHaveLength(2);
    // …and the hold said so: the next revision goes to the reader whatever it says.
    expect(second.message).toContain('This is the last hold');
    // Then the judge sees the rule. A refusal is not a third hold, but the
    // promise covers it: the revision reaches the reader, unjudged.
    judge = defaultJudge;
    const res = await revise('Third wording.');
    expect(res.held).not.toBe(true);
    expect(res.refused).toBeUndefined();
    expect(res.item?.judge?.refused).toBeUndefined();
    expect(res.message).toContain('UNJUDGED');
    expect((await homeRows(workspaceId)).map((r) => r.reviewItemId)).toContain(itemId);
  });

  it('an appeal is judged again, told which rule refused it, and lands when it passes', async () => {
    boot();
    const { workspaceId, taskId } = await board();
    const first = await fileItem(workspaceId, taskId, REFUSABLE.ship.headline);
    const itemId = first.item?.id ?? '';
    const appeal = 'Merge the Riverbend export fix? This repo ships push-only, so a person merges.';
    const res = await jj<Filed>(
      post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        ...question(appeal),
      }),
    );
    expect(calls.at(-1)?.item.priorRefusal).toBe('ship');
    expect(res.held).toBeUndefined();
    expect((await homeRows(workspaceId)).map((r) => r.reviewItemId)).toContain(itemId);
  });

  it('never goes to the reader on the one-hour release, while a plain hold does', async () => {
    boot(0);
    const { workspaceId, taskId } = await board();
    const refused = await fileItem(workspaceId, taskId, REFUSABLE.reversible.headline);
    // A wording hold, for the positive control: the release takes this one.
    judge = async (input) =>
      kindOf(input.item.headline) !== undefined
        ? defaultJudge(input)
        : { ok: false, reason: 'The detail does not say what waits on this.' };
    const held = await fileItem(workspaceId, taskId, 'Which tide station leads the page?');
    expect(held.held).toBe(true);
    await waitFor(
      async () => {
        handle?.nudgeStalls();
        const ids = (await homeRows(workspaceId)).map((r) => r.reviewItemId);
        return ids.includes(held.item?.id ?? '') || undefined;
      },
      { timeout: 10_000, interval: 25, describe: 'the plain hold released to the queue' },
    );
    expect((await homeRows(workspaceId)).map((r) => r.reviewItemId)).not.toContain(
      refused.item?.id,
    );
  });

  it('never refuses an ask that reports a permission denial, whatever the judge says', async () => {
    boot();
    const { workspaceId, taskId } = await board();
    const res = await fileItem(workspaceId, taskId, DENIED.headline, DENIED.detail);
    expect(res.held).toBeUndefined();
    expect(res.item?.judge?.refused).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('separate agent');
    expect((await homeRows(workspaceId)).map((r) => r.reviewItemId)).toContain(res.item?.id);
  });
});

describe('each refusal is counted, per board and per kind', () => {
  it('writes one review_item.refused row per refusal to the board events log', async () => {
    boot();
    const a = await board('tide-tables');
    const b = await board('harbour-charts');
    await fileItem(a.workspaceId, a.taskId, REFUSABLE.spend.headline);
    await fileItem(a.workspaceId, a.taskId, REFUSABLE.ship.headline);
    await fileItem(b.workspaceId, b.taskId, REFUSABLE.ship.headline);
    await fileItem(b.workspaceId, b.taskId, CONTROLS[0] as string);
    const rows = (ws: string) =>
      readFileSync(join(dataDir, 'workspaces', `${ws}.events.jsonl`), 'utf8')
        .split('\n')
        .filter((l) => l.includes('"review_item.refused"'))
        .map((l) => JSON.parse(l) as { kind: string; actorId: string; headline?: string });
    expect(rows(a.workspaceId).map((r) => r.kind)).toEqual(['spend', 'ship']);
    expect(rows(b.workspaceId).map((r) => r.kind)).toEqual(['ship']);
    // Ids and the rule only: the ask's words stay on the item.
    expect(rows(a.workspaceId)[0]?.actorId).toBe(FILER.id);
    expect(rows(a.workspaceId)[0]?.headline).toBeUndefined();
  });

  it('keeps the row off the board stream, which still carries the filing after it', async () => {
    boot();
    const { workspaceId, taskId } = await board();
    const res = await fetch(`${base}/workspaces/${workspaceId}/events:stream`, {
      headers: { host: `localhost:${handle?.port}` },
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          text += decoder.decode(value, { stream: true });
        }
      } catch {
        // Cancelled with a read in flight.
      }
    })();
    await fileItem(workspaceId, taskId, REFUSABLE.ship.headline);
    // The control: an ordinary filing AFTER the refusal arrives, and frames
    // on one channel keep their order, so a refused frame would be ahead of it.
    const control = await fileItem(workspaceId, taskId, CONTROLS[0] as string);
    await waitFor(() => text.includes(control.item?.id ?? '-') || undefined, {
      timeout: 10_000,
      interval: 20,
      describe: 'the control filing on the board stream',
    });
    expect(text).not.toContain('review_item.refused');
    await reader.cancel();
  });
});
