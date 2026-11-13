/**
 * A doc's metadata answers for a DORMANT doc: one whose file binding is not
 * armed because nobody has opened it since the server started.
 *
 * The route used to take the file's path from the live binding alone, so a
 * dormant doc answered `schema: null` with no reason and a set was refused
 * 409 no-schema, until something else (a `get_doc`) woke the binding. The
 * path now comes from what the doc records about its file, and the GET is a
 * read: it arms no binding, as reading a doc's threads arms none.
 *
 * - A dormant doc under a schema folder answers its schema from GET.
 * - That GET leaves the doc unbound (with a control doc that does bind, so
 *   "unbound" means "never bound" rather than "not bound yet").
 * - A set on a dormant doc lands on disk.
 * - An answer with no schema says why: `no-file`, `not-file-bound`, or the
 *   schema file's own fault.
 *
 * Fixtures are invented. Port 0, temp folders only.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { makeFifo, releaseFifosIn } from './fifo.ts';
import { waitFor, waitForFileToBe } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', title: 'Title' },
    status: { type: 'string', enum: ['draft', 'published'] },
  },
};

const DOC = '---\ntitle: Harborlight fares\nstatus: draft\n---\n\n# Harborlight fares\n\nBody.\n';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

describe('doc metadata on a dormant doc', () => {
  let handle: ServerHandle | null = null;
  const dirs: string[] = [];

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    for (const d of dirs) await releaseFifosIn(join(d, 'papers'));
    boundFiles.reset();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const tmp = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  /** A git repository holding `files`, relative path to text. */
  const makeRepo = (files: Record<string, string>): string => {
    const root = tmp('cw-meta-dormant-repo-');
    git(root, 'init', '-q');
    for (const [rel, text] of Object.entries(files)) {
      const path = join(root, rel);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
    }
    return root;
  };

  const boot = (dataDir: string): string => {
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    return `http://127.0.0.1:${handle.port}`;
  };

  type Seed = { docId: string; type?: string; sourceUrl?: string };

  const createDoc = async (base: string, ws: string, d: Seed) => {
    const res = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'markdown', ...d }),
    });
    expect(res.status).toBe(200);
    // The id is minted; `d.docId` is the alias every request below uses.
    return ((await res.json()) as { docId: string }).docId;
  };

  /**
   * Create the docs on one server, then restart on the same data folder: the
   * docs are on disk with their file recorded, nothing is resident, and no
   * binding is armed. That is the state a doc is in on prod when nobody has
   * opened it since the last restart.
   */
  const dormant = async (docs: Seed[]): Promise<{ base: string; ws: string }> => {
    const dataDir = tmp('cw-meta-dormant-data-');
    let base = boot(dataDir);
    const ws = await seedBoard(base);
    const minted: string[] = [];
    for (const d of docs) minted.push(await createDoc(base, ws, d));
    await handle?.stop();
    for (const id of minted) expect(existsSync(join(dataDir, `${id}.ydoc`))).toBe(true);
    base = boot(dataDir);
    expect(handle?.docStore.stats().bindings).toBe(0);
    return { base, ws };
  };

  const metadata = async (base: string, ws: string, docId: string) => {
    const res = await fetch(`${base}/workspaces/${ws}/docs/${docId}/metadata`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  it('answers the schema of a dormant doc, and arms no binding', async () => {
    const root = makeRepo({
      '.workspaces/doc-metadata.schema.json': JSON.stringify(SCHEMA),
      'papers/fares.md': DOC,
      'papers/ledger.md': '# Riverbend ledger\n',
    });
    const path = join(root, 'papers/fares.md');
    const { base, ws } = await dormant([
      { docId: 'fares', sourceUrl: path },
      { docId: 'ledger', sourceUrl: join(root, 'papers/ledger.md') },
    ]);

    // The read under test.
    const body = await metadata(base, ws, 'fares');
    expect(body.schemaAt).toBe('../.workspaces/doc-metadata.schema.json');
    expect((body.schema as { fields: Array<{ key: string }> }).fields.map((f) => f.key)).toEqual([
      'title',
      'status',
    ]);
    expect(body.values).toEqual({ title: 'Harborlight fares', status: 'draft' });
    expect(body).not.toHaveProperty('schemaReason');

    // The control, queued after it: a CONTENT read of the other doc, which
    // binds. Waiting for it to land is what makes the check below mean
    // "the metadata read never bound" rather than "not bound yet".
    expect((await fetch(`${base}/workspaces/${ws}/docs/ledger?format=json`)).status).toBe(200);
    await waitFor(() => handle?.docStore.boundPathOf('ledger')?.endsWith('papers/ledger.md'), {
      describe: 'the content read to bind the control doc',
    });
    expect(handle?.docStore.boundPathOf('fares')).toBeUndefined();
    expect(handle?.docStore.stats().bindings).toBe(1);
  });

  /** The read the board's review fan-out makes: the doc comes into memory unbound. */
  const readThreads = async (base: string, ws: string, docId: string) => {
    expect((await fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`)).status).toBe(200);
    expect(handle?.docStore.peek(docId)).toBeDefined();
    expect(handle?.docStore.boundPathOf(docId)).toBeUndefined();
    // The threads request's read-ahead kept the file's bytes for
    // BOUND_READ_FRESH_MS. On prod the next request comes long after they
    // expired; dropping them here is that wait.
    boundFiles.reset();
  };

  // The state prod was in: a threads read left the doc in memory with no
  // binding, so the next request skips the read-ahead and its bind waits on
  // the read pool. The route used to look only at the binding, and answered
  // null with no reason.
  it('answers the schema of a doc a threads read left in memory unbound', async () => {
    const root = makeRepo({
      '.workspaces/doc-metadata.schema.json': JSON.stringify(SCHEMA),
      'papers/fares.md': DOC,
    });
    const { base, ws } = await dormant([
      { docId: 'fares', sourceUrl: join(root, 'papers/fares.md') },
    ]);
    await readThreads(base, ws, 'fares');

    const body = await metadata(base, ws, 'fares');
    expect(body.schemaAt).toBe('../.workspaces/doc-metadata.schema.json');
    expect(body.values).toEqual({ title: 'Harborlight fares', status: 'draft' });
    expect(handle?.docStore.boundPathOf('fares')).toBeUndefined();
  });

  it('a set on a dormant doc lands on disk', async () => {
    const root = makeRepo({
      '.workspaces/doc-metadata.schema.json': JSON.stringify(SCHEMA),
      'papers/fares.md': DOC,
    });
    const path = join(root, 'papers/fares.md');
    const { base, ws } = await dormant([{ docId: 'fares', sourceUrl: path }]);
    await readThreads(base, ws, 'fares');

    const res = await fetch(`${base}/workspaces/${ws}/docs/fares/metadata`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { status: 'published' } }),
    });
    expect(res.status).toBe(200);
    await waitForFileToBe(path, DOC.replace('status: draft', 'status: published'));
  });

  it('says no-file when no schema file sits between the doc and the repository top', async () => {
    const root = makeRepo({ 'papers/plain.md': DOC });
    const { base, ws } = await dormant([
      { docId: 'plain', sourceUrl: join(root, 'papers/plain.md') },
    ]);
    expect(await metadata(base, ws, 'plain')).toMatchObject({
      schema: null,
      schemaReason: 'no-file',
    });
  });

  it('says not-file-bound for a doc with no file', async () => {
    const { base, ws } = await dormant([{ docId: 'loose', type: 'mockup' }]);
    expect(await metadata(base, ws, 'loose')).toMatchObject({
      schema: null,
      schemaReason: 'not-file-bound',
    });
  });

  it('says invalid when the schema file is not usable', async () => {
    const root = makeRepo({
      '.workspaces/doc-metadata.schema.json': '{ not json',
      'papers/fares.md': DOC,
    });
    const { base, ws } = await dormant([
      { docId: 'fares', sourceUrl: join(root, 'papers/fares.md') },
    ]);
    expect(await metadata(base, ws, 'fares')).toMatchObject({
      schema: null,
      schemaReason: 'invalid',
      schemaAt: '../.workspaces/doc-metadata.schema.json',
      schemaError: 'the schema file is not valid JSON',
    });
  });

  // A file that stopped answering (the 2026-09-04 shape, reproduced with a
  // named pipe nobody writes to) is quarantined by the request's read-ahead.
  // The search would stat its folder on the main thread, so it is skipped
  // and the answer says so.
  it('says file-not-answering for a doc whose file is quarantined', async () => {
    const root = makeRepo({
      '.workspaces/doc-metadata.schema.json': JSON.stringify(SCHEMA),
      'papers/fares.md': DOC,
    });
    const path = join(root, 'papers/fares.md');
    const { base, ws } = await dormant([{ docId: 'fares', sourceUrl: path }]);
    unlinkSync(path);
    makeFifo(path);

    expect(await metadata(base, ws, 'fares')).toMatchObject({
      schema: null,
      schemaReason: 'file-not-answering',
    });
  });
});
