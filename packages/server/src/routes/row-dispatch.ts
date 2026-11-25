/**
 * ── Dispatch from the route table's rows ──
 *
 * A row-dispatched family (see `hono-families.ts`) is registered on its rows
 * in `route-table-rows.ts`, and its handler is handed the row the request
 * matched: the row's pattern and the values of its `:name` segments. The
 * handler does not test the path again. It looks its row up in a map of
 * one function per pattern (`rowHandlers`), and reads ids from the params.
 *
 * So adding a route to such a family is one row in the table and one entry
 * in the family's map. The map is checked against the table when the module
 * loads: a row with no entry, or an entry with no row, throws at boot rather
 * than leaving an address that nothing answers.
 *
 * PARAMS ARE RAW. A param is the path segment as the request spelt it,
 * before any percent-decoding, which is what the `([^/]+)` captures these
 * handlers used to take were. A handler that decoded its capture still
 * decodes its param. Hono's own `c.req.param()` decodes, so it is not used.
 *
 * MATCHING IS ON THE RAW PATH TOO. Hono matches a percent-decoded path, so
 * `/api/%6Detrics` reaches the `/api/metrics` middleware. The old handlers
 * compared the raw `url.pathname` and declined it; `matchRow` compares raw
 * segments, so such a request still finds no row and is declined the same
 * way.
 */
import { ROUTE_TABLE } from '../route-table-rows.ts';

export type RowParams = Readonly<Record<string, string>>;

/** The row a request matched: its pattern, and its `:name` segment values. */
export interface RouteRow {
  readonly pattern: string;
  readonly params: RowParams;
}

/**
 * Every distinct pattern the route table holds for one module, in table
 * order. `module` is relative to `routes/`, as a row names it without the
 * prefix. A module with no rows throws, so a misspelt name cannot register a
 * family on nothing and silently answer no address.
 */
export function rowPatterns(module: string): string[] {
  const patterns = [
    ...new Set(ROUTE_TABLE.filter((r) => r.module === `routes/${module}`).map((r) => r.pattern)),
  ];
  if (patterns.length === 0) throw new Error(`rowPatterns: no route-table rows for ${module}`);
  return patterns;
}

/** A pattern this module can match: literal segments and `:name` segments only. */
function isPlain(pattern: string): boolean {
  return pattern.startsWith('/') && !/[*{}?]/.test(pattern);
}

/**
 * The params `pathname` binds under `pattern`, or null when it does not
 * match. Segment by segment on the raw path: a `:name` segment takes any
 * non-empty segment, every other segment must be equal.
 */
export function paramsOf(pattern: string, pathname: string): RowParams | null {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] ?? '';
    const g = got[i] ?? '';
    if (w.startsWith(':')) {
      if (g === '') return null;
      params[w.slice(1)] = g;
    } else if (w !== g) {
      return null;
    }
  }
  return params;
}

/** The first of `module`'s rows that `pathname` matches, in table order. */
export function matchRow(module: string, pathname: string): RouteRow | null {
  for (const pattern of rowPatterns(module)) {
    const params = paramsOf(pattern, pathname);
    if (params) return { pattern, params };
  }
  return null;
}

/** One row's handler. Its params are `rq.row.params`. */
export type RowHandler<C, R, A> = (ctx: C, rq: R) => A;

/**
 * A module's handlers, one per row pattern, as one function that answers the
 * row `rq.row` names and declines (null) any other.
 *
 * `cover: 'every'` (the default) requires an entry for every row of `module`
 * and no other; `'some'` is for a module split across several exported
 * handlers, and requires only that every entry is a row of `module`. Both
 * are checked here, once, when the calling module loads.
 */
export function rowHandlers<C, R extends { row: RouteRow }, A>(
  module: string,
  handlers: Readonly<Record<string, RowHandler<C, R, A>>>,
  cover: 'every' | 'some' = 'every',
): (ctx: C, rq: R) => A | null {
  const rows = rowPatterns(module);
  const named = Object.keys(handlers);
  const strays = named.filter((p) => !rows.includes(p));
  if (strays.length > 0) {
    throw new Error(`rowHandlers(${module}): no route-table row for ${strays.join(', ')}`);
  }
  if (cover === 'every') {
    const missing = rows.filter((p) => !named.includes(p));
    if (missing.length > 0) {
      throw new Error(`rowHandlers(${module}): no handler for row ${missing.join(', ')}`);
    }
  }
  const unplain = named.filter((p) => !isPlain(p));
  if (unplain.length > 0) {
    throw new Error(`rowHandlers(${module}): cannot match ${unplain.join(', ')} by segment`);
  }
  const table = new Map(Object.entries(handlers));
  return (ctx, rq) => {
    const handler = table.get(rq.row.pattern);
    return handler ? handler(ctx, rq) : null;
  };
}
