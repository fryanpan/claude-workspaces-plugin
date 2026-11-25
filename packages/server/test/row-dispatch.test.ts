/**
 * Dispatch from the route table's rows (`src/routes/row-dispatch.ts`): the
 * row a path matches, the params it binds, the boot check that ties a
 * module's handler map to its rows, and the router half that hands a
 * handler the row it matched.
 */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { claimRowsWith } from '../src/routes/hono-families.ts';
import {
  type RouteRow,
  matchRow,
  paramsOf,
  rowHandlers,
  rowPatterns,
} from '../src/routes/row-dispatch.ts';

describe('paramsOf', () => {
  it('binds each :name segment to the raw segment', () => {
    expect(
      paramsOf('/api/agents/:agentId/messages/:personId', '/api/agents/a-1/messages/p%201'),
    ).toEqual({
      agentId: 'a-1',
      personId: 'p%201',
    });
  });

  it('declines a different depth, an empty segment and a different literal', () => {
    expect(paramsOf('/api/board-tokens/:id/revoke', '/api/board-tokens/revoke')).toBeNull();
    expect(paramsOf('/api/board-tokens/:id/revoke', '/api/board-tokens//revoke')).toBeNull();
    expect(paramsOf('/api/board-tokens/:id/revoke', '/api/board-tokens/x/revoked')).toBeNull();
    expect(paramsOf('/api/metrics', '/api/metrics/')).toBeNull();
  });

  it('compares literals as spelt, so a percent-encoded literal is not the row', () => {
    expect(paramsOf('/api/metrics', '/api/%6Detrics')).toBeNull();
  });

  it('treats a colon inside a segment as part of the literal', () => {
    expect(paramsOf('/landing/events:stream', '/landing/events:stream')).toEqual({});
    expect(paramsOf('/landing/events:stream', '/landing/events')).toBeNull();
  });
});

describe('matchRow', () => {
  it("finds the module's row in table order", () => {
    expect(matchRow('board-tokens.ts', '/api/board-tokens/refresh')).toEqual({
      pattern: '/api/board-tokens/refresh',
      params: {},
    });
    expect(matchRow('board-tokens.ts', '/api/board-tokens/bt-1/revoke')).toEqual({
      pattern: '/api/board-tokens/:id/revoke',
      params: { id: 'bt-1' },
    });
  });

  it("answers null for a path that is another module's row", () => {
    expect(matchRow('board-tokens.ts', '/api/metrics')).toBeNull();
  });

  it('throws for a module with no rows', () => {
    expect(() => rowPatterns('no-such-module.ts')).toThrow(/no route-table rows/);
  });
});

type Rq = { row: RouteRow };
const rq = (module: string, path: string): Rq => {
  const row = matchRow(module, path);
  if (!row) throw new Error(`no row for ${path}`);
  return { row };
};

describe('rowHandlers', () => {
  const every = {
    '/api/board-tokens': () => 'list',
    '/api/board-tokens/:id/revoke': (_c: null, r: Rq) => `revoke ${r.row.params.id}`,
    '/api/board-tokens/refresh': () => 'refresh',
  };

  it("answers each row with that row's handler", () => {
    const rows = rowHandlers<null, Rq, string>('board-tokens.ts', every);
    expect(rows(null, rq('board-tokens.ts', '/api/board-tokens'))).toBe('list');
    expect(rows(null, rq('board-tokens.ts', '/api/board-tokens/bt-9/revoke'))).toBe('revoke bt-9');
    expect(rows(null, rq('board-tokens.ts', '/api/board-tokens/refresh'))).toBe('refresh');
  });

  it('throws when a row has no handler', () => {
    const { '/api/board-tokens/refresh': _dropped, ...short } = every;
    expect(() => rowHandlers<null, Rq, string>('board-tokens.ts', short)).toThrow(
      /no handler for row \/api\/board-tokens\/refresh/,
    );
  });

  it('throws when a handler names no row', () => {
    expect(() =>
      rowHandlers<null, Rq, string>('board-tokens.ts', {
        ...every,
        '/api/board-tokens/x': () => 'x',
      }),
    ).toThrow(/no route-table row for \/api\/board-tokens\/x/);
  });

  it("with cover 'some', takes a subset and declines the module's other rows", () => {
    const some = rowHandlers<null, Rq, string>('ops.ts', { '/api/deploy': () => 'deploy' }, 'some');
    expect(some(null, rq('ops.ts', '/api/deploy'))).toBe('deploy');
    expect(some(null, rq('ops.ts', '/api/metrics'))).toBeNull();
  });
});

describe('claimRowsWith', () => {
  const app = new Hono();
  claimRowsWith(
    app,
    () => null,
    'board-tokens.ts',
    (_v, row) => Response.json(row),
  );
  const get = async (path: string) => app.fetch(new Request(`http://h${path}`));

  it('hands the handler the row it matched, its param raw', async () => {
    const res = await get('/api/board-tokens/bt%2D1/revoke');
    expect(await res.json()).toEqual({
      pattern: '/api/board-tokens/:id/revoke',
      params: { id: 'bt%2D1' },
    });
  });

  it('hands on a path whose raw spelling matches no row, as the old path tests did', async () => {
    expect((await get('/api/board-tokens')).status).toBe(200);
    // Hono decodes `%2D` before matching, so its middleware runs; no raw row matches.
    expect((await get('/api/board%2Dtokens')).status).toBe(404);
  });
});
