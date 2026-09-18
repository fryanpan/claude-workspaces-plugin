/**
 * The frame a resolve actually puts on an agent's stream.
 *
 * `packages/mcp/test/quiet-resolve.test.ts` proves the RENDERER says nothing
 * for it. It cannot prove the payload is the real one: it is written by hand
 * there, so a server that stopped sending the thread on a resolve — the field
 * the open-ask carve-out reads — would leave that file green while production
 * either woke on every click or went silent on an ask nobody answered. This
 * one drives the acts through the routes, reads the frames off
 * `/events/agent/<id>`, and asks the child's own predicate about each.
 *
 * Three things per case, and the third is the one that matters:
 *
 *  1. the act produces the event at all (the positive control: a predicate
 *     that answers about a frame nobody sent proves nothing);
 *  2. the frames that must still wake the agent do;
 *  3. the one that must not, does not.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBookkeepingEvent } from '../../mcp/src/bookkeeping-events.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = 'agent-harborlight';
const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'person' };
const ASKER = { id: AGENT, name: 'Harborlight', kind: 'agent' };

type Frame = { event: string; data: Record<string, unknown> };

function listen(res: Response): { frames: Frame[]; stop: () => void } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          if (raw.startsWith(':')) continue;
          const f: Frame = { event: 'message', data: {} };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) f.event = line.slice(6).trim();
            else if (line.startsWith('data:')) f.data = JSON.parse(line.slice(5).trim());
          }
          frames.push(f);
        }
      }
    } catch {
      // Cancelled with a read in flight; the frames collected still stand.
    }
  })();
  return {
    frames,
    stop: () => {
      stopped = true;
      void reader.cancel();
    },
  };
}

describe('a click a person made wakes no agent', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let srcDir: string;
  let base: string;
  let WS = '';
  let docId = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  /**
   * Open a thread on the doc, optionally declaring an ask on it. Answers with
   * the declaring comment's id too, because answering an ask is addressed by
   * the comment that made it.
   */
  const openThread = async (
    author: typeof PERSON,
    text: string,
    review?: Record<string, unknown>,
  ): Promise<{ threadId: string; commentId: string }> => {
    const res = await post(`/workspaces/${WS}/docs/${docId}/threads`, {
      author,
      text,
      anchor: { kind: 'subject' },
      ...(review ? { review } : {}),
    });
    const thread = (
      (await res.json()) as { thread: { id: string; comments: Array<{ id: string }> } }
    ).thread;
    return { threadId: thread.id, commentId: thread.comments[0]?.id ?? '' };
  };

  /** The ask every review-item case here files. */
  const ASK = {
    shape: 'decision',
    headline: 'Ship Thursday or Friday?',
    detail: 'Friday buys one more review pass and misses the demo slot.',
    options: [
      { id: 'thu', label: 'Thursday' },
      { id: 'fri', label: 'Friday' },
    ],
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'quiet-click-'));
    srcDir = mkdtempSync(join(tmpdir(), 'quiet-click-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    const path = join(srcDir, 'doc-one.md');
    writeFileSync(path, '# doc-one\n\nBody.\n');
    const res = await post(`/workspaces/${WS}/docs`, {
      docId: 'doc-one',
      sourceUrl: path,
      title: 'doc-one',
    });
    docId = ((await res.json()) as { docId: string }).docId;
    await post(`/api/agents/${AGENT}/watches`, { add: [docId, `ws:${WS}`] });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('resolves without waking, and the reply that came with it still wakes', async () => {
    const mine = listen(await get(`/events/agent/${AGENT}`));
    const { threadId } = await openThread(ASKER, 'Removed the stale paragraph.');

    // The two calls a person's "reply and resolve" gesture makes.
    await post(`/workspaces/${WS}/docs/${docId}/threads/${threadId}/comments`, {
      author: PERSON,
      text: 'Reads better — thanks.',
    });
    await post(`/workspaces/${WS}/docs/${docId}/threads/${threadId}/resolve`, { author: PERSON });

    await waitFor(() => mine.frames.some((f) => f.event === 'thread.resolved'));
    const replied = mine.frames.find((f) => f.event === 'thread.replied');
    const resolved = mine.frames.find((f) => f.event === 'thread.resolved');
    // Positive control: the server broadcasts both — suppression is the
    // child's job, not the wire's.
    expect(replied).toBeDefined();
    expect(resolved).toBeDefined();

    expect(isBookkeepingEvent('thread.replied', replied?.data)).toBe(false);
    expect(isBookkeepingEvent('thread.resolved', resolved?.data)).toBe(true);

    mine.stop();
  }, 60_000);

  it('still wakes on a resolve that closed an ask nobody answered', async () => {
    const mine = listen(await get(`/events/agent/${AGENT}`));
    const { threadId } = await openThread(ASKER, 'Which way should this go?', ASK);
    await post(`/workspaces/${WS}/docs/${docId}/threads/${threadId}/resolve`, { author: PERSON });

    await waitFor(() => mine.frames.some((f) => f.event === 'thread.resolved'));
    const resolved = mine.frames.find((f) => f.event === 'thread.resolved');
    expect(resolved).toBeDefined();
    // Resolving retires every item on the thread, and nothing else in the
    // server tells the agent that the question went away.
    expect(isBookkeepingEvent('thread.resolved', resolved?.data)).toBe(false);

    mine.stop();
  }, 60_000);

  it('stops waking once that ask has been answered', async () => {
    const mine = listen(await get(`/events/agent/${AGENT}`));
    const { threadId, commentId } = await openThread(ASKER, 'Which way should this go?', ASK);
    await post(`/workspaces/${WS}/docs/${docId}/threads/${threadId}/answer`, {
      author: PERSON,
      commentId,
      text: 'Friday.',
      optionId: 'fri',
    });
    await waitFor(() => mine.frames.some((f) => f.event === 'thread.replied'));
    await post(`/workspaces/${WS}/docs/${docId}/threads/${threadId}/resolve`, { author: PERSON });

    await waitFor(() => mine.frames.some((f) => f.event === 'thread.resolved'));
    const resolved = mine.frames.find((f) => f.event === 'thread.resolved');
    expect(resolved).toBeDefined();
    expect(isBookkeepingEvent('thread.resolved', resolved?.data)).toBe(true);

    mine.stop();
  }, 60_000);
});
