/**
 * The board router Worker's routing (infra/board-router-worker): a board id in
 * the path picks that board's origin, an unlisted board is a 404, and nothing
 * ever falls back to a default origin. Every refusal is paired with the same
 * request routing once the one thing it lacked is present.
 */
import { describe, expect, it } from 'bun:test';
import {
  boardIdOfPath,
  handleBoardRequest,
  parseBoardOrigins,
  routeBoardRequest,
} from '../../../infra/board-router-worker/worker.js';

const ONE = 'https://workspaces.harborlight.test';
const MAC = 'mac-origin.harborlight.test';
const RIVERBEND = 'riverbend-origin.harborlight.test';
const CONFIG = JSON.stringify({ [MAC]: ['w-mac1', 'w-mac2'], [RIVERBEND]: ['w-river'] });
const TABLE = parseBoardOrigins(CONFIG);

const route = (path: string, referer: string | null = null) =>
  routeBoardRequest(new URL(path, ONE), referer, TABLE);

describe('parseBoardOrigins', () => {
  it('maps every listed board to its origin', () => {
    expect(TABLE).not.toBeNull();
    expect([...(TABLE ?? new Map())]).toEqual([
      ['w-mac1', MAC],
      ['w-mac2', MAC],
      ['w-river', RIVERBEND],
    ]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not JSON', '{'],
    ['an array', '[]'],
    ['a hostname with a port', JSON.stringify({ 'mac-origin.harborlight.test:8787': ['w-a'] })],
    ['a hostname with a path', JSON.stringify({ 'mac-origin.harborlight.test/x': ['w-a'] })],
    ['an upper-case hostname', JSON.stringify({ 'Mac-Origin.harborlight.test': ['w-a'] })],
    ['a bare label', JSON.stringify({ localhost: ['w-a'] })],
    ['boards not a list', JSON.stringify({ [MAC]: 'w-a' })],
    ['a board id with a slash', JSON.stringify({ [MAC]: ['w-a/b'] })],
    ['a board id with an escape', JSON.stringify({ [MAC]: ['w-%2e'] })],
    ['one board on two origins', JSON.stringify({ [MAC]: ['w-a'], [RIVERBEND]: ['w-a'] })],
  ])('refuses a config that is %s', (_label, raw) => {
    expect(parseBoardOrigins(raw)).toBeNull();
  });
});

describe('boardIdOfPath', () => {
  it('reads the board from the page and from anything under it', () => {
    expect(boardIdOfPath('/workspaces/w-river')).toBe('w-river');
    expect(boardIdOfPath('/workspaces/w-river/docs/d-1/y')).toBe('w-river');
  });

  it('names no board for a path outside /workspaces/<id>', () => {
    expect(boardIdOfPath('/')).toBeNull();
    expect(boardIdOfPath('/workspaces')).toBeNull();
    expect(boardIdOfPath('/workspaces/')).toBeNull();
    expect(boardIdOfPath('/app/board.js')).toBeNull();
    expect(boardIdOfPath('/api/workspaces/w-river')).toBeNull();
    // Compared undecoded, so an escaped separator is not a board id.
    expect(boardIdOfPath('/workspaces/w-river%2F..')).toBeNull();
  });
});

describe('routeBoardRequest', () => {
  it('sends each board to the origin that holds it', () => {
    expect(route('/workspaces/w-river?format=json')).toEqual({
      kind: 'forward',
      boardId: 'w-river',
      origin: RIVERBEND,
    });
    expect(route('/workspaces/w-mac2/tasks')).toEqual({
      kind: 'forward',
      boardId: 'w-mac2',
      origin: MAC,
    });
  });

  it('answers not_found for an unlisted board, never a default origin', () => {
    expect(route('/workspaces/w-unknown')).toEqual({ kind: 'not_found' });
    expect(route('/')).toEqual({ kind: 'not_found' });
  });

  it('routes nothing when the table is null', () => {
    expect(routeBoardRequest(new URL('/workspaces/w-river', ONE), null, null)).toEqual({
      kind: 'not_found',
    });
  });

  it('gives a path with no board the board of a same-host Referer', () => {
    expect(route('/app/board.js', `${ONE}/workspaces/w-river`)).toEqual({
      kind: 'forward',
      boardId: 'w-river',
      origin: RIVERBEND,
    });
  });

  it('ignores a Referer from another host or one that names no board', () => {
    expect(route('/app/board.js', 'https://elsewhere.saltmarsh.test/workspaces/w-river')).toEqual({
      kind: 'not_found',
    });
    expect(route('/app/board.js', `${ONE}/`)).toEqual({ kind: 'not_found' });
    expect(route('/app/board.js', 'not a url')).toEqual({ kind: 'not_found' });
  });

  it("lets the path's own board win over the Referer's", () => {
    expect(route('/workspaces/w-mac1', `${ONE}/workspaces/w-river`)).toEqual({
      kind: 'forward',
      boardId: 'w-mac1',
      origin: MAC,
    });
  });
});

describe('handleBoardRequest', () => {
  const calls: Array<{ request: Request; origin: string; redirect: string }> = [];
  const upstream = async (
    request: Request,
    init: { redirect: 'manual'; cf: { resolveOverride: string } },
  ) => {
    calls.push({ request, origin: init.cf.resolveOverride, redirect: init.redirect });
    return new Response('from origin', { status: 200 });
  };

  it('forwards a listed board with its stamp and session cookie intact', async () => {
    calls.length = 0;
    const res = await handleBoardRequest(
      new Request(`${ONE}/workspaces/w-river?format=json`, {
        headers: {
          'cf-access-jwt-assertion': 'stamp-value',
          cookie: 'CF_Authorization=c; __Host-cw_session=s',
        },
      }),
      { BOARD_ORIGINS: CONFIG },
      upstream,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.origin).toBe(RIVERBEND);
    expect(calls[0]?.redirect).toBe('manual');
    expect(calls[0]?.request.url).toBe(`${ONE}/workspaces/w-river?format=json`);
    expect(calls[0]?.request.headers.get('cf-access-jwt-assertion')).toBe('stamp-value');
    // The Access cookie is dropped: the stamp header carries the same token
    // (board-router-subdomains.test.ts covers the cookie rule).
    expect(calls[0]?.request.headers.get('cookie')).toBe('__Host-cw_session=s');
  });

  it('answers 404 itself for an unknown board and calls no origin', async () => {
    calls.length = 0;
    const res = await handleBoardRequest(
      new Request(`${ONE}/workspaces/w-unknown`),
      { BOARD_ORIGINS: CONFIG },
      upstream,
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('answers 404 for every board when the config is missing', async () => {
    calls.length = 0;
    const res = await handleBoardRequest(new Request(`${ONE}/workspaces/w-river`), {}, upstream);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
