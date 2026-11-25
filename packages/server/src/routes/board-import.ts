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
 * Ahead of all four, the external-access master switch
 * (`refuseWhileExternalAccessOff`): every caller here is through the tunnel,
 * so while the switch is off no push lands, whatever token it carries.
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
import { refuseWhileExternalAccessOff } from './home-feed.ts';
import { type RouteRow, rowHandlers } from './row-dispatch.ts';

/** A board id this family answers for: any other segment in its place is not its address. */
const BOARD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type BoardImportOptions = NonNullable<ServerOptions['boardImport']>;

export interface BoardImportRoutesContext {
  /** Undefined on every server that is not a project machine. */
  place: ImportPlace | undefined;
  clientId: string | undefined;
  /** The per-host Access verifier, or null when none is configured. */
  verifier: CfAccessVerifier | null;
  /** The board's fingerprint, read the way `board-probe.ts` reads it. */
  print: (boardId: string, limits: BoardLimits) => Promise<unknown>;
  /** The external-access master switch (`SharingGate.isEnabled`). */
  externalAccessOpen: () => boolean;
  j: (status: number, body: unknown) => Response;
}

export function boardImportRoutesContext(
  options: BoardImportOptions | undefined,
  deps: {
    dataDir: string;
    verifier: CfAccessVerifier | null;
    /** This server's own port, read when a print is asked for. */
    port: () => number | undefined;
    externalAccessOpen: BoardImportRoutesContext['externalAccessOpen'];
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
    externalAccessOpen: deps.externalAccessOpen,
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
  row: RouteRow,
): Promise<Response | null> {
  // A chain built without this family (a test's, or an older caller's) declines too.
  if (!ctx?.place) return null;
  const { place, j } = ctx;
  const board = row.params.ws ?? '';
  if (!BOARD_ID.test(board)) return null;
  const shut = refuseWhileExternalAccessOff(ctx, req);
  if (shut) return shut;
  if (!(await boardImportCallerAllowed(ctx, req))) return j(403, { error: 'forbidden' });
  try {
    checkBoard(place, board);
  } catch {
    return j(403, { error: 'board_not_for_this_machine' });
  }
  return ROWS({ ctx, place, board }, { req, row });
}

/** What every row reads once the caller and the board are checked. */
interface Checked {
  ctx: BoardImportRoutesContext;
  place: NonNullable<BoardImportRoutesContext['place']>;
  board: string;
}

const ROWS = rowHandlers<Checked, { req: Request; row: RouteRow }, Promise<Response>>(
  'board-import.ts',
  { '/api/board-import/:ws': push, '/api/board-import/:ws/print': print },
);

/** `POST …/print` — print what the held import would make, under `limits`. */
async function print({ ctx, place, board }: Checked, { req }: { req: Request }): Promise<Response> {
  const { j } = ctx;
  if (req.method !== 'POST') return j(405, { error: 'method-not-allowed' });
  const limits = await readLimits(req);
  if (!limits) return j(400, { error: 'limits must be an object' });
  if (!importStatus(place, board).holds) return j(404, { error: 'not_found' });
  return j(200, await ctx.print(board, limits));
}

/** `GET` the import's status, or `PUT` a push of the board. */
async function push({ ctx, place, board }: Checked, { req }: { req: Request }): Promise<Response> {
  const { j } = ctx;
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
