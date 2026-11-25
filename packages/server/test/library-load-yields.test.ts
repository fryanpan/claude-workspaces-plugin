/**
 * A Library load lists the project without holding the event loop. On
 * 25 Nov one load on a 200k-entry tree held the whole server 5.7s: the
 * listing was a synchronous walk (or a `spawnSync` git) inside the request.
 *
 * The claim is about order, not time: other work on the loop runs WHILE the
 * load is listing, so no one request owns the server for the length of the
 * listing. A tick re-armed with `setImmediate` counts the loop's turns; a
 * load that lists synchronously answers with the count at zero (the last
 * case here is that control). The slice is lowered (`WALK_SLICE`) so a small
 * tree crosses many. The walk under a walled lead's root, which is what ran
 * in prod, is `fs-scan-contained.test.ts`.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WALK_SLICE } from '../src/fs-scan-contained.ts';
import * as fsScan from '../src/fs-scan.ts';
import { type LibraryPayload, createMarkdownLister } from '../src/library.ts';
import { MountStore } from '../src/mount-store.ts';
import { RepoRegistry } from '../src/repo-registry.ts';
import { type LibraryRoutesContext, handleLibraryRoutes } from '../src/routes/workspace-library.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const FOLDERS = 20;
const PER_FOLDER = 30;

/** How many turns the event loop took while `work` ran, and its value. */
async function turnsDuring<T>(work: () => Promise<T>): Promise<{ turns: number; value: T }> {
  let turns = 0;
  let done = false;
  const tick = () => {
    if (done) return;
    turns++;
    setImmediate(tick);
  };
  setImmediate(tick);
  const value = await work();
  done = true;
  return { turns, value };
}

