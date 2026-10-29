/**
 * An event that exists for analytics does not reach a listening agent.
 *
 * `review_item.viewed` records that a person opened a card. It changes no
 * task and no status, and no surface reads the frame — the board POSTs the
 * beacon and never listens for it. Before this rule the frame rode the board
 * channel like any other event, so every attached agent spent a turn to learn
 * that somebody had looked at its ask.
 *
 * The silence here is proved, not assumed. Three controls:
 *
 *  1. A PERSON views the item, and an AGENT holds the stream. Nothing about
 *     self-authorship can explain the silence (`self-authored.ts` is the
 *     other half of this rule, and it would suppress the agent's own act).
 *  2. The answer is posted after the view, and its `decision.answered` must
 *     ARRIVE: it is the wake an agent waits for, and a drop that took it too
 *     would fail here. Frames on one channel keep their order, so an answer
 *     that arrived proves a view that was never sent rather than one still in
 *     flight. Its measurement twin, `review_item.answered`, is kept off the
 *     wire by the same rule (Bryan, 2026-10-27: one answer, one wake).
 *  3. The audit log still holds both measurement rows. The measurement is the
 *     reason the events exist, and it is written by `TaskEventBus.emit` before
 *     any listener runs, so keeping the frames off the wire costs it nothing.
 *
 * All fixtures are invented. Port 0, temp data dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = 'agent-harborlight';
/** Signed in on the board page by the setup: a person's answer is recorded
 *  only from that person's own proven request. */
let PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'person' };

type Frame = { event: string; data: Record<string, unknown> };

/** Read SSE frames off an open response until stopped. */
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

describe('an analytics event stays off every stream', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let WS = '';
  let personHeaders: Record<string, string> = {};

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((body as { author?: { id?: string } } | null)?.author?.id === PERSON.id
          ? personHeaders
          : {}),
      },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'analytics-stream-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    // The page's origin is the Host these requests name, not the socket's.
    const reviewer = signedInPerson(handle, dataDir, `localhost:${handle.port}`, {
      email: 'reviewer@harborlight.example',
      name: 'Reviewer',
    });
    PERSON = reviewer.user;
    personHeaders = reviewer.headers;
    await post(`/workspaces/${WS}/agents`, {
      agentId: AGENT,
      agentName: 'Harborlight',
      runtime: 'claude-code-local',
    });
    await post(`/api/agents/${AGENT}/watches`, { add: [`ws:${WS}`] });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('sends no viewed frame to an agent or a page, and still records the row', async () => {
    const created = await post(`/workspaces/${WS}/tasks`, {
      title: 'Agent can rebuild the Riverbend index nightly',
      body: 'Agent can refresh the index on a schedule so that search stays current.',
      author: { id: AGENT, name: 'Harborlight', kind: 'agent' },
    });
    const taskId = ((await created.json()) as { task: { id: string } }).task.id;
    const added = await post(`/workspaces/${WS}/tasks/${taskId}/review-items`, {
      review: {
        shape: 'decision',
        headline: 'Which key should the nightly rebuild sort on?',
        options: [
          { id: 'o-1', label: 'The existing key' },
          { id: 'o-2', label: 'A fresh key' },
        ],
      },
      author: { id: AGENT, name: 'Harborlight', kind: 'agent' },
    });
    const itemId = ((await added.json()) as { item: { id: string } }).item.id;

    const agentStream = listen(await get(`/events/agent/${AGENT}`));
    const pageStream = listen(await get(`/workspaces/${WS}/events:stream`));

    // The person reads the card, then answers it. Same actor, same item, one
    // event each — and only the second is news an agent can act on.
    const viewed = await post(`/workspaces/${WS}/review-items/viewed`, {
      reviewItemId: itemId,
      author: PERSON,
    });
    expect(viewed.status).toBe(200);
    await post(`/workspaces/${WS}/tasks/${taskId}/review-items/${itemId}/answer`, {
      text: 'A fresh key',
      answeredWith: 'o-2',
      author: PERSON,
    });

    // `review_item.answered` is emitted after `decision.answered`, so a
    // later act's frame bounds the window: once it is here, the answered
    // row would have been too.
    await post(`/workspaces/${WS}/tasks`, {
      title: 'Sentinel',
      body: 'Bob can see where the window ends so that an absence is an absence.',
      author: PERSON,
    });
    for (const stream of [agentStream, pageStream]) {
      await waitFor(() => stream.frames.some((f) => f.event === 'decision.answered'));
      await waitFor(() =>
        stream.frames.some(
          (f) =>
            f.event === 'task.created' &&
            (f.data.task as { title?: string } | undefined)?.title === 'Sentinel',
        ),
      );
      const events = stream.frames.map((f) => f.event);
      expect(events).not.toContain('review_item.viewed');
      expect(events).not.toContain('review_item.answered');
    }

    // The measurement the event exists for is still written.
    const log = readFileSync(join(dataDir, 'workspaces', `${WS}.events.jsonl`), 'utf8');
    const types = log
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { event?: string }).event);
    expect(types).toContain('review_item.viewed');
    expect(types).toContain('review_item.answered');

    agentStream.stop();
    pageStream.stop();
  }, 60_000);
});
