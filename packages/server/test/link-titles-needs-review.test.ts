/**
 * The needs-review fact on `POST /workspaces/<ws>/links:titles`: a task, doc
 * or mock link says whether its target holds an item waiting on the reader,
 * so a doc of links reads as a status page. Driven over HTTP against a real
 * server; the items are filed and answered through the store and the routes
 * the board uses. Every case carries its control — a link that must NOT be
 * marked, read in the same lookup.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight Lead', kind: 'known', color: '#888' };
const PERSON: User = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const QUESTION = {
  shape: 'review',
  headline: 'Is the Riverbend ferry timetable right?',
  detail: 'The Saltmarsh stop moved by ten minutes.',
};

describe('links:titles — the needs-review mark', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  let ws = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify(body),
    });

  const marks = async (urls: string[]): Promise<Record<string, boolean>> => {
    const r = await post(`/workspaces/${ws}/links:titles`, { urls });
    expect(r.status).toBe(200);
    return ((await r.json()) as { needsReview?: Record<string, boolean> }).needsReview ?? {};
  };

  const task = (title: string): string => {
    const made = handle.tasks.createTask(ws, {
      title,
      body: 'Alice can read the timetable so that the ferry runs.',
      actor: PERSON,
    });
    if (!made.ok) throw new Error(`task ${title} refused`);
    return made.task.id;
  };

  const fileItem = (taskId: string, review: object = QUESTION): string => {
    const added = handle.tasks.addReviewItem(taskId, review, { actor: AGENT });
    if (!added.ok) throw new Error(`review item refused: ${JSON.stringify(added)}`);
    return added.item.id;
  };

  const doc = async (docId: string, type: 'markdown' | 'mockup', text: string) => {
    const path = join(dataDir, `${docId}.${type === 'mockup' ? 'html' : 'md'}`);
    writeFileSync(path, text);
    const made = await post(`/workspaces/${ws}/docs`, { docId, type, sourceUrl: path });
    expect(made.status).toBe(200);
    const id = ((await made.json()) as { docId: string }).docId;
    expect((await post(`/workspaces/${ws}/docs:attach`, { docId: id })).status).toBe(200);
    return id;
  };

  const taskUrl = (id: string) => `${base}/workspaces/${ws}?task=${id}`;
  const docUrl = (id: string) => `${base}/workspaces/${ws}/docs/${id}`;
  const mockUrl = (id: string) => `${base}/workspaces/${ws}/mockups/${id}`;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'link-needs-review-'));
    handle = createServer({ port: 0, dataDir, spawnerAgentId: null });
    base = `http://127.0.0.1:${handle.port}`;
    ws = handle.tasks.createWorkspace('Harborlight').id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('marks a task with an open ticket item, and drops the mark once it is answered', async () => {
    const asked = task('Check the Riverbend timetable');
    const plain = task('Paint the Saltmarsh slipway');
    const item = fileItem(asked);
    const before = await marks([taskUrl(asked), taskUrl(plain)]);
    expect(before[taskUrl(asked)]).toBe(true);
    expect(before[taskUrl(plain)]).toBeUndefined();

    const answered = handle.tasks.answerTaskReview(asked, item, 'Yes, it is right.', {
      actor: PERSON,
    });
    expect(answered.ok).toBe(true);
    expect((await marks([taskUrl(asked)]))[taskUrl(asked)]).toBeUndefined();
  });

  it('marks a task whose question was declared on its own thread', async () => {
    const asked = task('Moor the Harborlight barge');
    const r = await post(`/workspaces/${ws}/docs/task:${asked}/threads`, {
      author: AGENT,
      text: 'One question before I moor it.',
      anchor: { kind: 'doc' },
      review: QUESTION,
    });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await marks([taskUrl(asked)]))[taskUrl(asked)]).toBe(true);
  });

  it('gives a finished task no mark, whatever it still holds', async () => {
    const finished = task('Dredge the Riverbend channel');
    fileItem(finished);
    expect((await marks([taskUrl(finished)]))[taskUrl(finished)]).toBe(true);
    expect(handle.tasks.transition(finished, 'done', { actor: PERSON }).ok).toBe(true);
    expect((await marks([taskUrl(finished)]))[taskUrl(finished)]).toBeUndefined();
  });

  it('marks a doc with an open declared thread, and drops it when the thread resolves', async () => {
    const asked = await doc('timetable-notes', 'markdown', '# Timetable\n\nThe Saltmarsh stop.\n');
    const quiet = await doc('slipway-notes', 'markdown', '# Slipway\n\nPaint it blue.\n');
    const opened = await post(`/workspaces/${ws}/docs/${asked}/threads/by_find`, {
      find: 'The Saltmarsh stop.',
      text: 'Checked against the harbour board.',
      author: AGENT,
      review: QUESTION,
    });
    expect(opened.status, await opened.clone().text()).toBe(200);
    const threadId = ((await opened.json()) as { thread: { id: string } }).thread.id;
    // A plain comment on the other doc is not an item.
    const note = await post(`/workspaces/${ws}/docs/${quiet}/threads/by_find`, {
      find: 'Paint it blue.',
      text: 'Painted.',
      author: AGENT,
    });
    expect(note.status).toBe(200);

    const before = await marks([docUrl(asked), docUrl(quiet)]);
    expect(before[docUrl(asked)]).toBe(true);
    expect(before[docUrl(quiet)]).toBeUndefined();

    handle.docStore.resolve(asked, threadId, PERSON);
    expect((await marks([docUrl(asked)]))[docUrl(asked)]).toBeUndefined();
  });

  it('marks a mock a ticket item links, as its dock shows it', async () => {
    const mock = await doc('ferry-mock', 'mockup', '<!doctype html><title>Ferry</title><p>Ferry');
    const other = await doc('barge-mock', 'mockup', '<!doctype html><title>Barge</title><p>Barge');
    const owner = task('Lay out the Riverbend ferry page');
    const item = fileItem(owner, {
      shape: 'review',
      headline: 'Is the Riverbend ferry page readable at phone width?',
      detail: `Check [the page](/workspaces/${ws}/mockups/${mock}) at 430px.`,
    });
    const before = await marks([mockUrl(mock), mockUrl(other)]);
    expect(before[mockUrl(mock)]).toBe(true);
    expect(before[mockUrl(other)]).toBeUndefined();

    expect(handle.tasks.answerTaskReview(owner, item, 'Readable.', { actor: PERSON }).ok).toBe(
      true,
    );
    expect((await marks([mockUrl(mock)]))[mockUrl(mock)]).toBeUndefined();
  });

  it('never marks an address that lies about its board', async () => {
    const asked = task('Count the Harborlight buoys');
    fileItem(asked);
    const other = handle.tasks.createWorkspace('Saltmarsh').id;
    const lying = `${base}/workspaces/${other}?task=${asked}`;
    const got = await marks([lying, taskUrl(asked)]);
    expect(got[lying]).toBeUndefined();
    expect(got[taskUrl(asked)]).toBe(true);
  });
});
