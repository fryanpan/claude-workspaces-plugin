/**
 * How long a blocking ask waited for its answer: recorded on the answer, and
 * rolled up into the one line the daily health check reads off
 * `/api/metrics`.
 *
 * The rollup is driven with an injected clock; the recording is driven
 * through the real server — file one blocking ask and one ordinary one,
 * answer both, and only the blocking one is counted. Fixtures are invented.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload } from '@claude-workspaces/core';
import {
  type AnswerRecord,
  BLOCKING_WAIT_WINDOW_MS,
  ReviewAnswerLedger,
  blockingWait,
} from '../src/review-answer-ledger.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const rec = (over: Partial<AnswerRecord>): AnswerRecord => ({
  workspaceId: 'w-riverbend',
  key: 'k',
  askedAt: NOW - HOUR,
  visibleAt: NOW - HOUR,
  answeredAt: NOW,
  size: 'easy',
  minutes: 1,
  rankAtAnswer: 1,
  higherOpen: { easy: 0, medium: 0, hard: 0 },
  projectRank: 1,
  ...over,
});

describe('the blocking-wait rollup', () => {
  it('counts only blocking answers inside the window, and reports their waits', () => {
    const records = [
      rec({ blocking: true, visibleAt: NOW - 1 * HOUR }),
      rec({ blocking: true, visibleAt: NOW - 3 * HOUR }),
      rec({ blocking: true, visibleAt: NOW - 30 * HOUR }),
      // Not blocking: the ordinary wait is a different number.
      rec({ visibleAt: NOW - 90 * HOUR }),
      // Blocking, but answered before the window opened.
      rec({ blocking: true, answeredAt: NOW - BLOCKING_WAIT_WINDOW_MS - 1, visibleAt: 0 }),
    ];
    expect(blockingWait(records, NOW)).toEqual({
      windowMs: BLOCKING_WAIT_WINDOW_MS,
      answered: 3,
      medianWaitMs: 3 * HOUR,
      p90WaitMs: 30 * HOUR,
      maxWaitMs: 30 * HOUR,
    });
  });

  it('reads zero answers as zero, not as a missing field', () => {
    expect(blockingWait([], NOW)).toEqual({
      windowMs: BLOCKING_WAIT_WINDOW_MS,
      answered: 0,
      medianWaitMs: 0,
      p90WaitMs: 0,
      maxWaitMs: 0,
    });
  });
});

const AGENT = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };
/** Alice, signed in on the board page: replaced with the signed identity at boot. */
let PERSON: { id: string; name: string; kind?: string; color?: string } = { id: '', name: 'Alice' };
/** The proof headers each signed-in person sends, keyed by author id. */
const PROOF = new Map<string, Record<string, string>>();
const proofFor = (body: unknown): Record<string, string> =>
  PROOF.get((body as { author?: { id?: string } } | undefined)?.author?.id ?? '') ?? {};
const CHOICE: ReviewPayload = {
  shape: 'decision',
  headline: 'Small Saltmarsh set by Friday, or the full set on Monday?',
  options: [
    { id: 'small', label: 'Small set Friday' },
    { id: 'full', label: 'Full set Monday' },
  ],
};

describe('through the real server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'blocking-wait-'));
    handle = createServer({ port: 0, dataDir, spawnerAgentId: null });
    base = `http://127.0.0.1:${handle.port}`;
    const personSigned = signedInPerson(handle, dataDir, base, {
      email: 'alice@harborlight.example',
      name: 'Alice',
    });
    PERSON = personSigned.user;
    PROOF.set(personSigned.user.id, personSigned.headers);
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...proofFor(body) },
      body: JSON.stringify(body),
    });
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as Record<string, unknown>;
  };

  it('marks the blocking answer in the ledger and counts it in /api/metrics', async () => {
    const ws = (
      (await post('/workspaces', { name: 'Saltmarsh', author: AGENT })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const file = async (title: string, review: ReviewPayload) => {
      const { task } = (await post(`/workspaces/${ws}/tasks`, {
        title,
        body: 'Alice can see the Saltmarsh numbers so that she can pick a release.',
        author: AGENT,
      })) as { task: { id: string } };
      const { item } = (await post(`/workspaces/${ws}/tasks/${task.id}/review-items`, {
        review,
        author: AGENT,
      })) as { item: { id: string } };
      return { taskId: task.id, itemId: item.id };
    };
    const blocking = await file('Re-run the Saltmarsh benchmark', {
      ...CHOICE,
      blocks: { what: 'the Saltmarsh benchmark re-run' },
    });
    const ordinary = await file('Saltmarsh chart colours', CHOICE);
    for (const it of [blocking, ordinary]) {
      await post(`/workspaces/${ws}/tasks/${it.taskId}/review-items/${it.itemId}/answer`, {
        text: 'Small set.',
        answeredWith: 'small',
        author: PERSON,
      });
    }
    const ledger = new ReviewAnswerLedger(dataDir);
    const records = await waitFor(() => {
      const all = ledger.read();
      return all.length === 2 ? all : undefined;
    });
    const byTask = new Map(records.map((r) => [r.key.split(':')[1], r]));
    expect(byTask.get(blocking.taskId)?.blocking).toBe(true);
    expect(byTask.get(ordinary.taskId)?.blocking).toBeUndefined();

    const metrics = (await (await fetch(`${base}/api/metrics`)).json()) as {
      blockingWait?: { answered: number; windowMs: number };
    };
    expect(metrics.blockingWait?.answered).toBe(1);
    expect(metrics.blockingWait?.windowMs).toBe(BLOCKING_WAIT_WINDOW_MS);
  });
});
