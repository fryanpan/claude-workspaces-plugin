/**
 * The bookkeeping frames a real server puts on a real agent's stream.
 *
 * `packages/mcp/test/quiet-bookkeeping.test.ts` proves the CHILD wakes nobody
 * for `comment.delivered`, `agent.listening` or `replay.gap`. It cannot prove
 * the server sends them: its payloads are written by hand, so a rule about a
 * frame nobody broadcasts is worth nothing. This file drives the acts through
 * the routes, reads what lands on `/events/agent/<id>`, and asks the child's
 * own predicate about each frame.
 *
 * Three things per case, and the third is the one that matters:
 *
 *  1. the act produces the frame at all (the positive control);
 *  2. where the frame still has to reach somebody, it does;
 *  3. the agent is not woken by it.
 *
 * And, for the gap, the question the suppression turns on: after one, can the
 * agent still read what it missed? The last case drives that recovery rather
 * than asserting a flag — the comment posted while the stream was down comes
 * back on the queue, with its words.
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
const PEER = 'agent-riverbend';
const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'person' };

type Frame = { event: string; data: Record<string, unknown> };

/** Drain one SSE response into a growing list of frames. */
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

describe('delivery bookkeeping reaches the wire and stops at the child', () => {
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
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}`, ...headers } });

  const comment = (text: string) =>
    post(`/workspaces/${WS}/docs/${docId}/threads`, {
      author: PERSON,
      text,
      anchor: { kind: 'subject' },
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'quiet-book-'));
    srcDir = mkdtempSync(join(tmpdir(), 'quiet-book-src-'));
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
    for (const id of [AGENT, PEER]) {
      await post(`/workspaces/${WS}/agents`, { agentId: id, runtime: 'claude-code-local' });
      await post(`/api/agents/${id}/watches`, { add: [docId, `ws:${WS}`] });
    }
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('puts a delivery receipt on the agent stream, and the child drops it', async () => {
    const mine = listen(await get(`/events/agent/${AGENT}`));
    // The sink is registered inside the stream's synchronous `start()`, so
    // the response headers above already mean `handedToAgent` can see it.
    await comment('Please tighten the second paragraph.');

    await waitFor(() => mine.frames.some((f) => f.event === 'comment.delivered'));
    const receipt = mine.frames.find((f) => f.event === 'comment.delivered');
    // POSITIVE CONTROL. The server really does hand this frame to an agent:
    // the receipt goes out with `skipAgentStreams`, which is exact only where
    // the stream carries an agentId, and a mux stream stays anonymous on doc
    // keys (sse-mux.ts `registersAgentId`). So the doc-channel copy lands
    // here looking exactly like a browser tab's, and only the child can tell.
    expect(receipt).toBeDefined();
    expect(receipt?.data.watchKey).toBe(docId);
    expect(isBookkeepingEvent('comment.delivered', receipt?.data)).toBe(true);

    // And the words themselves still wake: the comment arrived on the board
    // key and is not bookkeeping.
    const said = mine.frames.find((f) => f.event === 'thread.created');
    expect(said).toBeDefined();
    expect(isBookkeepingEvent('thread.created', said?.data)).toBe(false);

    mine.stop();
  }, 60_000);

  it('keeps a listening notice off the agent stream, and the child would drop it too', async () => {
    const page = listen(await get(`/workspaces/${WS}/events:stream`));
    const mine = listen(await get(`/events/agent/${AGENT}`));
    // A second session arriving is the change the announcer speaks for.
    const theirs = listen(await get(`/events/agent/${PEER}`));

    await waitFor(() =>
      page.frames.some(
        (f) =>
          f.event === 'agent.listening' && f.data.agentId === PEER && f.data.listening === true,
      ),
    );
    // POSITIVE CONTROL: the board's page is told, so the frame exists and the
    // announcer ran. The agent holding the same board key is not told —
    // `skipAgentStreams` is exact here, because a board key registers the id.
    expect(mine.frames.filter((f) => f.event === 'agent.listening')).toEqual([]);

    // Named in the child's list as well, so the drop does not rest on which
    // channel the frame happens to be broadcast on today.
    const notice = page.frames.find((f) => f.event === 'agent.listening');
    expect(isBookkeepingEvent('agent.listening', notice?.data)).toBe(true);

    theirs.stop();
    mine.stop();
    page.stop();
  }, 60_000);

  it('opens with a gap the child drops, and the missed comment still arrives', async () => {
    // Nobody listening: the comment is queued for the agent and never marked
    // emitted, which is the state a stream being down leaves behind.
    await comment('This one landed while the stream was down.');

    // Reconnect presenting a per-key position from a server epoch this
    // process never had — the exact case `replayAfter` cannot prove complete.
    const mine = listen(
      await get(`/events/agent/${AGENT}`, { 'last-event-id': `mux1:${docId}=00000000:1` }),
    );
    await waitFor(() => mine.frames.some((f) => f.event === 'replay.gap'));
    const gap = mine.frames.find((f) => f.event === 'replay.gap');
    // POSITIVE CONTROL: the server really opened this stream with a hole.
    expect(gap).toBeDefined();
    expect(gap?.data.watchKey).toBe(docId);
    expect(gap?.data.action).toBe('refetch');
    expect(isBookkeepingEvent('replay.gap', gap?.data)).toBe(true);

    // CRITERION: the agent can still read everything it missed. The heartbeat
    // it sends anyway re-offers the queued row as an addressed frame carrying
    // the words — no refetch prompt needed, and the row stays on the queue
    // until this agent acks it.
    await post(`/workspaces/${WS}/agents/${AGENT}/heartbeat`, {});
    await waitFor(() =>
      mine.frames.some((f) => f.event === 'thread.created' && f.data.commentQueueId !== undefined),
    );
    const missed = mine.frames.find((f) => f.data.commentQueueId !== undefined);
    expect(JSON.stringify(missed?.data)).toContain('This one landed while the stream was down.');
    // The frame that carries it is not bookkeeping — it wakes.
    expect(isBookkeepingEvent(String(missed?.event), missed?.data)).toBe(false);

    mine.stop();
  }, 60_000);
});
