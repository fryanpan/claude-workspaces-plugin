import type { User } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { fetchDocMeta } from '../src/doc-meta.ts';
import { mountDocFloats } from '../src/doc/doc-floats.ts';
import { createDocRecordReader } from '../src/doc/doc-record.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * How many times opening a doc reads its JSON record.
 *
 * The router reads `/workspaces/<ws>/docs/<id>?format=json` to pick a surface,
 * then both floats (plan gate, Review) read it as they mount, then read it
 * again when the Yjs initial sync fires the `meta` map. Five identical
 * requests per open, measured in headless Chrome on staging, and Sentry
 * raised them as an N+1.
 *
 * The open is driven the way the page drives it: `fetchDocMeta` (the router's
 * call), then `mountDocFloats`, then the server's state arriving as a Yjs
 * update, then the client's first-sync callback. The fake server keeps its
 * record and its `meta` map in step, as `doc-store.ts` does.
 */

const WS = 'w-harbor';
const DOC = 'd-tide';
const RECORD_URL = `/workspaces/${WS}/docs/${DOC}?format=json`;
const HARBOR: User = { id: 'u-harbor', name: 'Harbor Reviewer', kind: 'known', color: '#2e7dd7' };

const open: Array<() => void> = [];
beforeEach(() => {
  history.replaceState(null, '', `/workspaces/${WS}/docs/${DOC}`);
  document.body.innerHTML = '<main id="editor-pane"><div id="editor"></div></main>';
});
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** The server: a Yjs doc whose `meta` map is the synced half of the record. */
function fakeServer() {
  const ydoc = new Y.Doc();
  const meta = ydoc.getMap('meta');
  meta.set('contentRevision', 1);
  const reads: string[] = [];
  const posts: string[] = [];
  const board = { lead: 'harbor-agent' };
  const record = () => ({
    meta: { type: 'markdown', huddle: true, huddleKind: 'plan', ...meta.toJSON() },
    leadAgentId: board.lead,
    tasks: [],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push(url);
        if (url.endsWith('/plan-request')) {
          ydoc.transact(() => {
            meta.set('planRequestedAt', 1_789_000_000_000);
            meta.set('planRequestedBy', 'Harbor Reviewer');
          });
        }
        return new Response('{}', { status: 200 });
      }
      if (url === RECORD_URL) reads.push(url);
      return new Response(JSON.stringify(record()), { status: 200 });
    }),
  );
  return { ydoc, meta, reads, posts, board };
}

/** Open the doc: router read, floats mount, first sync lands. */
async function openDoc(server: ReturnType<typeof fakeServer>) {
  await fetchDocMeta(DOC);
  const ydoc = new Y.Doc();
  const scope = new MountScope();
  const readyCbs: Array<() => void> = [];
  let synced = false;
  mountDocFloats({
    docId: DOC,
    root: document.getElementById('editor') as HTMLElement,
    ydoc,
    user: HARBOR,
    canWrite: true,
    scope,
    whenSynced: (cb) => (synced ? cb() : readyCbs.push(cb)),
  });
  open.push(() => {
    scope.dispose();
    ydoc.destroy();
  });
  const sync = () => {
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(server.ydoc));
    synced = true;
    for (const cb of readyCbs.splice(0)) cb();
  };
  // Keep the client in step with the server from here on, as the socket does.
  server.ydoc.on('update', (u: Uint8Array) => {
    if (synced) Y.applyUpdate(ydoc, u);
  });
  return { ydoc, scope, sync };
}

const planFloat = () =>
  document.querySelector<HTMLButtonElement>('#editor-pane .plan-float:not(.review-float)');
const reviewFloat = () => document.querySelector<HTMLButtonElement>('#editor-pane .review-float');

