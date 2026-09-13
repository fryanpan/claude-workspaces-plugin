/**
 * Moving a board doc into its project, over the real route and a real repo.
 *
 * The move has one job the older paths did not do: the moved file takes the
 * project's ADDRESS, so it stays one document. The first test proves the doc
 * keeps its thread, reply and anchor across a restart, that an anchored edit
 * still lands, and that opening the file from the Library answers the SAME id.
 * The second moves a meeting and reads its filing record follow it. The rest
 * are the refusals, each beside a move that succeeds on the same server, so a
 * refusal cannot be a route that never ran.
 *
 * All fixtures synthetic (Harborlight, a fictional ferry project).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDocKey, parseDocKey } from '../src/doc-key.ts';
import type { LibraryPayload } from '../src/library.ts';
import { meetingFilingFor } from '../src/meeting-home.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
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

describe('POST /workspaces/:ws/docs/:docId/move', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let outside: string;
  let WS = '';
  let handbookId = '';

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
  const move = (docId: string, relPath: unknown, headers: HeadersInit = {}) =>
    send('POST', docPath(docId, '/move'), { relPath }, headers);

  const idOf = (created: Record<string, unknown>): string =>
    String((created.meta as { docId?: string } | undefined)?.docId ?? created.docId);

  /** A doc held by Workspaces: its file sits in the server's data dir. */
  const heldDoc = async (name: string, markdown: string): Promise<string> => {
    const file = join(dataDir, 'held', `${name}.md`);
    mkdirSync(join(dataDir, 'held'), { recursive: true });
    writeFileSync(file, markdown);
    return idOf(
      await ok(
        await send('POST', `/workspaces/${WS}/docs`, {
          docId: name,
          type: 'markdown',
          sourceUrl: file,
          title: name,
        }),
      ),
    );
  };

  beforeEach(async () => {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cw-move-data-')));
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'cw-move-repo-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'cw-move-outside-')));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'handbook.md'), '# Harborlight handbook\n');
    mkdirSync(join(repo, 'docs', 'meetings'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'existing.md'), '# Existing\n');
    mkdirSync(join(repo, 'notes'));
    writeFileSync(join(repo, 'notes', 'survey.md'), '# Survey\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    handle = createServer({ port: 0, dataDir });
    WS = await seedBoard(`http://127.0.0.1:${handle.port}`, { name: 'Harborlight' });
    // The board's project is the repo its own docs sit in.
    handbookId = idOf(
      await ok(
        await send('POST', `/workspaces/${WS}/docs`, {
          docId: 'handbook',
          type: 'markdown',
          sourceUrl: join(repo, 'handbook.md'),
          title: 'Harborlight handbook',
        }),
      ),
    );
    await ok(await send('POST', '/api/mounts', { path: join(repo, 'docs') }));
  });

  afterEach(async () => {
    await handle.stop();
    for (const dir of [dataDir, repo, outside]) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the thread, reply and anchor across a restart, and the Library opens the same doc', async () => {
    const docId = await heldDoc(
      'dock-notes',
      '# Dock notes\n\nThe pier needs amber lamps before winter.\n',
    );
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

    const moved = await ok(await move(docId, 'docs/dock-notes.md'));
    expect(moved).toMatchObject({ ok: true, docId, relPath: 'docs/dock-notes.md' });
    const file = join(repo, 'docs', 'dock-notes.md');
    expect(readFileSync(file, 'utf8')).toContain('amber lamps');

    await handle.stop();
    handle = createServer({ port: 0, dataDir });

    const { threads } = (await ok(await send('GET', docPath(docId, '/threads')))) as {
      threads: Array<{ id: string; comments: unknown[]; anchor: { snippet?: { text: string } } }>;
    };
    const thread = threads.find((t) => t.id === threadId);
    expect(thread?.comments).toHaveLength(2);
    expect(thread?.anchor.snippet?.text).toBe('amber lamps');

    await ok(
      await send('POST', docPath(docId, `/threads/${threadId}/rewrite_region`), {
        replacement: 'sodium lamps',
      }),
    );
    await waitFor(() => readFileSync(file, 'utf8').includes('sodium lamps'), {
      describe: 'the anchored edit reaching the moved file',
    });

    const opened = await ok(
      await send('POST', `/workspaces/${WS}/library/open`, { path: 'docs/dock-notes.md' }),
    );
    expect(opened.docId).toBe(docId);
    const lib = (await ok(
      await send('GET', `/workspaces/${WS}/library/items`),
    )) as unknown as LibraryPayload;
    const rows = lib.files.filter((f) => f.name === 'dock-notes.md');
    expect(rows).toHaveLength(1);
    const places = lib.where?.flatMap((w) => w.places) ?? [];
    expect(places.find((p) => p.key === rows[0]?.place)?.label).toBe('docs');
  });

  it('moves a meeting into the meetings folder, and its filing record follows', async () => {
    const huddle = await ok(
      await send('POST', `/workspaces/${WS}/huddles`, {
        kind: 'discussion',
        topic: 'Ferry signage',
      }),
    );
    const docId = String(huddle.docId);
    await ok(
      await send('PUT', '/api/mounts/meetings', { path: repo, meetingsPath: 'docs/meetings' }),
    );
    expect(meetingFilingFor(dataDir, docId)?.relPath).toBeUndefined();

    const moved = await ok(await move(docId, 'docs/meetings/ferry-signage.md'));
    expect(moved.meeting).toBe(true);
    expect(readFileSync(join(repo, 'docs', 'meetings', 'ferry-signage.md'), 'utf8')).toContain(
      'Ferry signage',
    );
    // The data-dir copy is kept: a move never deletes.
    expect(existsSync(String(moved.previousPath))).toBe(true);

    const filing = meetingFilingFor(dataDir, docId);
    expect(filing?.relPath).toBe('docs/meetings/ferry-signage.md');
    const handbookKey = handle.docStore.repos.primaryKeyFor(handbookId);
    expect(filing?.repoKey).toBe(parseDocKey(handbookKey ?? '')?.repoKey);

    const lib = (await ok(
      await send('GET', `/workspaces/${WS}/library/items`),
    )) as unknown as LibraryPayload;
    const row = lib.meetings.find((m) => m.href?.endsWith(`/${docId}`));
    const places = lib.where?.flatMap((w) => w.places) ?? [];
    expect(places.find((p) => p.key === row?.place)?.label).toBe('docs/meetings');
  });

  it('refuses a path that is not a clean markdown path from the project root', async () => {
    const docId = await heldDoc('tide-notes', '# Tide notes\n');
    for (const bad of [
      '../escape.md',
      join(repo, 'docs', 'abs.md'),
      'docs/.hidden/x.md',
      'docs/notes.txt',
      7,
    ]) {
      const res = await move(docId, bad);
      expect(res.status, String(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('bad-path');
    }
    expect(existsSync(join(repo, '..', 'escape.md'))).toBe(false);
    await ok(await move(docId, 'docs/tide-notes.md'));
  });

  it('refuses a target outside every mount and the meetings folder', async () => {
    const docId = await heldDoc('buoy-log', '# Buoy log\n');
    const res = await move(docId, 'notes/buoy-log.md');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('outside-project-folders');
    expect(existsSync(join(repo, 'notes', 'buoy-log.md'))).toBe(false);
    await ok(await move(docId, 'docs/buoy-log.md'));
  });

  it('refuses a target that a symlink inside the mount carries out of it', async () => {
    symlinkSync(outside, join(repo, 'docs', 'elsewhere'));
    const docId = await heldDoc('gangway', '# Gangway\n');
    const res = await move(docId, 'docs/elsewhere/gangway.md');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('outside-project-folders');
    expect(existsSync(join(outside, 'gangway.md'))).toBe(false);
    await ok(await move(docId, 'docs/gangway.md'));
  });

  it('refuses a mockup', async () => {
    writeFileSync(join(outside, 'booking.html'), '<h1>Booking</h1>\n');
    const mock = await ok(
      await send('POST', `/workspaces/${WS}/docs`, {
        docId: 'booking-mock',
        type: 'mockup',
        sourceUrl: join(outside, 'booking.html'),
        title: 'Booking',
      }),
    );
    const mockId = idOf(mock);
    const res = await move(mockId, 'docs/booking.md');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('not-markdown');
    const docId = await heldDoc('booking-notes', '# Booking notes\n');
    await ok(await move(docId, 'docs/booking.md'));
  });

  it("refuses another board's doc", async () => {
    const other = await seedBoard(`http://127.0.0.1:${handle.port}`, { name: 'Riverbend' });
    writeFileSync(join(outside, 'riverbend-plan.md'), '# Riverbend plan\n');
    const otherId = idOf(
      await ok(
        await send('POST', `/workspaces/${other}/docs`, {
          docId: 'riverbend-plan',
          type: 'markdown',
          sourceUrl: join(outside, 'riverbend-plan.md'),
          title: 'Riverbend plan',
        }),
      ),
    );
    const res = await move(otherId, 'docs/riverbend-plan.md');
    expect(res.status).toBe(404);
    expect(existsSync(join(repo, 'docs', 'riverbend-plan.md'))).toBe(false);
    const docId = await heldDoc('harbor-plan', '# Harbor plan\n');
    await ok(await move(docId, 'docs/riverbend-plan.md'));
  });

  it('refuses a target file that already exists, and leaves it as it was', async () => {
    const docId = await heldDoc('berth-list', '# Berth list\n');
    const res = await move(docId, 'docs/existing.md');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('target-exists');
    expect(readFileSync(join(repo, 'docs', 'existing.md'), 'utf8')).toBe('# Existing\n');
    await ok(await move(docId, 'docs/berth-list.md'));
  });

  it('refuses a path whose address another doc already holds', async () => {
    const repoKey = parseDocKey(handle.docStore.repos.primaryKeyFor(handbookId) ?? '')?.repoKey;
    if (!repoKey) throw new Error('the handbook holds no address');
    handle.docStore.repos.claim(makeDocKey(repoKey, 'docs/pilotage.md'), handbookId);
    const docId = await heldDoc('pilotage', '# Pilotage\n');
    const res = await move(docId, 'docs/pilotage.md');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('address-held');
    expect(existsSync(join(repo, 'docs', 'pilotage.md'))).toBe(false);
    await ok(await move(docId, 'docs/pilotage-notes.md'));
  });

  it('refuses a browser, which may not decide where a file goes on the host', async () => {
    // The sign-in gate would refuse a browser write first, with its own
    // error. Off, so what refuses the move is the binding gate on the route.
    await handle.stop();
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const docId = await heldDoc('mooring', '# Mooring\n');
    const res = await move(docId, 'docs/mooring.md', {
      origin: `http://localhost:${handle.port}`,
      'sec-fetch-site': 'same-origin',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('browser_cannot_bind');
    expect(existsSync(join(repo, 'docs', 'mooring.md'))).toBe(false);
    await ok(await move(docId, 'docs/mooring.md'));
  });
});
