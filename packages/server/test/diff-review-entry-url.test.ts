/**
 * `create_diff_review` always answers with a URL that opens the review.
 *
 * An agent hands `entryUrl` to a person. When it was missing the agent sent
 * the board's home link instead, and the person had to find the review
 * themselves. It went missing because the member URLs were minted BEFORE the
 * review was filed on its board, and a doc no board holds has no address: a
 * first bind of any review answered without one, and only a re-run (by then
 * filed) had it.
 *
 * Each case asserts the URL is absolute, names the board in the path, and
 * resolves to a page — following the server's own redirect, so "opens the
 * review" is measured rather than assumed.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
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

interface DiffResponse {
  reviewId: string;
  entryUrl?: string;
  url?: string;
  files: Array<{ docId: string; reviewUrl?: string }>;
}

/** The server's public base: every URL handed out must use it, never localhost. */
const PUBLIC = 'https://harborlight.example';

describe('create_diff_review answers with a URL that opens the review', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let repo: string;
  let repoBase: string;
  let repoHead: string;
  let folder: string;
  let WS = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** The URL a person would click, read back through this server. */
  const opens = async (url: string | undefined): Promise<number> => {
    expect(url).toBeTruthy();
    const parsed = new URL(url as string);
    expect(parsed.origin).toBe(PUBLIC);
    expect(parsed.pathname.startsWith(`/workspaces/${WS}/`)).toBe(true);
    const r = await fetch(`${base}${parsed.pathname}`, {
      headers: { host: `localhost:${handle.port}`, accept: 'text/html' },
    });
    return r.status;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'deu-data-'));
    repo = mkdtempSync(join(tmpdir(), 'deu-repo-'));
    git(repo, 'init', '-q');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    repoBase = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 2;\n');
    git(repo, 'commit', '-q', '-am', 'head');
    repoHead = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 3;\n');

    folder = mkdtempSync(join(tmpdir(), 'deu-folder-'));
    writeFileSync(join(folder, 'README.md'), '# Harborlight\n\nRead me.\n');

    // A built app shell, so a doc page answers 200 rather than falling through.
    const appDist = join(dataDir, 'app-dist');
    mkdirSync(appDist);
    writeFileSync(join(appDist, 'index.html'), '<!--shell-->\n');
    writeFileSync(join(appDist, 'app.js'), '//app\n');
    handle = createServer({ port: 0, dataDir, markdownAppDistDir: appDist, publicBaseUrl: PUBLIC });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('a working-tree diff, on its first bind', async () => {
    const r = await post(`/workspaces/${WS}/attachments`, { repo, base: repoBase });
    expect(r.status).toBe(200);
    const body = (await r.json()) as DiffResponse;
    expect(body.files.length).toBeGreaterThan(0);
    expect(await opens(body.entryUrl)).toBe(200);
    expect(body.url).toBe(body.entryUrl);
    for (const f of body.files) expect(f.reviewUrl).toBeTruthy();
  });

  it('a pinned range, on its first bind', async () => {
    const r = await post(`/workspaces/${WS}/attachments`, {
      repo,
      base: repoBase,
      target: repoHead,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as DiffResponse;
    expect(await opens(body.entryUrl)).toBe(200);
  });

  it('a folder browse, on its first bind', async () => {
    const r = await post(`/workspaces/${WS}/attachments`, { repo: folder });
    expect(r.status).toBe(200);
    const body = (await r.json()) as DiffResponse;
    expect(await opens(body.entryUrl)).toBe(200);
  });

  it('a re-run with the same reviewId', async () => {
    const first = await post(`/workspaces/${WS}/attachments`, {
      repo,
      base: repoBase,
      reviewId: 'deu-rerun',
    });
    expect(first.status).toBe(200);
    const again = await post(`/workspaces/${WS}/attachments`, {
      repo,
      base: repoBase,
      reviewId: 'deu-rerun',
    });
    expect(again.status).toBe(200);
    const body = (await again.json()) as DiffResponse;
    expect(await opens(body.entryUrl)).toBe(200);
  });

  it('a diff whose every file was skipped still opens the review', async () => {
    // Only a binary file changed: the bind succeeds with no member to land on.
    const bin = mkdtempSync(join(tmpdir(), 'deu-bin-'));
    try {
      git(bin, 'init', '-q');
      writeFileSync(join(bin, 'keep.txt'), 'x\n');
      git(bin, 'add', '-A');
      git(bin, 'commit', '-q', '-m', 'base');
      const b = git(bin, 'rev-parse', 'HEAD');
      writeFileSync(join(bin, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
      git(bin, 'add', '-A');
      const r = await post(`/workspaces/${WS}/attachments`, { repo: bin, base: b });
      expect(r.status).toBe(200);
      const body = (await r.json()) as DiffResponse;
      expect(body.files).toHaveLength(0);
      expect(body.entryUrl).toBeTruthy();
      const parsed = new URL(body.entryUrl as string);
      expect(parsed.origin).toBe(PUBLIC);
      expect(parsed.pathname).toBe(
        `/workspaces/${WS}/attachments/${encodeURIComponent(body.reviewId)}`,
      );
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
