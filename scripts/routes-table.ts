/**
 * Regenerate `docs/architecture/routes.md` from the route table.
 *
 * The rows are the source; this only prints them. `route-table.test.ts` fails
 * when the two disagree, so running this is how you answer that failure after
 * adding a route.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_TABLE } from '../packages/server/src/routes/route-table-rows.ts';
import { renderRouteTable } from '../packages/server/src/routes/route-table.ts';

const out = join(import.meta.dir, '..', 'docs', 'architecture', 'routes.md');
writeFileSync(out, renderRouteTable(ROUTE_TABLE), 'utf8');
console.log(`wrote ${ROUTE_TABLE.length} routes to ${out}`);
