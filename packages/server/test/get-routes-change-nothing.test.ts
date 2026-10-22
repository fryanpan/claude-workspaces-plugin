/**
 * The route audit: no GET changes what the server stores.
 *
 * A GET is what a link preview, a prefetch, a crawler and an `<img src>` send
 * without anybody choosing to, and what CORS lets any page fire at this
 * server. So a GET that writes is a write nobody asked for, and a write a
 * page on another origin can make. Every row of the route table that answers
 * GET is called here, against a server holding a real board, task, doc,
 * thread and mockup whose ids are substituted into the row's pattern, and
 * then the data dir and the bound file are compared, byte for byte, with what
 * they held before.
 *
 * What is not compared is listed in `NOT_STATE`, each with why reading it
 * back is not reading a change somebody made. A new GET that writes anything
 * else fails here, naming the route.
 *
 * What it cannot see: a GET whose write needs a query parameter the pattern
 * does not carry, a write held in memory and never persisted, and a route
 * the example ids do not reach (an id this file did not seed answers 404
 * before any handler runs).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ROUTE_TABLE } from '../src/routes/route-table-rows.ts';
import { exampleFor } from '../src/routes/route-table.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { pastWriteBack, waitFor, waitForFile } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/** Files a GET may write, and why each is not state somebody changed. */
const NOT_STATE: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^[^/]+:[^/]+\.(ydoc|index\.json|private\.json)$/,
    'A folder member opened for the first time. Its id is `<setId>:<relPath>`, the only ids with a colon, and its doc is made from the file the folder already lists, so the open records what was on disk rather than anything a caller chose (`openUnopenedMember`, `routes/request-chain.ts`).',
  ],
];

function fingerprint(roots: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (root: string, dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(root, abs);
      else {
        const rel = `${root === roots[0] ? '' : 'file:'}${relative(root, abs)}`;
        if (NOT_STATE.some(([re]) => re.test(rel))) continue;
        out.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'));
      }
    }
  };
  for (const r of roots) walk(r, r);
  return out;
}

function changes(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of after) if (before.get(k) !== v) out.push(before.has(k) ? `~${k}` : `+${k}`);
  for (const k of before.keys()) if (!after.has(k)) out.push(`-${k}`);
  return out.sort();
}

