import { MoveRefused } from '../../../../infra/project-machine/board-bundle.ts';
import {
  type ImportPlace,
  checkBoard,
  importStatus,
  receivePush,
} from '../../../../infra/project-machine/board-import-store.ts';
/**
 * ── A board pushed from the Mac onto this project machine ──
 *
 *   GET  /api/board-import/:board         where the push stands (ImportStatus)
 *   PUT  /api/board-import/:board         one push body (`board-import-store.ts`);
 *                                         202 once staged, then the machine restarts
 *                                         and its boot imports it before serving
 *   POST /api/board-import/:board/print   the imported board's fingerprint
 *                                         (`board-print.ts`), for the sender to compare
 *
 * Only a project machine answers these: without `CW_BOARD_IMPORT_DIR` the
 * family claims no path, and the request goes on to admission like any
 * other. The Mac's own server never sets it.
 *
 * Answered ABOVE request admission, beside the home feed, because the
 * sender names no person. The caller check is the home feed's, narrowed:
 *
 *  - through the tunnel only. A request without `cf-ray` is refused, so a
 *    process on this machine (the lead among them) cannot push a board over
 *    loopback;
 *  - a stamp signed for the Access application in front of the host it
 *    arrived on (`CF_ACCESS_HOST_AUDS`, else `CF_ACCESS_AUD`), so another
 *    project's application's stamp is refused;
 *  - naming no email and carrying a `common_name`: a service token the
 *    application's non-identity policy admitted, never a person;
 *  - with `CW_BOARD_IMPORT_CLIENT_ID` set, that one token's client id.
 *
 * And the board must be one this machine is for (`CW_BOARD_IMPORT_BOARDS`,
 * which `entrypoint.sh` sets to the board the lead leads). Any other board is
 * refused before a byte is read.
 */
import {
  type BoardLimits,
  boardPrint,
  loopbackGet,
} from '../../../../infra/project-machine/board-print.ts';
import type { CfAccessVerifier } from '../middleware/cf-access.ts';
import type { ServerOptions } from '../server-options.ts';

const IMPORT_PATH = /^\/api\/board-import\/([A-Za-z0-9_-]{1,128})(\/print)?$/;

export type BoardImportOptions = NonNullable<ServerOptions['boardImport']>;

export interface BoardImportRoutesContext {
  /** Undefined on every server that is not a project machine. */
  place: ImportPlace | undefined;
  clientId: string | undefined;
  /** The per-host Access verifier, or null when none is configured. */
  verifier: CfAccessVerifier | null;
  /** The board's fingerprint, read the way `board-probe.ts` reads it. */
  print: (boardId: string, limits: BoardLimits) => Promise<unknown>;
  j: (status: number, body: unknown) => Response;
}

export function boardImportRoutesContext(
  options: BoardImportOptions | undefined,
  deps: {
    dataDir: string;
    verifier: CfAccessVerifier | null;
    /** This server's own port, read when a print is asked for. */
    port: () => number | undefined;
    j: BoardImportRoutesContext['j'];
  },
): BoardImportRoutesContext {
  return {
    place: options
      ? { root: options.dir, dataDir: deps.dataDir, boards: options.boards }
      : undefined,
    clientId: options?.clientId,
    verifier: deps.verifier,
    print: (boardId, limits) =>
      boardPrint(
        loopbackGet(`http://127.0.0.1:${deps.port() ?? 0}`),
        deps.dataDir,
        boardId,
        limits,
      ),
    j: deps.j,
  };
}

/** Whether this caller may push a board here. Never says which check failed. */
export async function boardImportCallerAllowed(
  ctx: Pick<BoardImportRoutesContext, 'verifier' | 'clientId'>,
  req: Request,
): Promise<boolean> {
  if (!req.headers.has('cf-ray') || !ctx.verifier) return false;
  const result = await ctx.verifier(req);
  if (!result.ok || result.email !== undefined || result.commonName === undefined) return false;
  return ctx.clientId === undefined || result.commonName === ctx.clientId;
}

async function readLimits(req: Request): Promise<BoardLimits | null> {
  try {
    const body = (await req.json()) as { limits?: unknown };
    const l = body?.limits ?? {};
    return typeof l === 'object' && l !== null && !Array.isArray(l) ? (l as BoardLimits) : null;
  } catch {
    return null;
  }
}

export async function handleBoardImportRoute(
  ctx: BoardImportRoutesContext | undefined,
  req: Request,
  pathname: string,
): Promise<Response | null> {
  // A chain built without this family (a test's, or an older caller's) declines too.
  if (!ctx?.place) return null;
  const { place, j } = ctx;
  const m = IMPORT_PATH.exec(pathname);
  if (!m) return null;
  if (!(await boardImportCallerAllowed(ctx, req))) return j(403, { error: 'forbidden' });
  const board = m[1] as string;
  try {
    checkBoard(place, board);
  } catch {
    return j(403, { error: 'board_not_for_this_machine' });
  }
  if (m[2]) {
    if (req.method !== 'POST') return j(405, { error: 'method-not-allowed' });
    const limits = await readLimits(req);
    if (!limits) return j(400, { error: 'limits must be an object' });
    if (!importStatus(place, board).holds) return j(404, { error: 'not_found' });
    return j(200, await ctx.print(board, limits));
  }
  if (req.method === 'GET') return j(200, importStatus(place, board));
  if (req.method !== 'PUT') return j(405, { error: 'method-not-allowed' });
  if (!req.body) return j(400, { error: 'no body' });
  try {
    return j(202, await receivePush(place, board, req.body));
  } catch (e) {
    if (e instanceof MoveRefused) return j(409, { error: 'refused', reason: e.message });
    throw e;
  }
}
