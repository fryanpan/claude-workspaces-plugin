/**
 * Every route a contract declares is a route the server serves.
 *
 * A contract (`src/routes/route-contract.ts`) declares the routes the MCP's
 * typed client may call, and never serves them itself. So a declared path that
 * no family answers would typecheck in the MCP and fail at a session's first
 * call. This test holds each declared route to its row in
 * `fixtures/route-answers.json`, which `route-answers.test.ts` keeps true
 * against a real server, and requires that row to be answered by one of the
 * family handlers the contract names.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { attachmentsContract } from '../src/routes/attachments-contract.ts';
import { docEditsContract } from '../src/routes/doc-edits-contract.ts';
import { docLifecycleContract } from '../src/routes/doc-lifecycle-contract.ts';
import { docThreadsContract } from '../src/routes/doc-threads-contract.ts';

const answers = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'route-answers.json'), 'utf8'),
) as Record<string, string>;

/** Each contract, and the handlers that may answer what it declares. */
const CONTRACTS: Array<{ name: string; app: Hono; servedBy: string[] }> = [
  {
    name: 'doc threads',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: docThreadsContract as unknown as Hono<any>,
    servedBy: [
      'doc-threads-routes.ts:handleDocThreadRoutes',
      'doc-thread-linked-item.ts:handleDocThreadLinkedItemRoute',
      'doc-resource.ts:handleDocResourceCore',
      'docs.ts:handleDocPromoteRoute',
    ],
  },
  {
    name: 'doc edits',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: docEditsContract as unknown as Hono<any>,
    servedBy: ['doc-edit-routes.ts:handleDocEditRoutes'],
  },
  {
    name: 'doc lifecycle',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: docLifecycleContract as unknown as Hono<any>,
    servedBy: [
      'docs.ts:handleDocCreateListRoutes',
      'doc-resource.ts:handleDocResourceCore',
      'doc-edit-routes.ts:handleDocEditRoutes',
      'archive.ts:handleArchiveRoutes',
      'apps.ts:handleAppRoutes',
    ],
  },
  {
    name: 'attachments',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: attachmentsContract as unknown as Hono<any>,
    servedBy: [
      'workspaces-create-read.ts:handleWorkspaceCreateRead',
      'archive.ts:handleArchiveRoutes',
      'review-files.ts:handleReviewFileRoutes',
      'workspace-delete.ts:handleWorkspaceDelete',
    ],
  },
];

/** `METHOD /path` for every route the app declares, once each. */
function declared(app: Hono): string[] {
  return [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))];
}

describe('route contracts', () => {
  for (const { name, app, servedBy } of CONTRACTS) {
    it(`declares only routes the server serves: ${name}`, () => {
      const routes = declared(app);
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        const answer = answers[route];
        expect(answer, `${route} has no row in route-answers.json`).toBeDefined();
        const by = answer?.split('| by ')[1] ?? '';
        expect(
          servedBy.some((handler) => by.includes(handler)),
          `${route} is answered by ${by}`,
        ).toBe(true);
      }
    });
  }

  // The control: a route no family serves fails the same check.
  it('refuses a declared route that no family answers', () => {
    const by = answers['POST /workspaces/:ws/docs/:docId/threads/:threadId/close'];
    expect(by).toBeUndefined();
    const unserved = answers['DELETE /api/attachments']?.split('| by ')[1] ?? '';
    expect(CONTRACTS[0]?.servedBy.some((h) => unserved.includes(h))).toBe(false);
  });
});
