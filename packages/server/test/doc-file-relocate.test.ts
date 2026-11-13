/**
 * Moving a bound doc's file, and repointing a doc at a file git moved, over
 * the real route, a real repo and the real write-back.
 *
 * The first test proves the doc keeps its id, thread, reply, anchor and
 * backlink across a move and a restart, and that an anchored edit lands in the
 * moved file. The unflushed-edit tests make an edit in-process and call the
 * move in the same tick, so the edit is provably not on disk when the move
 * starts. Every refusal sits beside a success on the same server, so a
 * refusal cannot be a route that never ran.
 *
 * All fixtures synthetic (Harborlight, a fictional ferry project).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { relocateDocFile } from '../src/doc-file-relocate.ts';
import { makeDocKey } from '../src/doc-key.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { pastWriteBack, waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent:harborlight', name: 'Harborlight Agent', kind: 'agent' };

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A page holding the doc open: it syncs, and only listens. */
function openPage(url: string, origin: string) {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url, { headers: { origin } } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let synced: () => void = () => {};
  const ready = new Promise<void>((r) => {
    synced = r;
  });
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (type === syncProtocol.messageYjsSyncStep2) synced();
  });
  return { ydoc, ready, close: () => ws.close() };
}

describe('POST /workspaces/:ws/docs/:docId/move-file', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let outside: string;
  let WS = '';

  const send = (method: string, path: string, body?: unknown, headers: HeadersInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ok = async (res: Response): Promise<Record<string, unknown>> => {
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const docPath = (docId: string, rest = '') =>
    `/workspaces/${WS}/docs/${encodeURIComponent(docId)}${rest}`;
  const moveFile = (docId: string, path: unknown, mode: unknown, headers: HeadersInit = {}) =>
    send('POST', docPath(docId, '/move-file'), { path, mode }, headers);
  const bind = async (name: string, file: string): Promise<string> => {
    const created = await ok(
      await send('POST', `/workspaces/${WS}/docs`, {
        docId: name,
        type: 'markdown',
        sourceUrl: file,
        title: name,
      }),
    );
    return String((created.meta as { docId?: string } | undefined)?.docId ?? created.docId);
  };
  /** Append a paragraph in-process: the write-back is armed, not yet run. */
  const editLive = (docId: string, line: string) => {
    const doc = handle.docStore.get(docId);
    if (!doc) throw new Error('no doc');
    const fragment = prose.getProseFragment(doc.ydoc);
    const md = prose.serializeFragmentToMarkdown(fragment);
    doc.ydoc.transact(() => prose.applyMarkdownToFragment(fragment, `${md}\n${line}\n`));
  };

  beforeEach(async () => {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cw-relocate-data-')));
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'cw-relocate-repo-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'cw-relocate-outside-')));
    git(repo, 'init', '-q');
    writeFileSync(
      join(repo, 'dock-notes.md'),
      '---\nstatus: draft\n---\n\n# Dock notes\n\nThe pier needs amber lamps before winter.\n',
    );
    writeFileSync(join(repo, 'existing.md'), '# Existing\n');
    writeFileSync(join(repo, 'ferry.md'), '# Ferry\n\nThe Saltmarsh run leaves at nine.\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    handle = createServer({ port: 0, dataDir });
    WS = await seedBoard(`http://127.0.0.1:${handle.port}`, { name: 'Harborlight' });
  });

  afterEach(async () => {
    await handle.stop();
    for (const dir of [dataDir, repo, outside]) rmSync(dir, { recursive: true, force: true });
  });

  it('moves the file and keeps the id, thread, reply, anchor, backlink and front matter across a restart', async () => {
    const docId = await bind('dock-notes', join(repo, 'dock-notes.md'));
    const found = await ok(
      await send('POST', docPath(docId, '/threads/by_find'), {
        author: AGENT,
        text: 'Which supplier carries amber lamps?',
        find: 'amber lamps',
      }),
    );
    const threadId = String((found.thread as { id: string }).id);
    await ok(
      await send('POST', docPath(docId, `/threads/${threadId}/comments`), {
        author: AGENT,
        text: 'Riverbend Marine stocks them.',
      }),
    );
    const task = await ok(
      await send('POST', `/workspaces/${WS}/tasks`, {
        title: 'order the lamps',
        goal: 'chores',
        author: AGENT,
        body: 'Agent can order the lamps so that the pier is lit.',
        links: [{ kind: 'doc', docId }],
      }),
    );
    const taskId = String((task.task as { id: string }).id);

    const moved = await ok(await moveFile(docId, 'docs/harbour/dock-notes.md', 'move'));
    const file = join(repo, 'docs', 'harbour', 'dock-notes.md');
    expect(moved).toMatchObject({
      ok: true,
      docId,
      mode: 'move',
      path: file,
      previousPath: join(repo, 'dock-notes.md'),
      relPath: 'docs/harbour/dock-notes.md',
    });
    expect(existsSync(join(repo, 'dock-notes.md'))).toBe(false);
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).toContain('amber lamps');
    expect(onDisk.startsWith('---\nstatus: draft\n---')).toBe(true);
    // The repo+path address followed the file.
    const parts = handle.docStore.repos.primaryKeyFor(docId);
    expect(parts?.endsWith('docs/harbour/dock-notes.md')).toBe(true);
    // An open page learns of the move through the synced meta.
    expect(handle.docStore.get(docId)?.ydoc.getMap('meta').get('fileMovedAt')).toBeNumber();

    await handle.stop();
    handle = createServer({ port: 0, dataDir });

    const meta = (await ok(await send('GET', docPath(docId, '?format=json')))).meta as {
      sourceUrl?: string;
    };
    expect(meta.sourceUrl).toBe(file);
    const { threads } = (await ok(await send('GET', docPath(docId, '/threads')))) as {
      threads: Array<{ id: string; comments: unknown[]; anchor: { snippet?: { text: string } } }>;
    };
    const thread = threads.find((t) => t.id === threadId);
    expect(thread?.comments).toHaveLength(2);
    expect(thread?.anchor.snippet?.text).toBe('amber lamps');
    const back = (await ok(
      await send('POST', `/workspaces/${WS}/refs:backlinks`, { ref: { kind: 'doc', docId } }),
    )) as { tasks?: Array<{ id: string }> };
    expect(back.tasks?.map((t) => t.id)).toContain(taskId);

    await ok(
      await send('POST', docPath(docId, `/threads/${threadId}/rewrite_region`), {
        replacement: 'sodium lamps',
      }),
    );
    await waitFor(() => readFileSync(file, 'utf8').includes('sodium lamps'), {
      describe: 'the anchored edit reaching the moved file',
    });
    expect(existsSync(join(repo, 'dock-notes.md'))).toBe(false);
  });

  it('move: an edit not yet flushed when the move starts ends up in the moved file', async () => {
    const docId = await bind('ferry', join(repo, 'ferry.md'));
    editLive(docId, 'Harborlight adds a second boat on Fridays.');
    expect(readFileSync(join(repo, 'ferry.md'), 'utf8')).not.toContain('second boat');
    expect(handle.docStore.fileMoves.pendingWrite(docId)).toBe(true);

    const res = await relocateDocFile(
      { docStore: handle.docStore },
      { docId, path: 'schedules/ferry.md', mode: 'move' },
    );
    expect(res).toMatchObject({ ok: true, docId });
    const file = join(repo, 'schedules', 'ferry.md');
    expect(readFileSync(file, 'utf8')).toContain('second boat');
    expect(readFileSync(file, 'utf8')).toContain('Saltmarsh run');
    expect(existsSync(join(repo, 'ferry.md'))).toBe(false);
  });

  it('repoint: follows a git mv, carries an unflushed edit to the new path, and never recreates the old file', async () => {
    const docId = await bind('ferry', join(repo, 'ferry.md'));
    git(repo, 'mv', 'ferry.md', 'ferry-schedule.md');
    editLive(docId, 'Harborlight adds a second boat on Fridays.');

    const res = await relocateDocFile(
      { docStore: handle.docStore },
      { docId, path: join(repo, 'ferry-schedule.md'), mode: 'repoint' },
    );
    expect(res).toMatchObject({ ok: true, docId, mode: 'repoint' });
    const file = join(repo, 'ferry-schedule.md');
    expect(readFileSync(file, 'utf8')).toContain('second boat');

    // timed: past the write-back window, the old binding must not have written.
    await sleep(pastWriteBack());
    expect(existsSync(join(repo, 'ferry.md'))).toBe(false);
    expect(handle.docStore.boundPathOf(docId)).toBe(file);
  });

  it('repoint: an outside edit made to the moved file while the doc was idle is read in', async () => {
    const docId = await bind('ferry', join(repo, 'ferry.md'));
    git(repo, 'mv', 'ferry.md', 'ferry-schedule.md');
    const file = join(repo, 'ferry-schedule.md');
    writeFileSync(file, '# Ferry\n\nThe Saltmarsh run leaves at ten.\n');

    await ok(await moveFile(docId, 'ferry-schedule.md', 'repoint'));
    const doc = handle.docStore.get(docId);
    if (!doc) throw new Error('no doc');
    const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
    expect(md).toContain('leaves at ten');
  });

  it('tells a page already open on the doc that its file moved', async () => {
    const docId = await bind('ferry', join(repo, 'ferry.md'));
    const page = openPage(
      `ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/${docId}/y`,
      `http://localhost:${handle.port}`,
    );
    try {
      await page.ready;
      // CONTROL: the open page holds the doc, and no move yet.
      expect(page.ydoc.getMap('meta').get('docId')).toBe(docId);
      expect(page.ydoc.getMap('meta').get('fileMovedAt')).toBeUndefined();
      await ok(await moveFile(docId, 'timetables/ferry.md', 'move'));
      await waitFor(() => typeof page.ydoc.getMap('meta').get('fileMovedAt') === 'number', {
        describe: 'the move reaching the open page',
      });
      // The path itself stays out of the CRDT, which share visitors sync.
      expect(JSON.stringify(page.ydoc.getMap('meta').toJSON())).not.toContain(repo);
    } finally {
      page.close();
    }
  });

  it('refuses a target that exists and leaves both files as they were', async () => {
    const docId = await bind('ferry', join(repo, 'ferry.md'));
    const refused = await moveFile(docId, 'existing.md', 'move');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('target-exists');
    expect(readFileSync(join(repo, 'existing.md'), 'utf8')).toBe('# Existing\n');
    expect(existsSync(join(repo, 'ferry.md'))).toBe(true);
    await ok(await moveFile(docId, 'not-existing.md', 'move'));
  });

  it('refuses a path another doc is bound to', async () => {
    const docId = await bind('ferry', join(repo, 'ferry.md'));
    await bind('existing', join(repo, 'existing.md'));
    git(repo, 'mv', 'ferry.md', 'moved-ferry.md');
    const refused = await moveFile(docId, 'existing.md', 'repoint');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('path-held');
    await ok(await moveFile(docId, 'moved-ferry.md', 'repoint'));
  });

  it('refuses a path outside the repository, including through a symlink', async () => {
    const docId = await bind('ferry', join(repo, 'ferry.md'));
    symlinkSync(outside, join(repo, 'escape'));
    for (const path of [
      '../ferry.md',
      join(outside, 'ferry.md'),
      'escape/ferry.md',
      '.git/ferry.md',
    ]) {
      const res = await moveFile(docId, path, 'move');
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { error: string }).error, path).toBe('outside-root');
    }
    expect(existsSync(join(outside, 'ferry.md'))).toBe(false);
    expect(existsSync(join(repo, 'ferry.md'))).toBe(true);
    await ok(await moveFile(docId, 'inside/ferry.md', 'move'));
  });

  it('refuses a bad mode, a non-markdown path, and a repoint to a missing file', async () => {
    const docId = await bind('ferry', join(repo, 'ferry.md'));
    const cases: Array<[unknown, unknown, number, string]> = [
      ['moved.md', 'copy', 400, 'bad-mode'],
      ['moved.txt', 'move', 400, 'bad-path'],
      ['missing.md', 'repoint', 409, 'target-missing'],
    ];
    for (const [path, mode, status, error] of cases) {
      const res = await moveFile(docId, path, mode);
      expect(res.status, error).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
    expect(existsSync(join(repo, 'ferry.md'))).toBe(true);
  });

  it('refuses a browser, which may not decide where a file goes on the host', async () => {
    // The sign-in gate would refuse a browser write first, with its own
    // error. Off, so what refuses the move is the binding gate on the route.
    await handle.stop();
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const docId = await bind('ferry', join(repo, 'ferry.md'));
    const res = await moveFile(docId, 'moved.md', 'move', {
      origin: `http://127.0.0.1:${handle.port}`,
      'sec-fetch-site': 'same-origin',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('browser_cannot_bind');
    expect(existsSync(join(repo, 'ferry.md'))).toBe(true);
    await ok(await moveFile(docId, 'moved.md', 'move'));
  });

  it('holds a lead to the paths it may write', async () => {
    const docId = await bind('ferry', join(repo, 'ferry.md'));
    const rq = { docId, path: 'lead/ferry.md', mode: 'move' };
    const refused = await relocateDocFile(
      { docStore: handle.docStore },
      { ...rq, leadWritable: () => false },
    );
    expect(refused).toMatchObject({ ok: false, error: 'out-of-lead-scope' });
    expect(existsSync(join(repo, 'ferry.md'))).toBe(true);
    const allowed = await relocateDocFile(
      { docStore: handle.docStore },
      { ...rq, leadWritable: (p) => p.startsWith(`${repo}/`) },
    );
    expect(allowed).toMatchObject({ ok: true, docId });
    // A doc whose file is outside the lead's folders is not the lead's to move.
    const notTheLeads = await relocateDocFile(
      { docStore: handle.docStore },
      {
        docId,
        path: 'lead/ferry-2.md',
        mode: 'move',
        leadWritable: (p) => p === join(repo, 'lead', 'ferry-2.md'),
      },
    );
    expect(notTheLeads).toMatchObject({ ok: false, error: 'out-of-lead-scope' });
  });

  it('keeps a link to the old address opening the same doc', async () => {
    const docId = await bind('ferry', join(repo, 'ferry.md'));
    const repoKey = handle.docStore.repos.primaryKeyFor(docId)?.split('\u0000')[0] ?? '';
    await ok(await moveFile(docId, 'archive/ferry.md', 'move'));
    expect(handle.docStore.repos.docIdFor(makeDocKey(repoKey, 'ferry.md'))).toBe(docId);
    expect(handle.docStore.repos.docIdFor(makeDocKey(repoKey, 'archive/ferry.md'))).toBe(docId);
  });
});
