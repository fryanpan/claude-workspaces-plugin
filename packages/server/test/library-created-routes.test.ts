/**
 * Which Library rows carry a created time, through the real routes against a
 * real git repo.
 *
 * Recently Created lists what the board made. A doc that only binds a project
 * file that was already on disk made nothing: its record is new, but the
 * content is not. So it carries no created time, whichever door bound it, and
 * however recent the file's birth time is. Every file in this repo is written
 * by `beforeEach`, so each one's birth time is seconds old, which is what a
 * `git pull` or a fresh clone leaves behind.
 *
 * The positive controls are on the same server: a new whiteboard, and a doc
 * whose file the server wrote, both carry one.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LibraryPayload } from '../src/library.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

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

describe('library created time', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let WS = '';

  const at = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
    });
  const rowNamed = async (name: string) => {
    const res = await at(`/workspaces/${WS}/library/items`);
    expect(res.status).toBe(200);
    return ((await res.json()) as LibraryPayload).files.find((f) => f.name === name);
  };
  /** The doc id the server minted for the bind. */
  const bindDoc = async (docId: string, path: string, title: string): Promise<string> => {
    const res = await at(`/workspaces/${WS}/docs`, {
      method: 'POST',
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: path, title }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { docId: string }).docId;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'library-created-data-'));
    repo = mkdtempSync(join(tmpdir(), 'library-created-repo-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'handbook.md'), '# Volunteer handbook\n');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'tide-gauge.md'), '# Tide gauge\n');
    writeFileSync(join(repo, 'docs', 'blank.md'), '');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    handle = createServer({ port: 0, dataDir });
    WS = await seedBoard(`http://127.0.0.1:${handle.port}`);
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('gives no created time to a project file opened from the Library', async () => {
    // A bound doc is what names the board's project, so its files list.
    await bindDoc('handbook', join(repo, 'handbook.md'), 'Volunteer handbook');
    expect((await rowNamed('tide-gauge.md'))?.open).toBe('docs/tide-gauge.md');
    const opened = await at(`/workspaces/${WS}/library/open`, {
      method: 'POST',
      body: JSON.stringify({ path: 'docs/tide-gauge.md' }),
    });
    expect(opened.status).toBe(200);
    const { docId } = (await opened.json()) as { docId: string };
    const row = await rowNamed('tide-gauge.md');
    // Positive control: the row is the doc now, so the created rule saw it.
    expect(row?.docId).toBe(docId);
    expect(row?.created).toBeUndefined();
  });

  it('gives no created time to an existing EMPTY file opened from the Library', async () => {
    // Nothing to seed from, but the file was there before the board.
    await bindDoc('handbook', join(repo, 'handbook.md'), 'Volunteer handbook');
    const opened = await at(`/workspaces/${WS}/library/open`, {
      method: 'POST',
      body: JSON.stringify({ path: 'docs/blank.md' }),
    });
    expect(opened.status).toBe(200);
    const { docId } = (await opened.json()) as { docId: string };
    const row = await rowNamed('blank.md');
    expect(row?.docId).toBe(docId);
    expect(row?.created).toBeUndefined();
  });

  it('gives no created time to a doc that binds a file already on disk', async () => {
    const docId = await bindDoc('handbook', join(repo, 'handbook.md'), 'Volunteer handbook');
    const row = await rowNamed('handbook.md');
    expect(row?.docId).toBe(docId);
    expect(row?.created).toBeUndefined();
  });

  it('keeps it off after a restart re-reads the doc from its record', async () => {
    const docId = await bindDoc('handbook', join(repo, 'handbook.md'), 'Volunteer handbook');
    // The record is written behind the bind; wait for it before stopping.
    await waitFor(() => existsSync(join(dataDir, `${docId}.private.json`)));
    await handle.stop();
    handle = createServer({ port: 0, dataDir });
    const row = await rowNamed('handbook.md');
    expect(row?.docId).toBe(docId);
    expect(row?.created).toBeUndefined();
  });

  it('gives a created time to what the board made: a whiteboard and a new file', async () => {
    const made = await at(`/workspaces/${WS}/whiteboards`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Ferry flow' }),
    });
    expect(made.status).toBe(200);
    expect((await rowNamed('Ferry flow'))?.created).toBeGreaterThan(0);

    const fresh = join(repo, 'docs', 'harbour-plan.md');
    expect(existsSync(fresh)).toBe(false);
    const docId = await bindDoc('harbour-plan', fresh, 'Harbour plan');
    const row = await rowNamed('harbour-plan.md');
    expect(row?.docId).toBe(docId);
    expect(row?.created).toBeGreaterThan(0);
  });
});
