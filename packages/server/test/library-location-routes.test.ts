/**
 * "Where files live", over the real route and a real repo: a project that
 * mounts `docs`, names `docs/meetings` for meetings, and still holds a meeting
 * from before it named one plus notes outside the mount. The payload has to
 * read that as it is — and never carry a host path to anybody, least of all
 * a share visitor.
 *
 * The rules one at a time are `library-location.test.ts`.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LibraryPayload, createMarkdownLister } from '../src/library.ts';
import type { ShareTarget } from '../src/middleware/host-guard.ts';
import { MountStore } from '../src/mount-store.ts';
import { RepoRegistry } from '../src/repo-registry.ts';
import { type LibraryRoutesContext, handleLibraryRoutes } from '../src/routes/workspace-library.ts';
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

describe('where files live, over the library route', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let scratch: string;
  let WS = '';

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ok = async (res: Response): Promise<Record<string, unknown>> => {
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const bind = (docId: string, rel: string) =>
    send('POST', `/workspaces/${WS}/docs`, {
      docId,
      type: 'markdown',
      sourceUrl: join(repo, rel),
      title: docId,
    }).then(ok);
  const items = async (): Promise<LibraryPayload> =>
    (await ok(await send('GET', `/workspaces/${WS}/library/items`))) as unknown as LibraryPayload;
  /** Each kind's places as `label (note)`. */
  const read = (lib: LibraryPayload) =>
    (lib.where ?? []).map((w) => [
      w.kind,
      w.places.map((p) => (p.note ? `${p.label} (${p.note})` : p.label)),
    ]);

  beforeEach(async () => {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cw-where-data-')));
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'cw-where-repo-')));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cw-where-mock-')));
    git(repo, 'init', '-q');
    for (const rel of ['docs/ferry-schedule.md', 'docs/booking-flow.md', 'notes/dock-survey.md']) {
      mkdirSync(join(repo, rel, '..'), { recursive: true });
      writeFileSync(join(repo, rel), `# ${rel}\n`);
    }
    mkdirSync(join(repo, 'docs', 'meetings'));
    writeFileSync(join(repo, 'docs', 'meetings', '.keep'), '');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    writeFileSync(join(scratch, 'booking.html'), '<h1>Booking redesign</h1>\n');
    handle = createServer({ port: 0, dataDir });
    WS = await seedBoard(`http://127.0.0.1:${handle.port}`);
  });

  afterEach(async () => {
    await handle.stop();
    for (const dir of [dataDir, repo, scratch]) rmSync(dir, { recursive: true, force: true });
  });

  it('reads each kind where it really is, flagging what sits outside its folder', async () => {
    await bind('ferry', 'docs/ferry-schedule.md');
    await bind('booking', 'docs/booking-flow.md');
    await bind('survey', 'notes/dock-survey.md');
    await ok(
      await send('POST', `/workspaces/${WS}/docs`, {
        docId: 'booking-mock',
        type: 'mockup',
        sourceUrl: join(scratch, 'booking.html'),
        title: 'Booking redesign',
      }),
    );
    await ok(await send('POST', '/api/mounts', { path: join(repo, 'docs') }));

    // Before the project names a meetings folder: nothing to be outside of.
    const kickoff = await ok(
      await send('POST', `/workspaces/${WS}/huddles`, { kind: 'discussion' }),
    );
    const before = await items();
    expect(read(before)[0]).toEqual(['meetings', ['Stored by Workspaces']]);
    expect(before.where?.[0]?.unset).toBe(true);

    await ok(
      await send('PUT', '/api/mounts/meetings', { path: repo, meetingsPath: 'docs/meetings' }),
    );
    const walk = await ok(await send('POST', `/workspaces/${WS}/huddles`, { kind: 'discussion' }));

    const lib = await items();
    expect(read(lib)).toEqual([
      ['meetings', ['docs/meetings', 'Stored by Workspaces (not in docs/meetings)']],
      ['documents', ['docs', 'notes (not mounted)']],
      ['mockups', ['Stored by Workspaces']],
    ]);
    expect(lib.where?.map((w) => w.unset)).toEqual([false, false, false]);

    // Each board doc's row names its place, so a tap on a place lists them.
    const placeOf = (label: string) =>
      lib.where?.flatMap((w) => w.places).find((p) => p.label === label)?.key;
    const meetingAt = (docId: unknown) =>
      lib.meetings.find((m) => m.href?.endsWith(`/${String(docId)}`))?.place;
    expect(meetingAt(walk.docId)).toBe(placeOf('docs/meetings'));
    expect(meetingAt(kickoff.docId)).toBe(placeOf('Stored by Workspaces'));
    expect(lib.files.find((f) => f.name === 'dock-survey.md')?.place).toBe(placeOf('notes'));

    // No host path in any of it: not the repo, not the data dir, not the
    // mockup's scratch folder.
    const text = JSON.stringify(lib.where);
    for (const host of [repo, dataDir, scratch]) expect(text).not.toContain(host);
  });

  it('gives a share visitor no locations at all, and the owner the same board with them', async () => {
    await bind('survey', 'notes/dock-survey.md');
    const ctx: LibraryRoutesContext = {
      docStore: handle.docStore,
      taskStore: handle.tasks,
      taskProjection: handle.projection,
      mounts: new MountStore(dataDir, new RepoRegistry(dataDir)),
      dataDir,
      j: (status, body) => new Response(JSON.stringify(body), { status }),
      safeJson: async () => null,
      unfileFromDefault: () => {},
      markdownFiles: createMarkdownLister(),
      requestAddress: () => '127.0.0.1',
    };
    const board = handle.tasks.getWorkspace(WS);
    if (!board) throw new Error('no board');
    const ask = (visitor: ShareTarget | null) =>
      handleLibraryRoutes(ctx, {
        scope: { workspaceId: WS, rest: 'library/items', board },
        req: new Request(`http://board.example/workspaces/${WS}/library/items`),
        visitor,
      });

    // Positive control on the same context: the owner is told where it lives.
    const owner = await ask(null);
    const ownerText = (await owner?.text()) ?? '';
    expect(owner?.status).toBe(200);
    expect(ownerText).toContain('"notes"');

    const away = await ask({ workspaceId: WS } as ShareTarget);
    expect(away?.status).toBe(403);
    const awayText = (await away?.text()) ?? '';
    expect(awayText).not.toContain('notes');
    expect(awayText).not.toContain(repo);
  });
});