describe('opening a doc', () => {
  it('reads the doc record once, and both floats render from that answer', async () => {
    const server = fakeServer();
    const { sync } = await openDoc(server);
    await vi.waitFor(() => expect(planFloat()?.dataset.face).toBe('make'));
    await vi.waitFor(() => expect(reviewFloat()?.dataset.face).toBe('ask'));
    sync();
    // Let any read the sync would have started go out.
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    expect(server.reads).toHaveLength(1);
  });

  it('reads nothing when only the content revision moves', async () => {
    const server = fakeServer();
    const { sync } = await openDoc(server);
    sync();
    await vi.waitFor(() => expect(planFloat()?.dataset.face).toBe('make'));
    const before = server.reads.length;
    server.meta.set('contentRevision', 2);
    server.meta.set('contentRevision', 3);
    await new Promise((r) => setTimeout(r, 0));
    expect(server.reads.length).toBe(before);
  });

  it('reads once more when a stamp moves, and both floats see it', async () => {
    const server = fakeServer();
    const { sync } = await openDoc(server);
    sync();
    await vi.waitFor(() => expect(planFloat()?.dataset.face).toBe('make'));
    const before = server.reads.length;
    // One transaction, as `setReviewRequested` writes it.
    server.ydoc.transact(() => {
      server.meta.set('reviewRequestedAt', 1_789_000_000_001);
      server.meta.set('reviewRequestedBy', 'Harbor Reviewer');
    });
    await vi.waitFor(() => expect(reviewFloat()?.dataset.face).toBe('requested'));
    // Both floats woke; they shared the one read.
    expect(server.reads.length - before).toBe(1);
  });

  it('catches a stamp that moved between the router read and the sync', async () => {
    const server = fakeServer();
    const { sync } = await openDoc(server);
    await vi.waitFor(() => expect(planFloat()?.dataset.face).toBe('make'));
    server.ydoc.transact(() => {
      server.meta.set('planRequestedAt', 1_789_000_000_002);
      server.meta.set('planRequestedBy', 'Harbor Reviewer');
    });
    sync();
    await vi.waitFor(() => expect(planFloat()?.dataset.face).toBe('requested'));
    expect(server.reads).toHaveLength(2);
  });

  it('reads fresh after a press, rather than reusing the answer from before it', async () => {
    const server = fakeServer();
    const { sync } = await openDoc(server);
    sync();
    await vi.waitFor(() => expect(planFloat()?.dataset.face).toBe('make'));
    planFloat()?.click();
    await vi.waitFor(() => expect(planFloat()?.dataset.face).toBe('requested'));
    expect(server.posts.some((u) => u.endsWith('/plan-request'))).toBe(true);
  });
  it('does not mount on an older read when the latest one fails', async () => {
    const server = fakeServer();
    // A read whose mount never came: a superseded navigation.
    await fetchDocMeta(DOC);
    // Nothing in the synced map moves, so only a fresh read can show this.
    server.board.lead = 'saltmarsh-agent';
    const fetchStub = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        vi.stubGlobal('fetch', fetchStub);
        return new Response('down', { status: 503 });
      }),
    );
    const { sync } = await openDoc(server);
    sync();
    // The floats asked the server rather than rendering the stale seed.
    await vi.waitFor(() => expect(planFloat()?.textContent).toContain('saltmarsh-agent'));
  });
});

describe('createDocRecordReader', () => {
  it('shares one in-flight read, and asks again after an invalidate', async () => {
    let calls = 0;
    const reader = createDocRecordReader('/r', async () => {
      calls += 1;
      return { meta: { planState: calls === 1 ? 'pending' : 'approved' } };
    });
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    await reader.read();
    expect(calls).toBe(1);
    reader.invalidate();
    expect(await reader.read()).toEqual({ meta: { planState: 'approved' } });
    expect(calls).toBe(2);
  });

  it('retries after a failed read instead of sharing the failure', async () => {
    let calls = 0;
    const reader = createDocRecordReader('/r', async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return { meta: {} };
    });
    await expect(reader.read()).rejects.toThrow('offline');
    await expect(reader.read()).resolves.toEqual({ meta: {} });
    expect(calls).toBe(2);
  });

  it('compares only the stamps a float renders, and notes a movement once', () => {
    let calls = 0;
    const reader = createDocRecordReader(
      '/r',
      async () => {
        calls += 1;
        return {};
      },
      { meta: { planState: 'pending', contentRevision: 4 } },
    );
    const map = new Map<string, unknown>([
      ['planState', 'pending'],
      ['contentRevision', 9],
    ]);
    expect(reader.noteStamps((k) => map.get(k))).toBe(false);
    void reader.read();
    expect(calls).toBe(0);
    map.set('planState', 'approved');
    expect(reader.noteStamps((k) => map.get(k))).toBe(true);
    // The same stamps seen again — the sync callback after the map event —
    // are already accounted for.
    expect(reader.noteStamps((k) => map.get(k))).toBe(false);
    void reader.read();
    expect(calls).toBe(1);
  });
});
