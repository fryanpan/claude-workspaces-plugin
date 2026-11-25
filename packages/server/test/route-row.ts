/**
 * The route-table row a path matches, for a test that calls a row-dispatched
 * handler directly. The router hands a handler its row; a test does the same
 * through the table, so a path the table has no row for fails here rather
 * than reaching a handler that would never see it.
 */
import { type RouteRow, matchRow } from '../src/routes/row-dispatch.ts';

export function rowAt(module: string, pathname: string): RouteRow {
  const row = matchRow(module, pathname);
  if (!row) throw new Error(`no ${module} row matches ${pathname}`);
  return row;
}
