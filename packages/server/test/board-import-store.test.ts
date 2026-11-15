/**
 * The receiving half of a pushed board, driven directly: the route's own
 * answers when it is not configured, its caller check, and the boot step's
 * reading of an import a crash cut short. The move between servers is
 * `board-push.test.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyStaged,
  importStatus,
  parseImportBoards,
  restartMarker,
} from '../../../infra/project-machine/board-import-store.ts';
import type { CfAccessResult } from '../src/middleware/cf-access.ts';
import { boardImportCallerAllowed, handleBoardImportRoute } from '../src/routes/board-import.ts';

const scratch = mkdtempSync(join(tmpdir(), 'cw-board-import-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const BOARD = 'w-Harbor01';
const j = (status: number, body: unknown) => Response.json(body, { status });
const verifier = (r: CfAccessResult) => async () => r;
const tunnel = () => new Request('https://h.test/x', { headers: { 'cf-ray': 'r' } });

describe('the board import route', () => {
  it('claims no path on a server that is not a project machine', async () => {
    const res = await handleBoardImportRoute(
      {
        place: undefined,
        clientId: undefined,
        verifier: verifier({ ok: true, email: undefined, commonName: 'a.access' }),
        print: async () => ({}),
        j,
      },
      tunnel(),
      `/api/board-import/${BOARD}`,
    );
    expect(res).toBeNull();
  });

  it('declines when the chain carries no context for it at all', async () => {
    expect(
      await handleBoardImportRoute(undefined, tunnel(), `/api/board-import/${BOARD}`),
    ).toBeNull();
  });

  it('admits the one configured client id and no other', async () => {
    const ctx = (commonName: string) => ({
      clientId: 'riverbend.access',
      verifier: verifier({ ok: true, email: undefined, commonName }),
    });
    expect(await boardImportCallerAllowed(ctx('riverbend.access'), tunnel())).toBe(true);
    expect(await boardImportCallerAllowed(ctx('saltmarsh.access'), tunnel())).toBe(false);
    const failed = {
      clientId: undefined,
      verifier: verifier({ ok: false, status: 401, error: 'x' }),
    };
    expect(await boardImportCallerAllowed(failed, tunnel())).toBe(false);
  });
});

describe('the boot step', () => {
  it('reads an import a crash cut short from what the data dir holds', () => {
    const root = join(scratch, 'imports');
    const dataDir = join(scratch, 'data');
    mkdirSync(join(root, BOARD), { recursive: true });
    mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
    const place = { root, dataDir, boards: [BOARD] };
    writeFileSync(join(root, BOARD, 'status.json'), JSON.stringify({ state: 'importing' }));
    writeFileSync(restartMarker(root), '');
    // Nothing landed: refused, and the restart marker is gone so the boot does not loop.
    applyStaged(place);
    expect(importStatus(place, BOARD)).toMatchObject({ state: 'refused', holds: false });
    expect(() => readFileSync(restartMarker(root))).toThrow();
    // The record landed before the crash: imported.
    writeFileSync(join(root, BOARD, 'status.json'), JSON.stringify({ state: 'importing' }));
    writeFileSync(join(dataDir, 'workspaces', `${BOARD}.tasks.json`), '{}');
    applyStaged(place);
    expect(importStatus(place, BOARD)).toMatchObject({ state: 'imported', holds: true });
  });

  it('takes only well-formed board ids from the environment', () => {
    expect(parseImportBoards(` ${BOARD}, ,../x,w-Salt `)).toEqual([BOARD]);
    expect(parseImportBoards(undefined)).toEqual([]);
  });
});