describe('the route audit: no GET route changes state', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let fileDir: string;
  let base: string;
  const ids: Record<string, string> = {};

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status, `${path} ${await res.clone().text()}`).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'get-audit-data-'));
    fileDir = mkdtempSync(join(tmpdir(), 'get-audit-files-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ids.ws = await seedBoard(base, { name: 'Harborlight' });
    const md = join(fileDir, 'riverbend.md');
    writeFileSync(md, '# Riverbend\n\nA paragraph to comment on.\n');
    const doc = await post(`/workspaces/${ids.ws}/docs`, {
      docId: 'riverbend',
      type: 'markdown',
      sourceUrl: md,
    });
    ids.docId = String(doc.docId);
    const mock = join(fileDir, 'saltmarsh.html');
    writeFileSync(mock, '<!doctype html><html><body><h1>Saltmarsh</h1></body></html>');
    await post(`/workspaces/${ids.ws}/docs`, {
      docId: 'saltmarsh',
      type: 'mockup',
      sourceUrl: mock,
    });
    const thread = await post(`/workspaces/${ids.ws}/docs/${ids.docId}/threads`, {
      anchor: { kind: 'subject' },
      text: 'A question for Alice.',
      author: { id: 'agent-bob', name: 'Bob', kind: 'agent' },
    });
    ids.threadId = String((thread.thread as { id: string }).id);
    const task = await post(`/workspaces/${ids.ws}/tasks`, {
      title: 'Agent can check the audit so that no GET writes',
      author: { id: 'agent-bob', name: 'Bob', kind: 'agent' },
      owner: 'Bob',
    });
    ids.taskId = String((task.task as { id: string }).id);
    const folder = join(fileDir, 'folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'README.md'), '# Harborlight folder\n');
    writeFileSync(join(folder, 'notes.md'), '# Notes nobody opened\n');
    const bound = await post('/workspaces', { folderPath: folder, hubWorkspaceId: ids.ws });
    ids.setId = String(bound.workspaceId);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fileDir, { recursive: true, force: true });
  });

  /** The row's pattern with this file's ids where it has them. */
  const pathFor = (pattern: string): string =>
    exampleFor(
      pattern
        .split('/')
        .map((seg) => (seg.startsWith(':') && ids[seg.slice(1)] ? ids[seg.slice(1)] : seg))
        .join('/'),
    );

  it('leaves the data dir and the bound file as they were', async () => {
    // The task store saves on its own 200ms debounce, unscaled and longer
    // than the write-back window below, so wait for its file first.
    await waitForFile(join(dataDir, 'workspaces', `${ids.ws}.tasks.json`), (t) =>
      t.includes(ids.taskId ?? ''),
    );
    // Settle the seeding's own debounced writes before the snapshot: two
    // fingerprints a write-back apart that agree.
    const before = await waitFor(
      async () => {
        const a = fingerprint([dataDir, fileDir]);
        // timed: one write-back window, the debounce the seeding can still be inside.
        await new Promise((r) => setTimeout(r, pastWriteBack()));
        const b = fingerprint([dataDir, fileDir]);
        return changes(a, b).length === 0 ? b : false;
      },
      { describe: 'the seeded server to stop writing' },
    );
    const paths = ROUTE_TABLE.filter((e) => e.methods.includes('GET') && e.pattern !== '*').map(
      (e) => pathFor(e.pattern),
    );
    // Addresses a pattern does not spell: the query a read carries, and a
    // folder member nobody has opened yet.
    paths.push(
      `/workspaces/${ids.ws}/docs/${ids.docId}/content?reader=agent-bob`,
      `/workspaces/${ids.ws}/docs/${ids.docId}?format=json`,
      `/workspaces/${ids.ws}/mockups/saltmarsh?cw-frame=1`,
      `/workspaces/${ids.ws}/docs/${encodeURIComponent(`${ids.setId}:notes.md`)}?format=json`,
    );
    const called: string[] = [];
    for (const path of paths) {
      const ctl = new AbortController();
      // A deadline, not a wait: a stream answers headers and then holds.
      const deadline = setTimeout(() => ctl.abort(), 1500);
      try {
        const res = await fetch(`${base}${path}`, { signal: ctl.signal });
        await res.body?.cancel();
        called.push(`${res.status} ${path}`);
      } catch {
        called.push(`aborted ${path}`);
      } finally {
        clearTimeout(deadline);
      }
    }
    // timed: one write-back window, so a GET's debounced write has landed.
    await new Promise((r) => setTimeout(r, pastWriteBack()));
    const after = fingerprint([dataDir, fileDir]);
    expect(changes(before, after), called.join('\n')).toEqual([]);
    // The audit reached real handlers, not a wall of 404s: the seeded doc,
    // its thread list and the board each answered.
    expect(called).toContain(`200 /workspaces/${ids.ws}/docs/${ids.docId}/threads`);
    expect(called).toContain(`200 /workspaces/${ids.ws}/tasks`);
  }, 120_000);

  it('positive control: the fingerprint sees a write', async () => {
    const before = fingerprint([dataDir, fileDir]);
    await post(`/workspaces/${ids.ws}/tasks`, {
      title: 'Agent can see a write so that the audit is not blind',
      author: { id: 'agent-bob', name: 'Bob', kind: 'agent' },
      owner: 'Bob',
    });
    const after = await waitFor(
      () => {
        const now = fingerprint([dataDir, fileDir]);
        return changes(before, now).length > 0 ? now : false;
      },
      { describe: 'a task create to reach the data dir' },
    );
    expect(changes(before, after).length).toBeGreaterThan(0);
  });
});
