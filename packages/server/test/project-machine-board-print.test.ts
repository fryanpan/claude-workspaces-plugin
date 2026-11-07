/**
 * A board whose `docIds` names a doc the server does not have
 * (`infra/project-machine/board-print.ts`): the fingerprint records it as
 * missing on both sides, so a move still compares, and the export carries the
 * id so the target's `docIds` match the source's. The server is a stand-in on
 * loopback answering the four reads the fingerprint makes; no real server.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportBoard, importBoard } from '../../../infra/project-machine/board-bundle.ts';
import { boardPrint, judgeMove, loopbackGet } from '../../../infra/project-machine/board-print.ts';
import { moveBoard } from '../../../infra/project-machine/move-board.ts';

const scratch = mkdtempSync(join(tmpdir(), 'cw-board-print-'));
const servers: Array<{ stop(force?: boolean): void }> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

const BOARD = 'w-Harbor9';
const GONE = 'harborlight-gone-live';

interface Doc {
  /** Absent: the content route answers 404. */
  plainText?: string;
  /** Absent: the threads route answers 404. */
  threads?: Array<{ id: string; status: string; comments: { id: string; text: string }[] }>;
}

/** A board server answering only the fingerprint's reads. */
function fakeServer(docs: Record<string, Doc>, status404 = 404): string {
  const notFound = (status = status404) => Response.json({ error: 'doc not found' }, { status });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === `/workspaces/${BOARD}`)
        return Response.json({ workspace: { name: 'Harborlight', docIds: Object.keys(docs) } });
      if (path === `/workspaces/${BOARD}/tasks`) return Response.json({ tasks: [] });
      const m = path.match(/^\/workspaces\/[^/]+\/docs\/([^/]+)\/(content|threads)$/);
      const doc = m ? docs[decodeURIComponent(m[1] as string)] : undefined;
      if (!m || !doc) return notFound();
      if (m[2] === 'content')
        return doc.plainText === undefined
          ? notFound()
          : Response.json({ plainText: doc.plainText });
      return doc.threads === undefined ? notFound() : Response.json({ threads: doc.threads });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const PLAN: Doc = {
  plainText: 'The ferry moves to spring.',
  threads: [{ id: 'th-1', status: 'open', comments: [{ id: 'c-1', text: 'Is spring right?' }] }],
};

describe('a listed doc the server does not have', () => {
  it('is fingerprinted as missing, and two such boards match', async () => {
    const source = await boardPrint(
      loopbackGet(fakeServer({ 'harborlight-plan': PLAN, [GONE]: {} })),
      scratch,
      BOARD,
    );
    expect(source.dangling).toEqual([GONE]);
    expect(source.docs.count).toBe(2);
    const target = await boardPrint(
      loopbackGet(fakeServer({ 'harborlight-plan': PLAN, [GONE]: {} })),
      scratch,
      BOARD,
    );
    expect(judgeMove(source, target).ok).toBe(true);
  });

  it('CONTROL: a target that has the doc does not match a source that is missing it', async () => {
    const source = await boardPrint(loopbackGet(fakeServer({ [GONE]: {} })), scratch, BOARD);
    const target = await boardPrint(
      loopbackGet(fakeServer({ [GONE]: { plainText: '', threads: [] } })),
      scratch,
      BOARD,
    );
    expect(target.dangling).toEqual([]);
    const verdict = judgeMove(source, target);
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.find((l) => l.includes(' docs:'))).toStartWith('FAIL');
  });

  it('still fails loudly when the content is missing but the threads are there', async () => {
    const get = loopbackGet(fakeServer({ [GONE]: { threads: [] } }));
    await expect(boardPrint(get, scratch, BOARD)).rejects.toThrow(/content -> 404/);
  });

  it('still fails on any answer other than 404', async () => {
    const get = loopbackGet(fakeServer({ [GONE]: {} }, 500));
    await expect(boardPrint(get, scratch, BOARD)).rejects.toThrow(/-> 500/);
  });
});

describe('the share rows of a moved board', () => {
  const rows = (...links: [string, string][]) =>
    JSON.stringify({
      links: links.map(([linkId, workspaceId]) => ({ linkId, workspaceId, redemptions: [] })),
      members: [],
      audiences: [],
    });
  const printOf = async (name: string, shareLinks: string, shares: unknown[]) => {
    const dir = join(scratch, `shares-${name}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'share-links.json'), shareLinks);
    writeFileSync(join(dir, 'shares.json'), JSON.stringify(shares));
    return boardPrint(loopbackGet(fakeServer({})), dir, BOARD);
  };
  const OTHER = 'w-River09';
  const share = { shareId: 's-1', workspaceId: BOARD };

  it('match whatever other boards hold', async () => {
    const before = await printOf('source', rows(['l-1', BOARD], ['l-2', OTHER]), [share]);
    const after = await printOf('target', rows(['l-1', BOARD], ['l-3', OTHER]), [
      share,
      { shareId: 's-2', workspaceId: OTHER },
    ]);
    expect(before.shares.count).toBe(2);
    expect(judgeMove(before, after).ok).toBe(true);
  });

  it('fail the move when an import planted a link or a share', async () => {
    const before = await printOf('plain', rows(['l-1', BOARD]), [share]);
    const link = await printOf('link', rows(['l-1', BOARD], ['l-planted', BOARD]), [share]);
    const verdict = judgeMove(before, link);
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.find((l) => l.includes('shares'))).toStartWith('FAIL shares: 2 -> 3');
    const planted = { shareId: 's-planted', workspaceId: BOARD };
    const row = await printOf('share', rows(['l-1', BOARD]), [share, planted]);
    expect(judgeMove(before, row).ok).toBe(false);
  });
});

describe('the export of a board with a dangling doc id', () => {
  const sourceDir = join(scratch, 'source');
  const targetDir = join(scratch, 'target');
  mkdirSync(join(sourceDir, 'workspaces'), { recursive: true });
  mkdirSync(join(targetDir, 'workspaces'), { recursive: true });
  writeFileSync(
    join(sourceDir, 'workspaces', `${BOARD}.tasks.json`),
    JSON.stringify({
      workspace: { id: BOARD, name: 'Harborlight', docIds: ['harborlight-plan', GONE], goals: [] },
      tasks: [],
    }),
  );

  it("carries the id, so the target's docIds are the source's", () => {
    const bundle = join(scratch, 'bundle');
    const manifest = exportBoard(sourceDir, BOARD, bundle);
    expect(manifest.docIds).toContain(GONE);
    expect(manifest.files.some((f) => f.path.startsWith(GONE))).toBe(false);
    importBoard(bundle, targetDir);
    const rec = JSON.parse(
      readFileSync(join(targetDir, 'workspaces', `${BOARD}.tasks.json`), 'utf8'),
    ) as { workspace: { docIds: string[] } };
    expect(rec.workspace.docIds).toEqual(['harborlight-plan', GONE]);
  });

  it('a dry run of the move says how many dangling ids it found', async () => {
    const base = fakeServer({ 'harborlight-plan': PLAN, [GONE]: {} });
    const lines: string[] = [];
    const r = await moveBoard({
      boardId: BOARD,
      source: { dataDir: sourceDir, base },
      target: {
        describe: 'no target',
        holds: async () => false,
        importBundle: async () => {
          throw new Error('a dry run imports nothing');
        },
        print: async () => {
          throw new Error('a dry run reads no target');
        },
      },
      dryRun: true,
      log: (l) => lines.push(l),
    });
    expect(r.ok).toBe(true);
    expect(lines.join('\n')).toContain('1 dangling doc id(s)');
  });
});
