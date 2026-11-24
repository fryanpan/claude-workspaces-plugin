/**
 * Regenerate the two files the route table is copied into:
 * `docs/architecture/routes.md`, and the generated block of
 * `packages/core/src/route-templates.ts` that names spans.
 *
 * The rows are the source; this only prints them. `route-table.test.ts` and
 * `route-templates-drift.test.ts` fail when a copy disagrees with them, so
 * running this is how you answer either failure after adding a route.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_TABLE } from '../packages/server/src/routes/route-table-rows.ts';
import {
  renderRouteTable,
  renderRouteTemplates,
} from '../packages/server/src/routes/route-table.ts';

const root = join(import.meta.dir, '..');

const doc = join(root, 'docs', 'architecture', 'routes.md');
writeFileSync(doc, renderRouteTable(ROUTE_TABLE), 'utf8');
console.log(`wrote ${ROUTE_TABLE.length} routes to ${doc}`);

const templates = join(root, 'packages', 'core', 'src', 'route-templates.ts');
writeFileSync(
  templates,
  renderRouteTemplates(ROUTE_TABLE, readFileSync(templates, 'utf8')),
  'utf8',
);
console.log(`wrote span templates to ${templates}`);
