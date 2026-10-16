/**
 * The project machine's backup is only worth what a restore gives back. This
 * builds a real data dir the way a board server writes one — a board and two
 * docs, through the REST routes — snapshots it with the machine's own
 * `backup.ts --out` (the upload swapped for a local file), restores it with
 * `restore.ts` into a fresh dir, boots a real loopback server there and reads
 * the board and both docs back.
 *
 * The docs' source files are moved away before the second boot, so what the
 * restored server answers can only have come from the restored corpus — the
 * case of a new machine whose repos are not cloned yet.
 *
 * Keys are generated inside the test. Nothing leaves loopback.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSnapshotKeys } from '../../../infra/project-machine/snapshot.ts';
import { waitFor } from './wait-for.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const machineDir = join(repoRoot, 'infra', 'project-machine');
const scratch = mkdtempSync(join(tmpdir(), 'cw-project-machine-'));
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

async function boot(dataDir: string): Promise<{ base: string; child: ChildProcess }> {
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
    { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, CW_SUMMARIES: '0' } },
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

function ydocsUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.ydoc'));
}

const DOCS = [
  {
    docId: 'harborlight-plan',
    file: 'harborlight-plan.md',
    markdown: '# Harborlight plan\n\nThe ferry timetable moves to the spring schedule.\n',
  },
  {
    docId: 'riverbend-notes',
    file: 'riverbend-notes.md',
    markdown: '# Riverbend notes\n\nSaltmarsh survey results arrive on Thursday.\n',
  },
];

describe('project machine backup and restore', () => {
  it('restores a board and its docs that a server on the restored dir reads back', async () => {
    const source = join(scratch, 'source-data');
    const notes = join(scratch, 'notes');
    mkdirSync(source);
    mkdirSync(notes);
    for (const d of DOCS) writeFileSync(join(notes, d.file), d.markdown);

    // A real server writes the data dir.
    const first = await boot(source);
    const call = api(first.base);
    const created = await call('POST', '/workspaces', { name: 'Harborlight' });
    const workspaceId = (created.workspace as { id: string }).id;
    // The server names each doc; the ids it hands back are what a restore
    // must preserve.
    const docIds = new Map<string, string>();
    for (const d of DOCS) {
      const made = await call('POST', `/workspaces/${workspaceId}/docs`, {
        docId: d.docId,
        type: 'markdown',
        sourceUrl: join(notes, d.file),
        title: d.file,
      });
      docIds.set(d.file, String(made.docId));
    }
    await waitFor(() => (ydocsUnder(source).length >= DOCS.length ? true : null), {
      timeout: 15_000,
      describe: 'both docs persisted to .ydoc',
    });
    await stop(first.child);

    // Snapshot to a local file, exactly as the machine's loop would before
    // uploading.
    const keys = generateSnapshotKeys();
    const identityFile = join(scratch, 'identity.key');
    writeFileSync(identityFile, `${keys.identity}\n`);
    chmodSync(identityFile, 0o600);
    const snapshot = join(scratch, 'snapshot.cwsnap');
    const backup = spawnSync('bun', [join(machineDir, 'backup.ts'), '--out', snapshot], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CW_DATA_DIR: source, BACKUP_RECIPIENT: keys.recipient },
    });
    expect(backup.stderr).toBe('');
    expect(backup.status).toBe(0);

    // A new machine: no source files, an empty data dir.
    renameSync(notes, join(scratch, 'notes-gone'));
    const restored = join(scratch, 'restored-data');
    const restore = spawnSync(
      'bun',
      [
        join(machineDir, 'restore.ts'),
        '--snapshot',
        snapshot,
        '--identity-file',
        identityFile,
        '--data-dir',
        restored,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(restore.stderr).toBe('');
    expect(restore.status).toBe(0);

    const second = await boot(restored);
    const read = api(second.base);
    const board = (await read('GET', `/workspaces/${workspaceId}?format=json`)) as {
      workspace?: { name?: string; docIds?: string[] };
    };
    expect(board.workspace?.name).toBe('Harborlight');
    expect([...(board.workspace?.docIds ?? [])].sort()).toEqual([...docIds.values()].sort());
    for (const d of DOCS) {
      const content = await read(
        'GET',
        `/workspaces/${workspaceId}/docs/${docIds.get(d.file)}/content`,
      );
      // The served plain text drops the markdown heading marker and the
      // trailing newline; every word of the doc must be there.
      expect(content.plainText).toBe(d.markdown.replace(/^# /, '').trimEnd());
    }
    await stop(second.child);
  }, 90_000);
});
