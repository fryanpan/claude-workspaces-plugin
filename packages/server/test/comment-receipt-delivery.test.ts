/**
 * The second tick, end to end: a comment is stamped `deliveredAt` exactly
 * when a session other than its author is holding a stream open, and never
 * otherwise.
 *
 * Driven over the real routes because the interesting half is the wiring —
 * `comment-receipt.ts` is unit-tested beside it, and a decision that is right
 * in isolation and never called is the shape this file exists to refuse.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementAnchor, User } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { openWorkspaceStream } from './agent-stream.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const reader: User = { id: 'known-reader', name: 'Reader', kind: 'known', color: '#2e7dd7' };
const peerAgent: User = { id: 'agent-peer', name: 'agent-peer', kind: 'known', color: '#7d2ed7' };

const anchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'P',
    stableAttrs: {},
    classes: [],
    text: 'some text',
    path: 'P[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'some text' },
};

describe('a comment is stamped delivered when a watching session is live', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;
  let docId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-receipt-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
    const file = join(dataDir, 'receipt-doc.md');
    writeFileSync(file, '# Doc\n\nsome text\n');
    const created = (await (
      await post('/docs', { docId: 'receipt-doc', type: 'markdown', sourceUrl: file })
    ).json()) as { docId: string };
    docId = created.docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}/workspaces/${ws}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Open a thread and answer with the id of the comment that opened it. */
  async function openThread(author: User, text: string): Promise<string> {
    const body = (await (
      await post(`/docs/${docId}/threads`, { author, text, anchor })
    ).json()) as {
      thread: { comments: Array<{ id: string }> };
    };
    const first = body.thread.comments[0];
    if (!first) throw new Error('the created thread carried no comment');
    return first.id;
  }

  /** What the browser reads: the comment's own `deliveredAt`, or undefined. */
  async function deliveredAt(commentId: string): Promise<number | undefined> {
    const body = (await (await fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`)).json()) as {
      threads?: Array<{ comments?: Array<{ id: string; deliveredAt?: number }> }>;
    };
    for (const thread of body.threads ?? []) {
      for (const c of thread.comments ?? []) if (c.id === commentId) return c.deliveredAt;
    }
    return undefined;
  }

  let unwatched = '';

  it('leaves a comment unstamped while no session is holding the board', async () => {
    unwatched = await openThread(reader, 'anyone there?');
    expect(await deliveredAt(unwatched)).toBeUndefined();
  });

  it('stamps one written while a peer session holds the stream', async () => {
    const stream = await openWorkspaceStream(base, ws, {}, 'agent-peer');
    try {
      const watched = await openThread(reader, 'and now?');
      const at = await waitFor(() => deliveredAt(watched), {
        describe: 'the comment to be stamped delivered',
      });
      expect(at).toBeGreaterThan(0);

      // ORDERING CONTROL, and the reason the first case is not a race: the
      // comment written with nobody listening is still unstamped at the
      // moment a later one has been stamped. Nothing is waited out.
      expect(await deliveredAt(unwatched)).toBeUndefined();
    } finally {
      await stream.close();
    }
  });

  it('does not stamp a comment the watching session wrote itself', async () => {
    const stream = await openWorkspaceStream(base, ws, {}, 'agent-peer');
    try {
      const ownWords = await openThread(peerAgent, 'a note to myself');
      // The positive control for this negative: with the same stream open, a
      // comment by somebody else IS stamped, so an absent stamp here is the
      // author rule and not a dead stream.
      const bySomebodyElse = await openThread(reader, 'a note to the agent');
      await waitFor(() => deliveredAt(bySomebodyElse), {
        describe: 'the peer comment to be stamped',
      });
      expect(await deliveredAt(ownWords)).toBeUndefined();
    } finally {
      await stream.close();
    }
  });

  it('keeps the first delivery when the comment is handed over again', async () => {
    const first = await openWorkspaceStream(base, ws, {}, 'agent-peer');
    let stamped = 0;
    let commentId = '';
    try {
      commentId = await openThread(reader, 'stamped once');
      stamped = await waitFor(() => deliveredAt(commentId), { describe: 'the first stamp' });
    } finally {
      await first.close();
    }
    // A second session attaches and a reply lands on the same thread: the
    // earlier comment's mark is the moment it FIRST reached somebody, and a
    // later hand-over must not rewrite it.
    const second = await openWorkspaceStream(base, ws, {}, 'agent-other');
    try {
      await post(`/docs/${docId}/threads`, { author: reader, text: 'more', anchor });
      expect(await deliveredAt(commentId)).toBe(stamped);
    } finally {
      await second.close();
    }
  });
});