/** `FOLDERS` folders of `PER_FOLDER` markdown files each, under `root`. */
function plant(root: string): void {
  for (let d = 0; d < FOLDERS; d++) {
    const dir = join(root, 'harborlight', `log-${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < PER_FOLDER; f++) writeFileSync(join(dir, `entry-${f}.md`), `# ${f}\n`);
  }
}

describe('a Library load on a large project', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let root: string;
  let WS = '';
  const slice = WALK_SLICE.entries;

  const bindReadme = async () => {
    writeFileSync(join(root, 'README.md'), '# Riverbend tide log\n');
    const res = await fetch(`http://127.0.0.1:${handle.port}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId: 'readme',
        type: 'markdown',
        sourceUrl: join(root, 'README.md'),
        title: 'Riverbend tide log',
      }),
    });
    expect(res.status).toBe(200);
  };

  const load = async (ctx: LibraryRoutesContext): Promise<LibraryPayload> => {
    const board = handle.tasks.getWorkspace(WS);
    if (!board) throw new Error('no board');
    const res = await handleLibraryRoutes(ctx, {
      scope: { workspaceId: WS, rest: 'library/items', board },
      req: new Request(`http://board.example/workspaces/${WS}/library/items`),
      visitor: null,
    });
    expect(res?.status).toBe(200);
    return (await res?.json()) as LibraryPayload;
  };

  const ctxWith = (markdownFiles: LibraryRoutesContext['markdownFiles']): LibraryRoutesContext => ({
    docStore: handle.docStore,
    taskStore: handle.tasks,
    taskProjection: handle.projection,
    mounts: new MountStore(dataDir, new RepoRegistry(dataDir)),
    dataDir,
    j: (status, body) => new Response(JSON.stringify(body), { status }),
    safeJson: async (r) => (await r.json()) as Record<string, unknown>,
    unfileFromDefault: () => {},
    markdownFiles,
    requestAddress: () => '127.0.0.1',
  });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'library-yields-data-'));
    root = realpathSync(mkdtempSync(join(tmpdir(), 'library-yields-root-')));
    // The Library lists a project, and a project is a repository.
    execFileSync('git', ['-C', root, 'init', '-q']);
    WALK_SLICE.entries = 25;
    handle = createServer({ port: 0, dataDir });
    WS = await seedBoard(`http://127.0.0.1:${handle.port}`);
  });

  afterEach(async () => {
    WALK_SLICE.entries = slice;
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('lets the loop run while git lists the project', async () => {
    plant(root);
    await bindReadme();
    const { turns, value } = await turnsDuring(() => load(ctxWith(createMarkdownLister())));
    // Positive control: every planted file is listed, so the turns were
    // taken while a listing ran, not by a listing that never built.
    expect(value.files.filter((f) => f.open?.startsWith('harborlight/')).length).toBe(
      FOLDERS * PER_FOLDER,
    );
    // git runs as a child the loop waits on, and the stats run in slices of
    // 25: 600 files take at least one turn per slice.
    expect(turns).toBeGreaterThanOrEqual((FOLDERS * PER_FOLDER) / 25);
  });

  it('answers a stale listing at once and builds the fresh one behind it', async () => {
    plant(root);
    await bindReadme();
    let clock = 0;
    const lister = createMarkdownLister(() => clock);
    const ctx = ctxWith(lister);
    await load(ctx);
    writeFileSync(join(root, 'harborlight', 'log-0', 'late.md'), '# late\n');
    clock += 60_000;
    const has = (lib: LibraryPayload) =>
      lib.files.some((f) => f.open === 'harborlight/log-0/late.md');
    // The stale load answers with the listing it had, without walking first.
    const stale = await turnsDuring(() => load(ctx));
    expect(has(stale.value)).toBe(false);
    expect(stale.turns).toBe(0);
    // The rebuild it started lands, and the next load shows the new file.
    await waitFor(async () => has(await load(ctx)), { describe: 'the rebuilt listing' });
  });

  it('starts no second rebuild when one took longer than the freshness window', async () => {
    plant(root);
    await bindReadme();
    let clock = 0;
    const lister = createMarkdownLister(() => clock);
    const ctx = ctxWith(lister);
    const scans = spyOn(fsScan, 'scanFolderPathsAsync');
    try {
      // The first listing takes "a minute": the clock moves while it builds.
      const first = load(ctx);
      setImmediate(() => {
        clock += 60_000;
      });
      await first;
      expect(scans).toHaveBeenCalledTimes(1);
      // A load straight after it is fresh, so it starts nothing.
      await load(ctx);
      await load(ctx);
      expect(scans).toHaveBeenCalledTimes(1);
      // Control: once the window really passes, a load does rebuild.
      clock += 60_000;
      await load(ctx);
      expect(scans).toHaveBeenCalledTimes(2);
    } finally {
      scans.mockRestore();
    }
  });

  it('opens a listed file without listing inside the request', async () => {
    plant(root);
    await bindReadme();
    const ctx = ctxWith(createMarkdownLister());
    const board = handle.tasks.getWorkspace(WS);
    if (!board) throw new Error('no board');
    const { turns, value } = await turnsDuring(async () =>
      handleLibraryRoutes(ctx, {
        scope: { workspaceId: WS, rest: 'library/open', board },
        req: new Request(`http://board.example/workspaces/${WS}/library/open`, {
          method: 'POST',
          body: JSON.stringify({ path: 'harborlight/log-3/entry-7.md' }),
        }),
        visitor: null,
      }),
    );
    expect(value?.status).toBe(200);
    expect(turns).toBeGreaterThanOrEqual((FOLDERS * PER_FOLDER) / 25);
  });

  it('is unchanged for a context whose lister has no async path', async () => {
    plant(root);
    await bindReadme();
    const sync = createMarkdownLister();
    const plain: LibraryRoutesContext['markdownFiles'] = (r) => sync(r);
    const { turns, value } = await turnsDuring(() => load(ctxWith(plain)));
    // The listing ran inside the request, as it did before `ready` existed.
    expect(turns).toBe(0);
    expect(value.files.filter((f) => f.open?.startsWith('harborlight/')).length).toBe(
      FOLDERS * PER_FOLDER,
    );
  });
});
