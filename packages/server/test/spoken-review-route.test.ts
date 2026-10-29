import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The voice review queue through the REAL server: spoken over the converse
 * socket with fake engines, each `decide` written the way the page writes it
 * (`spokenDecisionRequest`, to the routes the screen's answer button and Undo
 * use), and every effect read back from the store or the queue.
 *
 * Nothing reaches a vendor. Fixture names are the house ones.
 */
import type { User } from '@claude-workspaces/core';
import { type SpokenDecide, spokenDecisionRequest } from '@claude-workspaces/core/spoken-reply';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

/** Alice, signed in on the board page by each server's `beforeAll`: a person's
 *  answer is recorded only from that person's own proven request. */
let PERSON: User = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const signIns = new Map<string, Record<string, string>>();
const signInAlice = (handle: ServerHandle, dataDir: string, base: string) => {
  const alice = signedInPerson(handle, dataDir, base, {
    email: 'alice@harborlight.example',
    name: 'Alice',
  });
  PERSON = alice.user;
  signIns.set(PERSON.id, alice.headers);
};
const authHeaders = (body: unknown) =>
  signIns.get((body as { author?: User } | undefined)?.author?.id ?? '') ?? {};
const AGENT = { id: 'agent-riverbend', name: 'Riverbend', kind: 'known', color: '#888888' };

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('the review queue by voice, end to end', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let boardId = '';
  let taskId = '';
  let itemId = '';
  let thread = { docId: '', threadId: '', commentId: '' };
  const opened: TranscriptionOpenOpts[] = [];

  const listener: TranscriptionEngine = {
    name: 'fake',
    async open(opts) {
      opened.push(opts);
      return { send: () => {}, close: async () => {} };
    },
  };
  const voice: SpokenVoice = {
    name: 'fake',
    async speak(_text, onAudio) {
      onAudio(new Uint8Array(480));
    },
  };

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(body) },
      body: JSON.stringify(body),
    });
    return res;
  };
  const ok = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-spoken-review-'));
    handle = createServer({
      port: 0,
      dataDir,
      spokenReply: { listener, voices: { 1: voice, 2: null }, gemini: null },
    });
    base = `http://127.0.0.1:${handle.port}`;
    wsBase = `ws://127.0.0.1:${handle.port}`;
    signInAlice(handle, dataDir, base);
    boardId = (
      await ok<{ workspace: { id: string } }>(await post('/workspaces', { name: 'Harborlight' }))
    ).workspace.id;
    taskId = (
      await ok<{ task: { id: string } }>(
        await post(`/workspaces/${boardId}/tasks`, {
          title: 'Harborlight importer',
          assignee: 'Riverbend',
          author: AGENT,
        }),
      )
    ).task.id;
    itemId = (
      await ok<{ item: { id: string } }>(
        await post(`/workspaces/${boardId}/tasks/${taskId}/review-items`, {
          author: AGENT,
          review: {
            shape: 'decision',
            headline: 'Ship the importer this week?',
            detail: 'It moves Saltmarsh boards in one pass.',
            options: [
              { id: 'o-ship', label: 'Ship it' },
              { id: 'o-hold', label: 'Hold' },
            ],
          },
        }),
      )
    ).item.id;
    const file = join(dataDir, 'notes.md');
    writeFileSync(file, '# Notes\n\nThe empty state says nothing yet.\n');
    await ok(
      await post(`/workspaces/${boardId}/docs`, {
        docId: 'notes',
        type: 'markdown',
        sourceUrl: file,
      }),
    );
    await ok(await post(`/workspaces/${boardId}/docs:attach`, { docId: 'notes' }));
    const opened = await ok<{ thread: { id: string; comments: Array<{ id: string }> } }>(
      await post(`/workspaces/${boardId}/docs/notes/threads/by_find`, {
        find: 'The empty state says nothing yet.',
        text: 'Wording for the empty state.',
        author: AGENT,
        review: { shape: 'review', headline: 'Is the empty state copy right?' },
      }),
    );
    thread = {
      docId: 'notes',
      threadId: opened.thread.id,
      commentId: opened.thread.comments[0]?.id ?? '',
    };
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const ticketAnswer = () =>
    handle.tasks.listReviewItems(taskId).find((r) => r.id === itemId)?.answer;
  const queueKeys = async () => {
    const { items } = await ok<{
      items: Array<{ kind: string; reviewItemId?: string; threadId?: string }>;
    }>(await fetch(`${base}/workspaces/${boardId}/review-items`));
    return items.map((i) => (i.kind === 'task-review' ? i.reviewItemId : i.threadId));
  };

  /** The page: speaks through the listener, writes every `decide` it is
   *  handed the way `spoken-review-decide.ts` does, and reports back. */
  async function page() {
    const ws = new WebSocket(`${wsBase}/workspaces/${boardId}/voice/converse`);
    ws.binaryType = 'arraybuffer';
    const frames: Frame[] = [];
    const writes: Array<{ decide: SpokenDecide; status: number }> = [];
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      const f = JSON.parse(ev.data) as Frame;
      frames.push(f);
      const d = f.type === 'reply' ? (f.decide as SpokenDecide | undefined) : undefined;
      if (!d) return;
      const { sub, body } = spokenDecisionRequest(d);
      void post(`/workspaces/${boardId}/${sub}`, { ...body, author: PERSON }).then((res) => {
        writes.push({ decide: d, status: res.status });
        ws.send(JSON.stringify({ type: 'decided', id: d.id, ok: res.ok }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('converse socket refused')));
    });
    await waitFor(() => frames.some((f) => f.type === 'ready'), { describe: 'ready' });
    const replies = () => frames.filter((f) => f.type === 'reply');
    const speak = async (text: string): Promise<Frame> => {
      const before = replies().length;
      const n = opened.length;
      ws.send(JSON.stringify({ type: 'start', setup: 1, mode: 'hold', author: PERSON }));
      await waitFor(() => opened.length > n, { describe: 'listener opened' });
      opened.at(-1)?.onTurn({ turn: 0, text, final: true });
      ws.send(JSON.stringify({ type: 'end' }));
      await waitFor(() => replies().length > before, { describe: `reply to "${text}"` });
      return replies().at(-1) as Frame;
    };
    return { ws, writes, speak };
  }

  it('records nothing at a read-back answered no, then records on a yes and undoes on a no', async () => {
    const p = await page();
    const first = await p.speak('Go through my reviews.');
    expect(first.spoken).toBe(
      'Two to go through. First: Ship the importer this week? Ship it or Hold?',
    );
    expect((await p.speak('Ship it.')).spoken).toBe('Recording: Ship it. OK?');
    expect((await p.speak('Wait.')).spoken).toBe(
      'Not recorded. Ship the importer this week? Ship it or Hold?',
    );
    expect(p.writes).toEqual([]);
    expect(ticketAnswer()).toBeUndefined();

    await p.speak('Hold.');
    const recorded = await p.speak('Yes.');
    expect(recorded.spoken).toBe(
      'Recorded. Next: Is the empty state copy right? What’s your answer?',
    );
    await waitFor(() => ticketAnswer() !== undefined, { describe: 'answer recorded' });
    // The same record a tap on the card leaves: the label as the words, the
    // option as provenance, the person as the one who decided.
    expect(ticketAnswer()).toMatchObject({ text: 'Hold', answeredWith: 'o-hold', by: 'Alice' });
    expect(await queueKeys()).not.toContain(itemId);

    await p.speak('No.');
    await waitFor(() => p.writes.length === 2, { describe: 'undo written' });
    expect(p.writes.map((w) => [w.decide.action, w.status])).toEqual([
      ['record', 200],
      ['undo', 200],
    ]);
    expect(ticketAnswer()).toBeUndefined();
    // Soft: the words taken back are kept beside the item.
    const item = handle.tasks.listReviewItems(taskId).find((r) => r.id === itemId);
    expect(item?.priorAnswers?.at(-1)).toMatchObject({ text: 'Hold' });
    expect(await queueKeys()).toContain(itemId);
    p.ws.close();
  });

  it('records a spoken answer on a doc-thread item and takes it back with "undo that"', async () => {
    const p = await page();
    await p.speak('go through my reviews');
    await p.speak('skip');
    expect((await p.speak('Yes, it reads well')).spoken).toBe('Recording: Yes, it reads well. OK?');
    await p.speak('yes');
    await waitFor(() => p.writes.length === 1, { describe: 'answer written' });
    expect(p.writes[0]?.status).toBe(200);
    expect(await queueKeys()).not.toContain(thread.threadId);
    await p.speak('undo that');
    await waitFor(() => p.writes.length === 2, { describe: 'undo written' });
    expect(p.writes[1]?.status).toBe(200);
    expect(await queueKeys()).toContain(thread.threadId);
    p.ws.close();
  });
});

