/**
 * A diff review is ONE item in a board's Library: one row in Recently
 * Created, which opens the review's entry page; one entry in a person's
 * Recently Viewed when they open it; one star.
 *
 * All fixtures synthetic. Port 0, temp data dirs and a temp git repo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LibraryPayload } from '../src/library.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

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

describe('diff reviews in the Library', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let repoBase: string;
  let base: string;
  let WS = '';
  const host = { host: 'localhost' };
  const browser = () => ({ ...host, origin: base, 'sec-fetch-site': 'same-origin' });
  const post = async (path: string, body: unknown, headers: Record<string, string> = host) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const items = async (viewer = ''): Promise<LibraryPayload> =>
    (await (
      await fetch(`${base}/workspaces/${WS}/library/items?viewer=${viewer}`, { headers: host })
    ).json()) as LibraryPayload;
  const makeDiff = async (): Promise<{ reviewId: string; memberIds: string[] }> => {
    const r = await post(`/workspaces/${WS}/attachments`, { repo, base: repoBase });
    expect(r.status).toBe(200);
    const files = r.body.files as Array<{ docId: string }>;
    return { reviewId: r.body.reviewId as string, memberIds: files.map((f) => f.docId) };
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'library-diff-'));
    repo = mkdtempSync(join(tmpdir(), 'library-diff-repo-'));
    git(repo, 'init', '-q');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    repoBase = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 2;\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base, { name: 'Harborlight' });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('lists a new diff review as one row that opens its entry page', async () => {
    const { reviewId, memberIds } = await makeDiff();
    expect(memberIds.length).toBe(2);
    const files = (await items()).files;
    const rows = files.filter((f) => f.docId === reviewId);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.name).toBe(`Diff: ${reviewId}`);
    expect(row?.href).toBe(`/workspaces/${WS}/attachments/${reviewId}`);
    expect(typeof row?.created).toBe('number');
    // Never a row per changed file.
    expect(files.some((f) => f.docId !== undefined && memberIds.includes(f.docId))).toBe(false);
    // The row's address leads to one of the review's files.
    const open = await fetch(`${base}${row?.href}`, {
      headers: { ...host, accept: 'text/html' },
      redirect: 'manual',
    });
    expect(open.status).toBe(302);
    const to = open.headers.get('location') ?? '';
    expect(memberIds.some((id) => to.includes(`/docs/${encodeURIComponent(id)}`))).toBe(true);
  });

  it('lists a folder browse not at all', async () => {
    const r = await post(`/workspaces/${WS}/attachments`, { repo });
    expect(r.status).toBe(200);
    const id = r.body.reviewId as string;
    expect((await items()).files.some((f) => f.docId === id)).toBe(false);
  });

  it('puts a person’s opening of a diff in their Recently Viewed', async () => {
    const { reviewId } = await makeDiff();
    const v = await post(
      `/workspaces/${WS}/library/views`,
      { docId: reviewId, author: ALICE },
      browser(),
    );
    expect(v.body.recorded).toBe(true);
    expect(((await items('known-alice')).viewed ?? []).map((x) => x.docId)).toEqual([reviewId]);
  });

  it('stars a diff review for the person who starred it only', async () => {
    const { reviewId } = await makeDiff();
    const s = await post(
      `/workspaces/${WS}/library/stars`,
      { kind: 'doc', id: reviewId, starred: true, author: ALICE },
      browser(),
    );
    expect(s.body.recorded).toBe(true);
    const mine = await fetch(`${base}/workspaces/${WS}/library/stars?viewer=known-alice`, {
      headers: host,
    });
    const starred = ((await mine.json()) as { starred: Array<{ kind: string; id: string }> })
      .starred;
    expect(starred.map((x) => `${x.kind}:${x.id}`)).toEqual([`doc:${reviewId}`]);
    expect((await items('known-alice')).starred?.map((x) => x.id)).toEqual([reviewId]);
    expect((await items('known-bob')).starred).toBeUndefined();
  });
});
