/**
 * `machine:move-board` between two real servers on loopback, each on a
 * throwaway data dir. The source holds the board being moved (Harborlight)
 * and one that stays (Riverbend); the target already holds its own board
 * (Saltmarsh). The move goes through `moveBoard` with a loopback target in
 * place of the project machine: stop the target's server, import, boot it
 * again. Nothing leaves loopback; no Fly, Cloudflare or prod.
 *
 * The docs' files are moved away before the target boots, so what the target
 * answers can only have come from the bundle, as on a machine that never had
 * the Mac's repos.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MoveRefused,
  exportBoard,
  importBoard,
} from '../../../infra/project-machine/board-bundle.ts';
import { boardPrint, loopbackGet } from '../../../infra/project-machine/board-print.ts';
import { type MoveTarget, moveBoard } from '../../../infra/project-machine/move-board.ts';
import { waitFor } from './wait-for.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'cw-move-board-'));
const children: ChildProcess[] = [];

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error('no port from the probe server');
  return port;
}

interface Server {
  base: string;
  child: ChildProcess;
}

async function boot(dataDir: string): Promise<Server> {
  const port = await freePort();
  const child = spawn(
    'bun',
    [
      'run',
      join(repoRoot, 'packages', 'server', 'src', 'bin.ts'),
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--data-dir',
      dataDir,
    ],
    {
      cwd: repoRoot,
      stdio: 'ignore',
      env: { ...process.env, CW_SUMMARIES: '0', HOME: join(scratch, 'home') },
    },
  );
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      try {
        const res = await fetch(`${base}/api/deploy`, { headers: { host: `localhost:${port}` } });
        return res.status > 0 ? true : null;
      } catch {
        return null;
      }
    },
    { timeout: 30_000, interval: 100, describe: 'the server to answer on loopback' },
  );
  return { base, child };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill('SIGTERM');
  await exited;
}

function api(base: string) {
  const host = `localhost:${new URL(base).port}`;
  return async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { host, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
}

/** A target on this machine: the move stops it, imports, and boots it again. */
function loopbackTarget(dataDir: string, start: Server): MoveTarget & { server: () => Server } {
  let server = start;
  return {
    describe: 'the loopback target',
    server: () => server,
    async holds(boardId) {
      const res = await fetch(`${server.base}/workspaces/${boardId}?format=json`, {
        headers: { host: `localhost:${new URL(server.base).port}` },
      });
      return res.status === 200;
    },
    async importBundle(bundleDir) {
      await stop(server.child);
      importBoard(bundleDir, dataDir);
      server = await boot(dataDir);
    },
    print(boardId, limits) {
      return boardPrint(loopbackGet(server.base), dataDir, boardId, limits);
    },
  };
}

const DOCS = [
  {
    docId: 'harborlight-plan',
    file: 'plan.md',
    markdown: '# Harborlight plan\n\nThe ferry moves to spring.\n',
  },
  {
    docId: 'harborlight-notes',
    file: 'notes.md',
    markdown: '# Notes\n\nSaltmarsh survey on Thursday.\n',
  },
];