describe('POST …/review-items/:id/answer/undo', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}/workspaces/${boardId}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(body) },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-answer-undo-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    signInAlice(handle, dataDir, base);
    const res = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Riverbend' }),
    });
    boardId = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function itemOn(): Promise<{ taskId: string; itemId: string }> {
    const t = await post('tasks', {
      title: 'Saltmarsh export',
      assignee: 'Riverbend',
      author: AGENT,
    });
    const taskId = ((await t.json()) as { task: { id: string } }).task.id;
    const r = await post(`tasks/${taskId}/review-items`, {
      author: AGENT,
      review: {
        shape: 'decision',
        headline: 'Export nightly?',
        options: [
          { id: 'o-y', label: 'Nightly' },
          { id: 'o-n', label: 'Weekly' },
        ],
      },
    });
    return { taskId, itemId: ((await r.json()) as { item: { id: string } }).item.id };
  }

  it('reopens the item, keeps the words, and refuses a second undo', async () => {
    const { taskId, itemId } = await itemOn();
    expect(
      (
        await post(`tasks/${taskId}/review-items/${itemId}/answer`, {
          text: 'Weekly',
          author: PERSON,
        })
      ).status,
    ).toBe(200);
    const undo = () =>
      post(`tasks/${taskId}/review-items/${itemId}/answer/undo`, { author: PERSON });
    expect((await undo()).status).toBe(200);
    const item = handle.tasks.listReviewItems(taskId).find((r) => r.id === itemId);
    expect(item?.answer).toBeUndefined();
    expect(item?.priorAnswers).toEqual([expect.objectContaining({ text: 'Weekly', by: 'Alice' })]);
    const again = await undo();
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'no-answer' });
  });

  it('answers 404 for an item the ticket does not have, and 400 without an author', async () => {
    const { taskId, itemId } = await itemOn();
    expect(
      (await post(`tasks/${taskId}/review-items/r-nope/answer/undo`, { author: PERSON })).status,
    ).toBe(404);
    expect((await post(`tasks/${taskId}/review-items/${itemId}/answer/undo`, {})).status).toBe(400);
  });
});
