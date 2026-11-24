/**
 * `packages/core/src/route-templates.ts` is generated from the route table,
 * and this is the check that it was regenerated.
 *
 * Core cannot import the server, so the span namer holds a generated copy of
 * the rows rather than the rows themselves. A copy can go stale: a row added
 * without `bun run routes:table` leaves its route out of the copy, and its
 * spans arrive at Sentry as all-`:id`. Comparing the committed file with what
 * the rows render to is a generator-output check, not a read of source shape.
 *
 * The regenerated text is also LOADED, from a temp file, so the cases below
 * assert what `routePatternForSpan` names after a regeneration rather than
 * which lines the file holds.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROUTE_TABLE } from '../src/route-table-rows.ts';
import { exampleFor, gated, renderRouteTemplates } from '../src/route-table.ts';

const TEMPLATES_FILE = join(import.meta.dir, '../../core/src/route-templates.ts');
const committed = readFileSync(TEMPLATES_FILE, 'utf8');

const scratch = mkdtempSync(join(tmpdir(), 'route-templates-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let loads = 0;
/** Load generated module text and hand back the span namer it defines. */
async function namerFrom(text: string): Promise<(pathname: string) => string> {
  const file = join(scratch, `route-templates-${loads++}.ts`);
  writeFileSync(file, text, 'utf8');
  const mod = (await import(file)) as { routePatternForSpan: (pathname: string) => string };
  return mod.routePatternForSpan;
}

/** A row the server does not have, in the shape a builder would add one. */
const NEW_PATTERN = '/workspaces/:ws/harborlight-check';
const NEW_ROW = gated('trusted-local', {
  pattern: NEW_PATTERN,
  methods: ['GET'],
  module: 'routes/workspace-home.ts',
  example: exampleFor(NEW_PATTERN),
});

/** What the drift check compares: the rows rendered into the file, against the file. */
const isStale = (rows: typeof ROUTE_TABLE, fileText: string): boolean =>
  renderRouteTemplates(rows, fileText) !== fileText;

describe('packages/core/src/route-templates.ts', () => {
  it('is what the rows render to', () => {
    expect(renderRouteTemplates(ROUTE_TABLE, committed)).toBe(committed);
  });

  it('goes stale when a row is added without regenerating, and regenerating clears it', async () => {
    const rows = [...ROUTE_TABLE, NEW_ROW];
    expect(isStale(rows, committed)).toBe(true);

    const regenerated = renderRouteTemplates(rows, committed);
    expect(isStale(rows, regenerated)).toBe(false);

    // The stale copy cannot name the new route; the regenerated one can.
    const stale = await namerFrom(committed);
    const fresh = await namerFrom(regenerated);
    expect(stale('/workspaces/w-1/harborlight-check')).toBe('/:id/:id/:id');
    expect(fresh('/workspaces/w-1/harborlight-check')).toBe('/workspaces/:id/harborlight-check');
  });

  it('keeps the hand-written templates through a regeneration', async () => {
    // `…/outline` has no row, so only the hand-written list names it.
    const fresh = await namerFrom(renderRouteTemplates([...ROUTE_TABLE, NEW_ROW], committed));
    expect(fresh('/workspaces/w-1/docs/d-1/outline')).toBe('/workspaces/:id/docs/:id/outline');
  });

  it('drops a template whose row is removed', async () => {
    const rows = ROUTE_TABLE.filter((r) => r.pattern !== '/workspaces/:ws/keep-moving');
    expect(rows.length).toBeLessThan(ROUTE_TABLE.length);
    const fresh = await namerFrom(renderRouteTemplates(rows, committed));
    expect(fresh('/workspaces/w-1/keep-moving')).toBe('/:id/:id/:id');
  });

  it('refuses a file whose generated-block markers are gone', () => {
    expect(() => renderRouteTemplates(ROUTE_TABLE, 'export const X = 1;\n')).toThrow(
      /markers are missing/,
    );
  });
});
