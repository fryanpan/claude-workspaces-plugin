/**
 * Board links in the wrong form open the page they meant.
 *
 * THE FAILURES THIS PINS (owner's phone, 8 and 9 November):
 *  - `/workspaces/<ws>/review/<reviewItemId>` answered "Page not found …
 *    review/<id>". A review item opens on Home as `home?item=<key>`.
 *  - `add_review_item` answered with the TASK's link, so an agent had no link
 *    to the item and built the `review/` one.
 *  - `[note](../dir/plan.md)` in a reply opened `/dir/plan.md`.
 *  - The not-found page named only the part after the board, or the board id
 *    alone, so nobody could tell which link had failed.
 *
 * Driven over HTTP against the real chain, because where the route sits is
 * half of what is being tested: below every real route, above the not-found
 * tail. Fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent:riverbend', name: 'Riverbend', kind: 'agent' };

describe('board links over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;
  let otherWs: string;
  let taskId: string;
  let itemId: string;
  let addUrl: string | undefined;
  let otherItemId: string;
  let planDocId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = async (path: string, body: unknown) => {
    const r = await local(path, { method: 'POST', body: JSON.stringify(body) });
    expect(r.status, path).toBe(200);
    return (await r.json()) as Record<string, unknown>;
  };
  const fileTask = async (board: string, title: string) =>
    (
      (await post(`/workspaces/${board}/tasks`, { title, author: AGENT })) as {
        task: { id: string };
      }
    ).task.id;
  const fileItem = async (board: string, task: string) =>
    post(`/workspaces/${board}/tasks/${task}/review-items`, {
      author: AGENT,
      review: {
        shape: 'decision',
        headline: 'Which Harborlight link form should agents send?',
        options: [
          { id: 'o-1', label: 'The path form' },
          { id: 'o-2', label: 'The query form' },
        ],
      },
    });
  const bindDoc = async (board: string, docId: string, file: string) =>
    (
      (await post(`/workspaces/${board}/docs`, {
        docId,
        type: 'markdown',
        sourceUrl: file,
      })) as { docId: string }
    ).docId;
  const path = (url: string) => {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  };
  const location = async (p: string) => {
    const r = await local(p, { headers: { accept: 'text/html' } });
    return { status: r.status, location: r.headers.get('location'), body: await r.text() };
  };
  const itemHref = (board: string, task: string, item: string) =>
    `/workspaces/${board}/home?item=${encodeURIComponent(`task-review:${task}:${item}`)}`;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'board-links-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base, { name: 'Harborlight', host: `localhost:${handle.port}` });
    otherWs = await seedBoard(base, { name: 'Riverbend', host: `localhost:${handle.port}` });
    taskId = await fileTask(ws, 'Alice can open every link so that she reads the work');
    const added = await fileItem(ws, taskId);
    itemId = (added.item as { id: string }).id;
    addUrl = added.url as string | undefined;
    const otherTask = await fileTask(otherWs, 'Bob can read the Riverbend board');
    otherItemId = ((await fileItem(otherWs, otherTask)).item as { id: string }).id;

    const repo = join(dataDir, 'repo');
    mkdirSync(join(repo, 'docs', 'notes'), { recursive: true });
    mkdirSync(join(repo, 'docs', 'other'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'notes', 'plan.md'), '# Plan\n\nSaltmarsh plan.\n');
    writeFileSync(join(repo, 'docs', 'notes', 'index.md'), '# Index\n');
    writeFileSync(join(repo, 'docs', 'notes', 'same.md'), '# One\n');
    writeFileSync(join(repo, 'docs', 'other', 'same.md'), '# Two\n');
    planDocId = await bindDoc(ws, 'harbor-plan', join(repo, 'docs', 'notes', 'plan.md'));
    await bindDoc(ws, 'harbor-index', join(repo, 'docs', 'notes', 'index.md'));
    await bindDoc(ws, 'harbor-same-1', join(repo, 'docs', 'notes', 'same.md'));
    await bindDoc(ws, 'harbor-same-2', join(repo, 'docs', 'other', 'same.md'));
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers add_review_item with the item’s own link, not the task’s', () => {
    expect(addUrl).toBeDefined();
    expect(path(addUrl ?? 'http://x/')).toBe(itemHref(ws, taskId, itemId));
  });

  it('answers a revision with the same link', async () => {
    const revised = await post(`/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/revise`, {
      author: AGENT,
      headline: 'Which Harborlight link form should agents send to Alice?',
    });
    expect(path(revised.url as string)).toBe(itemHref(ws, taskId, itemId));
  });

  it('redirects review/<item id> to Home on that item', async () => {
    const got = await location(`/workspaces/${ws}/review/${itemId}`);
    expect(got.status).toBe(302);
    expect(got.location).toBe(itemHref(ws, taskId, itemId));
  });

  it('redirects review/<task id> to the task, and review/<doc id> to the doc', async () => {
    expect((await location(`/workspaces/${ws}/review/${taskId}`)).location).toBe(
      `/workspaces/${ws}?task=${taskId}`,
    );
    const doc = await location(`/workspaces/${ws}/reviews/${planDocId}`);
    expect(doc.status).toBe(302);
    expect(doc.location).toBe(`/workspaces/${ws}/docs/${planDocId}`);
  });

  it('refuses an item filed on another board, naming the whole address', async () => {
    const got = await location(`/workspaces/${ws}/review/${otherItemId}`);
    expect(got.status).toBe(404);
    expect(got.body).toContain(`/workspaces/${ws}/review/${otherItemId}`);
  });

  it('names the whole address on a not-found page under a board and for a missing board', async () => {
    const member = await location(`/workspaces/${ws}/review/r-nope?from=chat`);
    expect(member.status).toBe(404);
    expect(member.body).toContain(`/workspaces/${ws}/review/r-nope?from=chat`);
    // The chat panel's dead link: a relative `[url]` resolved against the board.
    const board = await location('/workspaces/%5Burl%5D');
    expect(board.status).toBe(404);
    expect(board.body).toContain('/workspaces/%5Burl%5D');
  });

  it('undoes an escaped query in a board path', async () => {
    const key = `task-review:${taskId}:${itemId}`;
    const escaped = encodeURIComponent(`home?item=${key}`);
    const got = await location(`/workspaces/${ws}/${escaped}`);
    expect(got.status).toBe(302);
    expect(got.location).toBe(`/workspaces/${ws}/home?item=${key}`);
    // Never off the board: a `..` in the unescaped path is not followed.
    const off = await location(`/workspaces/${ws}/${encodeURIComponent('../../api?x=1')}`);
    expect(off.status).toBe(404);
  });

  it('opens the doc a relative link names, from the doc it was written on or by its tail', async () => {
    const fromDoc = await location(
      `/workspaces/${ws}/open?path=${encodeURIComponent('./plan.md')}&from=harbor-index`,
    );
    expect(fromDoc.status).toBe(302);
    expect(fromDoc.location).toBe(`/workspaces/${ws}/docs/${planDocId}`);
    const byTail = await location(
      `/workspaces/${ws}/open?path=${encodeURIComponent('../../docs/notes/plan.md#top')}`,
    );
    expect(byTail.location).toBe(`/workspaces/${ws}/docs/${planDocId}`);
  });

  it('opens nothing for a path no doc has, or one several docs share, and names it', async () => {
    const none = await location(`/workspaces/${ws}/open?path=${encodeURIComponent('../nope.md')}`);
    expect(none.status).toBe(404);
    expect(none.body).toContain('open?path=');
    const many = await location(`/workspaces/${ws}/open?path=same.md`);
    expect(many.status).toBe(404);
    // The other board's docs are not this board's: a path only it has is none.
    const elsewhere = await location(`/workspaces/${otherWs}/open?path=plan.md`);
    expect(elsewhere.status).toBe(404);
  });

  it('opens a mock or doc link that names the wrong board under the board that holds it', async () => {
    // `attach_mockup` files on the agent's own board; the link names the
    // board the person is reading (9 Nov: "Nothing on this board answers to").
    const source = join(dataDir, 'saltmarsh-mock.html');
    writeFileSync(source, '<!doctype html><html><body><h1>Saltmarsh</h1></body></html>');
    const mockId = (
      (await post(`/workspaces/${otherWs}/docs`, {
        docId: 'saltmarsh-mock',
        type: 'mockup',
        sourceUrl: source,
      })) as { docId: string }
    ).docId;
    for (const name of ['saltmarsh-mock', mockId]) {
      const got = await location(`/workspaces/${ws}/mockups/${name}?thread=t-1`);
      expect(got.status, name).toBe(302);
      expect(got.location, name).toBe(`/workspaces/${otherWs}/mockups/${name}?thread=t-1`);
      // Positive control: the address it sends the reader to is the mock.
      const landed = await location(got.location ?? '');
      expect(landed.status, name).toBe(200);
    }
    const doc = await location(`/workspaces/${otherWs}/docs/${planDocId}`);
    expect(doc.location).toBe(`/workspaces/${ws}/docs/${planDocId}`);
  });

  it('still names the address when no board holds the id, and answers a JSON caller data', async () => {
    const none = await location(`/workspaces/${ws}/mockups/d-nowhere`);
    expect(none.status).toBe(404);
    expect(none.body).toContain(`/workspaces/${ws}/mockups/d-nowhere`);
    const json = await local(`/workspaces/${otherWs}/docs/${planDocId}?format=json`);
    expect(json.status).toBe(404);
    expect(json.headers.get('location')).toBeNull();
  });

  it('leaves a JSON caller and a write alone', async () => {
    const json = await local(`/workspaces/${ws}/review/${itemId}?format=json`);
    expect(json.status).toBe(404);
    expect(json.headers.get('content-type') ?? '').not.toContain('text/html');
    const write = await local(`/workspaces/${ws}/open?path=plan.md`, {
      method: 'POST',
      body: '{}',
    });
    expect(write.status).not.toBe(302);
  });
});
