/**
 * The bound-file sync (`src/bound-file-sync/`) against a real server on
 * loopback standing in for the project machine. The board gets there the way
 * a real one does: built on a source server with its docs bound to files,
 * exported and imported (`machine:move-board`'s bundle), so the target holds
 * the docs with no binding at all. The sync then holds the binding from this
 * side with a board agent token minted on the target, as the Mac would.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportBoard, importBoard } from '../../../infra/project-machine/board-bundle.ts';
import { startBoardSync } from '../src/bound-file-sync/board-sync.ts';
import { loadSyncConfig, parseSyncConfig } from '../src/bound-file-sync/sync-config.ts';
import { waitFor } from './wait-for.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'cw-bound-sync-'));
const children: ChildProcess[] = [];
const stops: (() => void)[] = [];

afterAll(() => {
  for (const s of stops) s();
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

async function boot(dataDir: string): Promise<{ base: string; child: ChildProcess }> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  const child = spawn(
    'bun',
    [
      'run',
      join(repoRoot, 'packages/server/src/bin.ts'),
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
        return (await fetch(`${base}/api/deploy`, { headers: { host: `localhost:${port}` } }))
          .status > 0
          ? true
          : null;
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

const PLAN =
  '# Harborlight plan\n\nThe ferry moves to spring.\n\nThe Saltmarsh survey is on Thursday.\n';

describe('bound-file sync', () => {
  const repo = join(scratch, 'repo');
  const planPath = join(repo, 'plan.md');
  const stateDir = join(scratch, 'state');
  let base = '';
  let boardId = '';
  let otherBoard = '';
  let docId = '';
  let token = '';
  let call: ReturnType<typeof api>;

  const content = async () =>
    String((await call('GET', `/workspaces/${boardId}/docs/${docId}/content`)).plainText);
  const sync = (boardToken: string, extra: Partial<{ pollMs: number }> = {}) => {
    const s = startBoardSync({
      config: {
        baseUrl: base,
        workspaceId: boardId,
        boardToken,
        access: null,
        docs: [{ docId, path: planPath }],
      },
      stateDir,
      log: () => {},
      writeDelayMs: 50,
      pollMs: extra.pollMs ?? 50,
    });
    stops.push(s.stop);
    return s;
  };

  it('starts from a moved board and writes nothing when the file already matches', async () => {
    mkdirSync(repo);
    writeFileSync(planPath, PLAN);
    const sourceDir = join(scratch, 'source');
    const targetDir = join(scratch, 'target');
    mkdirSync(sourceDir);
    const src = await boot(sourceDir);
    const s = api(src.base);
    boardId = (
      (await s('POST', '/workspaces', { name: 'Harborlight' })).workspace as { id: string }
    ).id;
    docId = String(
      (
        await s('POST', `/workspaces/${boardId}/docs`, {
          docId: 'plan',
          type: 'markdown',
          sourceUrl: planPath,
          title: 'Plan',
        })
      ).docId,
    );
    await s('POST', `/workspaces/${boardId}/docs/${docId}/threads/by_find`, {
      author: 'Alice',
      text: 'Spring?',
      find: 'The ferry moves',
    });
    await waitFor(() => (existsSync(join(sourceDir, `${docId}.ydoc`)) ? true : null), {
      timeout: 15_000,
      describe: 'the .ydoc',
    });
    await stop(src.child);
    exportBoard(sourceDir, boardId, join(scratch, 'bundle'));
    importBoard(join(scratch, 'bundle'), targetDir);
    const tgt = await boot(targetDir);
    base = tgt.base;
    call = api(base);
    otherBoard = (
      (await call('POST', '/workspaces', { name: 'Riverbend' })).workspace as { id: string }
    ).id;
    token = String(
      (
        await call('POST', '/api/board-tokens', {
          agentId: 'harborlight-sync',
          boardId,
          label: 'sync',
        })
      ).token,
    );

    const before = readFileSync(planPath, 'utf8');
    const s1 = sync(token);
    await s1.ready;
    await waitFor(() => (s1.synced() ? true : null), {
      timeout: 10_000,
      describe: 'the first sync',
    });
    expect(readFileSync(planPath, 'utf8')).toBe(before);
    expect(existsSync(join(stateDir, 'replaced'))).toBe(false);
    // The state file holds the renewed token, owner-only.
    expect(readdirSync(stateDir)).toContain(`${boardId}.json`);
  }, 90_000);

  it('writes a remote edit into the file, and sends a file edit to the doc', async () => {
    await call('POST', `/workspaces/${boardId}/docs/${docId}/find_and_replace`, {
      find: 'Thursday',
      replace: 'Friday',
      author: 'Bob',
    });
    await waitFor(() => (readFileSync(planPath, 'utf8').includes('Friday') ? true : null), {
      timeout: 10_000,
      describe: 'the remote edit in the file',
    });
    writeFileSync(planPath, readFileSync(planPath, 'utf8').replace('Friday', 'Saturday'));
    await waitFor(async () => ((await content()).includes('Saturday') ? true : null), {
      timeout: 10_000,
      describe: 'the file edit in the doc',
    });
    // The thread on the paragraph nobody touched keeps its anchor.
    const threads = (await call('GET', `/workspaces/${boardId}/docs/${docId}/threads`)).threads as {
      status: string;
      anchor: { snippet?: { text?: string } };
    }[];
    expect(threads.map((t) => [t.status, t.anchor.snippet?.text])).toEqual([
      ['open', 'The ferry moves'],
    ]);
    for (const s of stops.splice(0)) s();
  }, 60_000);

  // A file edit reaches the doc over its editing socket, so the server's
  // stale-write guard reads it as a person's edit; the REST edits below say
  // they mean to replace it.
  it('after a restart, takes the side that moved while it was off', async () => {
    // Only the file moved: the file wins.
    writeFileSync(planPath, readFileSync(planPath, 'utf8').replace('spring', 'summer'));
    const s2 = sync(token);
    await s2.ready;
    await waitFor(async () => ((await content()).includes('summer') ? true : null), {
      timeout: 10_000,
      describe: 'file wins',
    });
    for (const s of stops.splice(0)) s();
    // Only the doc moved: the file follows.
    await call('POST', `/workspaces/${boardId}/docs/${docId}/find_and_replace`, {
      find: 'Saturday',
      replace: 'Sunday',
      author: 'Bob',
      confirmOverwriteHumanEdits: true,
    });
    const s3 = sync(token);
    await s3.ready;
    await waitFor(() => (readFileSync(planPath, 'utf8').includes('Sunday') ? true : null), {
      timeout: 10_000,
      describe: 'doc wins',
    });
    for (const s of stops.splice(0)) s();
    // Both moved: the doc wins, and the file it replaced is kept.
    await call('POST', `/workspaces/${boardId}/docs/${docId}/find_and_replace`, {
      find: 'Sunday',
      replace: 'Monday',
      author: 'Bob',
      confirmOverwriteHumanEdits: true,
    });
    writeFileSync(planPath, `${readFileSync(planPath, 'utf8')}\nA Riverbend line.\n`);
    const s4 = sync(token);
    await s4.ready;
    await waitFor(() => (readFileSync(planPath, 'utf8').includes('Monday') ? true : null), {
      timeout: 10_000,
      describe: 'both: doc wins',
    });
    const kept = readdirSync(join(stateDir, 'replaced'));
    expect(kept.length).toBe(1);
    expect(readFileSync(join(stateDir, 'replaced', kept[0] ?? ''), 'utf8')).toContain(
      'A Riverbend line.',
    );
    for (const s of stops.splice(0)) s();
  }, 60_000);

  it('a token for another board reaches nothing, and the file is left alone', async () => {
    const wrong = String(
      (
        await call('POST', '/api/board-tokens', {
          agentId: 'riverbend-sync',
          boardId: otherBoard,
          label: 'sync',
        })
      ).token,
    );
    const before = readFileSync(planPath, 'utf8');
    rmSync(stateDir, { recursive: true, force: true });
    const s5 = sync(wrong);
    await s5.ready;
    await call('POST', `/workspaces/${boardId}/docs/${docId}/find_and_replace`, {
      find: 'Monday',
      replace: 'Tuesday',
      author: 'Bob',
      confirmOverwriteHumanEdits: true,
    });
    // The right token, as a positive control, syncs the same edit.
    const control = join(scratch, 'control.md');
    writeFileSync(control, before);
    const ok = startBoardSync({
      config: {
        baseUrl: base,
        workspaceId: boardId,
        boardToken: token,
        access: null,
        docs: [{ docId, path: control }],
      },
      stateDir: join(scratch, 'state-control'),
      log: () => {},
      writeDelayMs: 50,
      pollMs: 50,
    });
    stops.push(ok.stop);
    await waitFor(() => (readFileSync(control, 'utf8').includes('Tuesday') ? true : null), {
      timeout: 10_000,
      describe: 'the control',
    });
    expect(s5.synced()).toBe(false);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
  }, 60_000);
});

describe('bound-file sync config', () => {
  const secret = (s: string) => (s === 'tok' ? 'at2.x.y.z.1.m' : 'sekrit');
  const good = {
    baseUrl: 'https://harborlight-workspaces.example.com',
    workspaceId: 'w-Harbor1',
    enabled: true,
    auth: { boardTokenService: 'tok', accessClientId: 'abc.access', accessSecretService: 'acc' },
    docs: [{ docId: 'd-plan', path: '/repo/plan.md' }],
  };
  it('is off unless it says enabled', () => {
    expect(parseSyncConfig(JSON.stringify({ ...good, enabled: false }), secret)).toBeNull();
    expect(parseSyncConfig(JSON.stringify({ ...good, enabled: undefined }), secret)).toBeNull();
  });
  it('refuses paths and hosts it should not write or call', () => {
    const bad = (patch: object) => parseSyncConfig(JSON.stringify({ ...good, ...patch }), secret);
    expect(bad({ docs: [{ docId: 'd-plan', path: 'plan.md' }] })).toHaveProperty('error');
    expect(bad({ docs: [{ docId: 'd-plan', path: '/repo/../etc/x.md' }] })).toHaveProperty('error');
    expect(bad({ docs: [{ docId: 'd-plan', path: '/repo/plan.sh' }] })).toHaveProperty('error');
    expect(bad({ docs: [{ docId: 'task:t-1', path: '/repo/plan.md' }] })).toHaveProperty('error');
    expect(bad({ baseUrl: 'http://harborlight.example.com' })).toHaveProperty('error');
    expect(bad({ auth: { boardTokenService: 'tok' } })).toHaveProperty('error');
    expect(parseSyncConfig(JSON.stringify(good), secret)).toMatchObject({
      workspaceId: 'w-Harbor1',
    });
  });
  it('refuses a config file others can write', () => {
    const p = join(scratch, 'sync.json');
    writeFileSync(p, JSON.stringify(good));
    chmodSync(p, 0o666);
    expect(loadSyncConfig(p, secret)).toHaveProperty('error');
    chmodSync(p, 0o600);
    expect(loadSyncConfig(p, secret)).toMatchObject({ workspaceId: 'w-Harbor1' });
  });
});
