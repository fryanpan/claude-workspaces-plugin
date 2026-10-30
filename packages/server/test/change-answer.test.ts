/**
 * Changing an answer through the REAL routes: the person who answered can
 * take it back and pick again, or answer over it; the item holds the new pick
 * with the old one kept; the filer is told once, with the answer it replaces;
 * and nobody else — another person or an agent — can change it.
 *
 * Fixture names are the house ones.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task, TaskStoreEvent } from '../src/tasks.ts';
import { signedInPerson } from './signed-in-person.ts';

/** Alice, signed in on the board page: replaced with the signed identity at boot. */
let ALICE: { id: string; name: string; kind?: string; color?: string } = { id: '', name: 'Alice' };
/** Bob, signed in on the board page: replaced with the signed identity at boot. */
let BOB: { id: string; name: string; kind?: string; color?: string } = { id: '', name: 'Bob' };
/** The proof headers each signed-in person sends, keyed by author id. */
const PROOF = new Map<string, Record<string, string>>();
const proofFor = (body: unknown): Record<string, string> =>
  PROOF.get((body as { author?: { id?: string } } | undefined)?.author?.id ?? '') ?? {};
const AGENT = { id: 'agent-riverbend', name: 'Riverbend', kind: 'known', color: '#888888' };

describe('changing an answer', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}/workspaces/${boardId}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...proofFor(body) },
      body: JSON.stringify(body),
    });
  const ok = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-change-answer-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const aliceSigned = signedInPerson(handle, dataDir, base, {
      email: 'alice@harborlight.example',
      name: 'Alice',
    });
    ALICE = aliceSigned.user;
    PROOF.set(aliceSigned.user.id, aliceSigned.headers);
    const bobSigned = signedInPerson(handle, dataDir, base, {
      email: 'bob@harborlight.example',
      name: 'Bob',
    });
    BOB = bobSigned.user;
    PROOF.set(bobSigned.user.id, bobSigned.headers);
    const res = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    boardId = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function itemOn(): Promise<{ taskId: string; itemId: string }> {
    const { task } = await ok<{ task: { id: string } }>(
      await post('tasks', { title: 'Saltmarsh export', assignee: 'Riverbend', author: AGENT }),
    );
    const { item } = await ok<{ item: { id: string } }>(
      await post(`tasks/${task.id}/review-items`, {
        author: AGENT,
        review: {
          shape: 'decision',
          headline: 'Export nightly?',
          options: [
            { id: 'o-y', label: 'Nightly' },
            { id: 'o-n', label: 'Weekly' },
          ],
        },
      }),
    );
    return { taskId: task.id, itemId: item.id };
  }

  /** Every `decision.answered` the store emits while `act` runs. */
  async function answeredDuring(act: () => Promise<void>): Promise<TaskStoreEvent[]> {
    const events: TaskStoreEvent[] = [];
    const off = handle.tasks.onEvent((e) => {
      if (e.type === 'decision.answered') events.push(e);
    });
    try {
      await act();
    } finally {
      off();
    }
    return events;
  }

  it('undo then a new pick: the item holds the new pick, keeps the old one, and the filer hears once that it replaces it', async () => {
    const { taskId, itemId } = await itemOn();
    const answer = (text: string, optionId: string) =>
      post(`tasks/${taskId}/review-items/${itemId}/answer`, {
        text,
        answeredWith: optionId,
        author: ALICE,
      });
    await ok(await answer('Nightly', 'o-y'));

    const events = await answeredDuring(async () => {
      await ok(await post(`tasks/${taskId}/review-items/${itemId}/answer/undo`, { author: ALICE }));
      await ok(await answer('Weekly', 'o-n'));
    });

    const item = handle.tasks.listReviewItems(taskId).find((r) => r.id === itemId);
    expect(item?.answer).toEqual(
      expect.objectContaining({ text: 'Weekly', answeredWith: 'o-n', by: 'Alice' }),
    );
    expect(item?.priorAnswers).toEqual([
      expect.objectContaining({ text: 'Nightly', answeredWith: 'o-y', by: 'Alice' }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        reviewItemId: itemId,
        answer: 'Weekly',
        optionId: 'o-n',
        replaces: expect.objectContaining({ answer: 'Nightly', optionId: 'o-y', by: 'Alice' }),
      }),
    );
  });

  it('answering over a standing answer is the same change, in one step', async () => {
    const { taskId, itemId } = await itemOn();
    const url = `tasks/${taskId}/review-items/${itemId}/answer`;
    const first = await answeredDuring(async () => {
      await ok(await post(url, { text: 'Nightly', answeredWith: 'o-y', author: ALICE }));
    });
    // A first answer replaces nothing — the control for the marker below.
    expect(first[0]).not.toHaveProperty('replaces');
    const events = await answeredDuring(async () => {
      await ok(await post(url, { text: 'Weekly', answeredWith: 'o-n', author: ALICE }));
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        answer: 'Weekly',
        replaces: expect.objectContaining({ answer: 'Nightly' }),
      }),
    );
  });

  it('another person or an agent cannot change or undo Alice’s answer', async () => {
    const { taskId, itemId } = await itemOn();
    const url = `tasks/${taskId}/review-items/${itemId}/answer`;
    await ok(await post(url, { text: 'Nightly', answeredWith: 'o-y', author: ALICE }));

    for (const who of [BOB, AGENT]) {
      const over = await post(url, { text: 'Weekly', answeredWith: 'o-n', author: who });
      expect(over.status).toBe(409);
      expect(((await over.json()) as { error: string }).error).toBe('answered-by-other');
      const undo = await post(`${url}/undo`, { author: who });
      expect(undo.status).toBe(409);
    }
    const item = handle.tasks.listReviewItems(taskId).find((r) => r.id === itemId);
    expect(item?.answer).toEqual(expect.objectContaining({ text: 'Nightly', by: 'Alice' }));
    expect(item?.priorAnswers).toBeUndefined();
  });

  it('the ticket’s own decision follows the same rules', async () => {
    const { task } = await ok<{ task: Task }>(
      await post('tasks', {
        title: 'Ship now or wait?',
        assignee: 'human',
        needs: 'decision',
        body: 'Ship the Riverbend importer now, or wait a week for the rebuild? Blocked until answered: the launch note.',
      }),
    );
    await ok(await post(`tasks/${task.id}/answer`, { text: 'Ship now', author: ALICE }));
    expect((await post(`tasks/${task.id}/answer`, { text: 'Wait', author: BOB })).status).toBe(409);
    expect((await post(`tasks/${task.id}/answer/undo`, { author: AGENT })).status).toBe(409);

    const events = await answeredDuring(async () => {
      await ok(await post(`tasks/${task.id}/answer/undo`, { author: ALICE }));
      await ok(await post(`tasks/${task.id}/answer`, { text: 'Wait', author: ALICE }));
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        answer: 'Wait',
        replaces: expect.objectContaining({ answer: 'Ship now' }),
      }),
    );
  });

  it('GET /review-items lists what was answered, so Home can offer the way back', async () => {
    const { taskId, itemId } = await itemOn();
    await ok(
      await post(`tasks/${taskId}/review-items/${itemId}/answer`, {
        text: 'Weekly',
        answeredWith: 'o-n',
        author: ALICE,
      }),
    );
    const res = await ok<{ answered: Array<Record<string, unknown>> }>(
      await fetch(`${base}/workspaces/${boardId}/review-items`),
    );
    expect(res.answered).toContainEqual(
      expect.objectContaining({
        key: `task-review:${taskId}:${itemId}`,
        taskId,
        reviewItemId: itemId,
        headline: 'Export nightly?',
        answer: 'Weekly',
        by: 'Alice',
      }),
    );
  });
});
