/**
 * A review's member walks read threads without loading the members.
 *
 * Two walks over every file of a bound folder or diff review only COUNT or
 * LIST threads: the one-call thread listing an agent polls, and the
 * open-thread guardrail that refuses to retire a review with unread
 * feedback (both the archive route's and `deleteWorkspace`'s). Through
 * `listThreads` each member came into memory for thirty minutes. Each case
 * releases every doc, drives the walk, asserts the members are still out of
 * memory, and that the answer is the one a read over resident docs gives.
 *
 * Fixtures are invented; the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT: User = {
  id: 'agent-harborlight',
  name: 'Harborlight Agent',
  kind: 'agent' as unknown as User['kind'],
  color: '#000',
};
const FILES = ['tides.md', 'ferry.md', 'moorings.md'];

let dataDir: string;
let folder: string;
let handle: ServerHandle;
let base: string;
let ws: string;
let setId: string;
let members: string[];

async function json<T>(res: Response): Promise<T> {
  expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
  return (await res.json()) as T;
}

/** A folder review on a board, a thread on every member, written by one
 *  server and read by a second. */
async function seed(): Promise<void> {
  const first = createServer({ port: 0, dataDir, spawnerAgentId: null });
  const firstBase = `http://127.0.0.1:${first.port}`;
  ws = await seedBoard(firstBase);
  for (const [i, f] of FILES.entries()) {
    writeFileSync(join(folder, f), `# ${f}\n\nRiverbend line ${i}\n`);
  }
  const bound = await json<{ workspaceId: string }>(
    await fetch(`${firstBase}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: folder, hubWorkspaceId: ws }),
    }),
  );
  setId = bound.workspaceId;
  members = [];
  for (const [i, f] of FILES.entries()) {
    const opened = await json<{ docId: string }>(
      await fetch(
        `${firstBase}/workspaces/${ws}/attachments/${encodeURIComponent(setId)}/context-file`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relPath: f }),
        },
      ),
    );
    members.push(opened.docId);
    const made = await first.docStore.createThreadByFind(
      opened.docId,
      { find: `Riverbend line ${i}` },
      AGENT,
      'Is this right?',
    );
    if (!made.ok) throw new Error(made.error);
  }
  first.docStore.flush();
  await first.stop();
}

const byDocId = (a: { docId: string }, b: { docId: string }) => a.docId.localeCompare(b.docId);

function evictAll(h: ServerHandle): void {
  for (const meta of h.docStore.list()) h.docStore.evictDoc(meta.docId);
}
const inMemory = () => members.filter((id) => handle.docStore.peek(id) !== undefined);
const warmAll = () => {
  for (const id of members) handle.docStore.getForRead(id);
  expect(inMemory()).toEqual(members);
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'review-cold-data-'));
  folder = mkdtempSync(join(tmpdir(), 'review-cold-src-'));
  await seed();
  handle = createServer({ port: 0, dataDir, spawnerAgentId: null });
  base = `http://127.0.0.1:${handle.port}`;
});
afterEach(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

describe("a review's member walks leave cold members cold", () => {
  it('control: a hydrating threads read loads every member', () => {
    evictAll(handle);
    for (const id of members) handle.docStore.listThreads(id);
    expect(inMemory()).toEqual(members);
  });

  it('the review-wide thread listing reads every member without loading one', async () => {
    const read = async () =>
      json<{ threads: Array<{ docId: string; comments: unknown[] }> }>(
        await fetch(`${base}/workspaces/${ws}/attachments/${encodeURIComponent(setId)}/threads`),
      );
    evictAll(handle);
    const cold = await read();
    expect(inMemory()).toEqual([]);
    expect(cold.threads.map((t) => t.docId).sort()).toEqual([...members].sort());
    warmAll();
    expect((await read()).threads.sort(byDocId)).toEqual(cold.threads.sort(byDocId));
  });

  it("the archive route's open-thread guardrail refuses without loading a member", async () => {
    const refuse = async () => {
      const res = await fetch(`${base}/workspaces/${ws}/attachments/${encodeURIComponent(setId)}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { files: Array<{ docId: string; openThreads: number }> };
      // `list()` orders resident docs ahead of cold ones; the walk's answer
      // is the set, so compare it in one order.
      return body.files.sort(byDocId);
    };
    evictAll(handle);
    const cold = await refuse();
    expect(inMemory()).toEqual([]);
    expect(cold.map((f) => f.openThreads)).toEqual([1, 1, 1]);
    warmAll();
    expect(await refuse()).toEqual(cold);
  });

  it("deleteWorkspace's guardrail refuses without loading a member", () => {
    const refuse = () => {
      const res = handle.docStore.deleteWorkspace(setId);
      if (res.ok || res.error !== 'has-open-threads') throw new Error('not refused');
      return res.files.sort(byDocId);
    };
    evictAll(handle);
    const cold = refuse();
    expect(inMemory()).toEqual([]);
    expect(cold.map((f) => f.openThreads)).toEqual([1, 1, 1]);
    warmAll();
    expect(refuse()).toEqual(cold);
  });
});
