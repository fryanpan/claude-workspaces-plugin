import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * A bound mockup is a LIVE surface: editing its source file updates the page
 * everyone has open, and every round it has ever had stays readable.
 *
 * Bryan's report of the old flow was that each round produced a new mockup at
 * a new link, so seeing round two meant leaving whatever he was reading to go
 * and find the review item pointing at it. He answered "same link" to whether
 * a round should replace the page under the one he already had. These tests
 * pin the server half of that: the watcher, the frame, the rounds, and the
 * threads that must survive a rebind.
 */

let WS = '';

const ROUND_ONE =
  '<!doctype html><html><head><style>h1{color:red}</style></head>' +
  '<body><h1 id="hero">Round one</h1></body></html>';
const ROUND_TWO =
  '<!doctype html><html><head><style>h1{color:blue}</style></head>' +
  '<body><h1 id="hero">Round two</h1><p id="added">New paragraph</p></body></html>';

/** Every frame one SSE stream carried, as {event, data} pairs. */
function listen(res: Response) {
  const frames: { event: string; data: Record<string, unknown> }[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let pendingEvent = '';
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('event: ')) pendingEvent = line.slice('event: '.length).trim();
          if (line.startsWith('data: ')) {
            try {
              frames.push({
                event: pendingEvent,
                data: JSON.parse(line.slice('data: '.length)) as Record<string, unknown>,
              });
            } catch {
              /* a keepalive or a partial chunk is not a frame */
            }
          }
        }
      }
    } catch {
      /* the stream was cancelled by stop() */
    }
  })();
  return {
    frames,
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

describe('a bound mockup updates in place and keeps its rounds', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-mock-live-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function bind(docId: string, sourceUrl: string) {
    const res = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, type: 'mockup', sourceUrl }),
    });
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return (await res.json()) as { meta: { docId: string } };
  }

  const mockUrl = (docId: string, query = '') =>
    `${base}/workspaces/${WS}/mockups/${encodeURIComponent(docId)}${query}`;

  it('an edit to the source file broadcasts mockup.updated and changes what the link serves', async () => {
    const docId = 'mock-live-1';
    const src = join(dataDir, 'live-1.html');
    writeFileSync(src, ROUND_ONE);
    const { meta } = await bind(docId, src);

    const first = await fetch(mockUrl(docId));
    expect(first.status).toBe(200);
    expect(first.headers.get('x-mockup-version')).toBe('1');
    const firstHtml = await first.text();
    expect(firstHtml).toContain('Round one');
    // The live script is what makes the page swap itself; without the tag the
    // rest of this mechanism reaches nobody.
    expect(firstHtml).toContain('/widget/mockup-live.js');

    const stream = await fetch(
      `${base}/workspaces/${WS}/docs/${encodeURIComponent(meta.docId)}/events:stream`,
    );
    expect(stream.status).toBe(200);
    const heard = listen(stream);

    // The edit an agent's second round is: same file, different bytes.
    writeFileSync(src, ROUND_TWO);

    const frame = await waitFor(() => heard.frames.find((f) => f.event === 'mockup.updated'), {
      describe: 'a mockup.updated frame on the doc stream',
      timeout: 4000,
    });
    heard.stop();
    expect(frame.data.docId).toBe(meta.docId);
    expect(frame.data.version).toBe(2);
    expect((frame.data.versions as { v: number }[]).map((r) => r.v)).toEqual([1, 2]);

    // …and the link now serves it.
    const second = await fetch(mockUrl(docId));
    expect(await second.text()).toContain('Round two');
    expect(second.headers.get('x-mockup-version')).toBe('2');
  });

  it('an earlier round is still readable, and an unknown one is refused', async () => {
    const docId = 'mock-live-2';
    const src = join(dataDir, 'live-2.html');
    writeFileSync(src, ROUND_ONE);
    await bind(docId, src);
    await fetch(mockUrl(docId));
    writeFileSync(src, ROUND_TWO);
    await waitFor(
      async () => (await fetch(mockUrl(docId))).headers.get('x-mockup-version') === '2',
      { describe: 'the second round to be captured' },
    );

    const old = await fetch(mockUrl(docId, '?v=1'));
    expect(old.status).toBe(200);
    expect(old.headers.get('x-mockup-source')).toBe('version');
    const oldHtml = await old.text();
    expect(oldHtml).toContain('Round one');
    expect(oldHtml).not.toContain('Round two');

    // A round that does not exist is a refusal, not the current page under a
    // 200 — a reader who followed a version link must never be shown a
    // different one without being told.
    expect((await fetch(mockUrl(docId, '?v=99'))).status).toBe(404);
    expect((await fetch(mockUrl(docId, '?v=abc'))).status).toBe(400);
  });

  it('re-binding the same mockup id keeps the threads AND the page they were left on', async () => {
    // The reuse-clobber report, reproduced against the base commit before this
    // change: re-binding did NOT delete a single thread. What it destroyed was
    // the page — the capture is one file, and a rebind overwrote it, so the
    // round the reviewer had been commenting on existed nowhere afterwards.
    // That is why the recovery in the field was to re-bind the old HTML by
    // hand: it was the only way to get those bytes back, and nobody could say
    // it matched. The threads survive here as they always did; what is new is
    // that round one is still readable, so a comment left on it is still
    // answerable.
    const docId = 'mock-live-3';
    const first = join(dataDir, 'live-3a.html');
    const second = join(dataDir, 'live-3b.html');
    writeFileSync(first, ROUND_ONE);
    writeFileSync(second, ROUND_TWO);
    const { meta } = await bind(docId, first);

    const made = await fetch(
      `${base}/workspaces/${WS}/docs/${encodeURIComponent(meta.docId)}/threads`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: {
            kind: 'element',
            fingerprint: {
              id: 'hero',
              tag: 'H1',
              stableAttrs: {},
              classes: [],
              text: 'Round one',
              path: 'HTML[0] > BODY[0] > H1[0]',
              dataAttrs: {},
            },
            snippet: { text: 'Round one' },
          },
          text: 'This heading is doing too much.',
          author: { name: 'Reviewer' },
        }),
      },
    );
    expect(made.status, await made.clone().text()).toBe(200);
    const threadId = ((await made.json()) as { thread: { id: string } }).thread.id;

    await bind(docId, second);
    expect(await (await fetch(mockUrl(docId))).text()).toContain('Round two');

    // The page the comment was left on. Before this change these bytes were
    // gone the moment the rebind landed.
    const roundOne = await fetch(mockUrl(docId, '?v=1'));
    expect(roundOne.status).toBe(200);
    expect(await roundOne.text()).toContain('Round one');

    const after = (await (
      await fetch(`${base}/workspaces/${WS}/docs/${encodeURIComponent(meta.docId)}/threads`)
    ).json()) as { threads: { id: string; comments: { text: string }[] }[] };
    const kept = after.threads.find((t) => t.id === threadId);
    expect(kept, 'the thread survived the rebind').toBeDefined();
    expect(kept?.comments[0]?.text).toBe('This heading is doing too much.');
  });
});