describe('machine:move-board', () => {
  const sourceDir = join(scratch, 'source');
  const targetDir = join(scratch, 'target');
  const repo = join(scratch, 'repo');
  let source: Server;
  let target: ReturnType<typeof loopbackTarget>;
  let boardId = '';
  let stayId = '';
  let keepId = '';
  const docIds: string[] = [];

  it('moves a board with its docs, threads, tasks and logs, and archives the source', async () => {
    mkdirSync(sourceDir);
    mkdirSync(targetDir);
    mkdirSync(repo);
    for (const d of DOCS) writeFileSync(join(repo, d.file), d.markdown);
    source = await boot(sourceDir);
    const src = api(source.base);
    boardId = (
      (await src('POST', '/workspaces', { name: 'Harborlight' })).workspace as { id: string }
    ).id;
    stayId = ((await src('POST', '/workspaces', { name: 'Riverbend' })).workspace as { id: string })
      .id;
    for (const d of DOCS) {
      const made = await src('POST', `/workspaces/${boardId}/docs`, {
        docId: d.docId,
        type: 'markdown',
        sourceUrl: join(repo, d.file),
        title: d.file,
      });
      docIds.push(String(made.docId));
    }
    const task = (
      await src('POST', `/workspaces/${boardId}/tasks`, {
        assignee: 'Alice',
        title: 'File the Saltmarsh survey',
      })
    ).task as { id: string };
    await src('PUT', `/workspaces/${boardId}/goals`, {
      author: 'Alice',
      goals: [{ title: 'Ship the ferry plan' }],
    });
    await src('POST', `/workspaces/${boardId}/docs/${docIds[0]}/threads/by_find`, {
      author: 'Alice',
      text: 'Is spring right?',
      find: 'The ferry moves',
    });
    await src('POST', `/workspaces/${boardId}/agents/harborlight-agent/notes`, {
      kind: 'status',
      text: 'Working on the Harborlight plan.',
    });
    await waitFor(
      () =>
        docIds.every((d) => existsSync(join(sourceDir, `${d}.ydoc`))) &&
        existsSync(join(sourceDir, 'workspaces', `${boardId}.events.jsonl`)) &&
        existsSync(join(sourceDir, 'workspaces', `${boardId}.agent-notes.jsonl`))
          ? true
          : null,
      { timeout: 15_000, describe: 'the docs and both logs on disk' },
    );

    const tgt = await boot(targetDir);
    keepId = (
      (await api(tgt.base)('POST', '/workspaces', { name: 'Saltmarsh' })).workspace as {
        id: string;
      }
    ).id;
    target = loopbackTarget(targetDir, tgt);

    // The target never had the Mac's repo.
    const lines: string[] = [];
    const moved = moveBoard({
      boardId,
      source: { dataDir: sourceDir, base: source.base },
      target: {
        ...target,
        importBundle: async (dir, id) => {
          renameSync(repo, `${repo}-away`);
          await target.importBundle(dir, id);
        },
      },
      log: (l) => lines.push(l),
    });
    const r = await moved;
    expect(lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.archived).toBe(true);
    // Every bound file comes back as a binding, for the sync.
    expect(r.manifest.bindings.map((b) => b.docId).sort()).toEqual([...docIds].sort());

    const t = api(target.server().base);
    const ws = (await t('GET', `/workspaces/${boardId}?format=json`)).workspace as {
      name: string;
      docIds: string[];
      goals: { title: string }[];
    };
    expect(ws.name).toBe('Harborlight');
    expect(ws.docIds.sort()).toEqual([...docIds].sort());
    expect(ws.goals.map((g) => g.title)).toEqual(['Ship the ferry plan']);
    const plan = await t('GET', `/workspaces/${boardId}/docs/${docIds[0]}/content`);
    expect(String(plan.plainText)).toContain('The ferry moves to spring.');
    const threads = (await t('GET', `/workspaces/${boardId}/docs/${docIds[0]}/threads`))
      .threads as {
      comments: { text: string }[];
    }[];
    expect(threads.map((th) => th.comments[0]?.text)).toEqual(['Is spring right?']);
    const tasks = (await t('GET', `/workspaces/${boardId}/tasks?format=json`)).tasks as {
      id: string;
    }[];
    expect(tasks.map((x) => x.id)).toEqual([task.id]);

    // No Mac path reached the target's data dir.
    const leaked = readdirSync(targetDir, { recursive: true, encoding: 'utf8' }).filter((p) => {
      const full = join(targetDir, p);
      try {
        return readFileSync(full, 'latin1').includes(repo);
      } catch {
        return false;
      }
    });
    expect(leaked).toEqual([]);
    // The target's own board is untouched.
    expect(
      ((await t('GET', `/workspaces/${keepId}?format=json`)).workspace as { name: string }).name,
    ).toBe('Saltmarsh');

    // The source board is archived, never removed, and the other board stays.
    const s = api(source.base);
    const archived = (await s('GET', `/workspaces/${boardId}?format=json`)).workspace as {
      retiredAt?: number;
    };
    expect(typeof archived.retiredAt).toBe('number');
    expect(existsSync(join(sourceDir, `${docIds[0]}.ydoc`))).toBe(true);
    const stay = (await s('GET', `/workspaces/${stayId}?format=json`)).workspace as {
      retiredAt?: number;
    };
    expect(stay.retiredAt).toBeUndefined();
  }, 120_000);

  it('refuses a target that already holds the board, and changes nothing', async () => {
    const before = readdirSync(targetDir).sort();
    await expect(
      moveBoard({
        boardId,
        source: { dataDir: sourceDir, base: source.base },
        target,
        log: () => {},
      }),
    ).rejects.toThrow(/already holds board/);
    expect(readdirSync(targetDir).sort()).toEqual(before);
    // The import itself refuses too, server or no server.
    const bundle = join(scratch, 'again');
    exportBoard(sourceDir, boardId, bundle);
    expect(() => importBoard(bundle, targetDir)).toThrow(MoveRefused);
  }, 60_000);

  it('does not archive the source when the target answers differently', async () => {
    const src = api(source.base);
    const id = (
      (await src('POST', '/workspaces', { name: 'Riverbend drift' })).workspace as {
        id: string;
      }
    ).id;
    await src('POST', `/workspaces/${id}/tasks`, {
      assignee: 'Bob',
      title: 'Chart the Riverbend tide',
    });
    const other = join(scratch, 'target-drift');
    mkdirSync(other);
    const drift = loopbackTarget(other, await boot(other));
    const lines: string[] = [];
    const r = await moveBoard({
      boardId: id,
      source: { dataDir: sourceDir, base: source.base },
      target: {
        ...drift,
        // A target that lost a task on the way.
        importBundle: async (dir, b) => {
          const rec = join(dir, 'files', 'workspaces', `${b}.tasks.json`);
          const parsed = JSON.parse(readFileSync(rec, 'utf8')) as { tasks: unknown[] };
          parsed.tasks = [];
          const copy = join(scratch, 'drift-bundle');
          cpSync(dir, copy, { recursive: true });
          writeFileSync(
            join(copy, 'files', 'workspaces', `${b}.tasks.json`),
            JSON.stringify(parsed),
          );
          // The altered file no longer matches its hash, so the import refuses it.
          await expect(drift.importBundle(copy, b)).rejects.toThrow(/altered/);
          await drift.importBundle(dir, b);
          // A task the source never had.
          await api(drift.server().base)('POST', `/workspaces/${b}/tasks`, {
            assignee: 'Bob',
            title: 'A Saltmarsh task the source never had',
          });
        },
      },
      log: (l) => lines.push(l),
    });
    expect(r.ok).toBe(false);
    expect(r.archived).toBe(false);
    const ws = (await src('GET', `/workspaces/${id}?format=json`)).workspace as {
      retiredAt?: number;
    };
    expect(ws.retiredAt).toBeUndefined();
  }, 120_000);
  it('does not archive the source when it changes while the target imports', async () => {
    const src = api(source.base);
    const id = (
      (await src('POST', '/workspaces', { name: 'Riverbend late edit' })).workspace as {
        id: string;
      }
    ).id;
    const taskId = (
      (await src('POST', `/workspaces/${id}/tasks`, { assignee: 'Bob', title: 'Sound the bar' }))
        .task as { id: string }
    ).id;
    const other = join(scratch, 'target-late');
    mkdirSync(other);
    const late = loopbackTarget(other, await boot(other));
    const lines: string[] = [];
    const r = await moveBoard({
      boardId: id,
      source: { dataDir: sourceDir, base: source.base },
      target: {
        ...late,
        importBundle: async (dir, b) => {
          await late.importBundle(dir, b);
          // A review item filed on the Mac after the export: no doc, thread or
          // task title changes, so only exporting again can see it.
          await src('POST', `/workspaces/${b}/tasks/${taskId}/review-items`, {
            review: {
              shape: 'decision',
              headline: 'Which Riverbend channel do we sound first?',
              options: [
                { id: 'o-1', label: 'The north channel' },
                { id: 'o-2', label: 'The south channel' },
              ],
            },
            author: { id: 'agent-riverbend', name: 'Riverbend', kind: 'agent' },
          });
          // The record is written on a debounce; a real import takes minutes.
          const record = join(sourceDir, 'workspaces', `${b}.tasks.json`);
          await waitFor(() => readFileSync(record, 'utf8').includes('Riverbend channel'));
        },
      },
      log: (l) => lines.push(l),
    });
    expect(r.archived).toBe(false);
    expect(r.ok).toBe(false);
    expect(lines.join('\n')).toMatch(/source changed during import: the board record/);
    const ws = (await src('GET', `/workspaces/${id}?format=json`)).workspace as {
      retiredAt?: number;
    };
    expect(ws.retiredAt).toBeUndefined();
  }, 120_000);
});
