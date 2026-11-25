/**
 * Which Hono patterns the router registers, and where each one comes from.
 *
 * A row-dispatched family is registered on exactly its own rows of
 * `ROUTE_TABLE`, so a row added to the table is answered without a second
 * pattern being written in the router, and the router answers nothing the
 * table does not name. This file records the patterns each app registers,
 * family by family, through a stand-in app that only notes them, and holds
 * both halves of that claim.
 *
 * The families still claimed by hand are named below with their patterns.
 * Each one's handler answers addresses the table has no row for (a 404 under
 * its prefix, a visitor refusal on a loose `startsWith`), so narrowing it to
 * its rows would change what those addresses get. Moving one onto its rows
 * means taking it out of that list.
 */
import { describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { ROUTE_TABLE } from '../src/route-table-rows.ts';
import {
  type HonoBoardFamiliesContext,
  honoBoardFamilies,
} from '../src/routes/hono-board-families.ts';
import { type HonoFamiliesContext, honoFamilies } from '../src/routes/hono-families.ts';
import {
  type HonoOpenFamiliesContext,
  honoOpenFamilies,
} from '../src/routes/hono-open-families.ts';

/** The patterns one family registered, by calling it on an app that only records. */
function patternsOf(family: (app: Hono<never>) => void): string[] {
  const seen: string[] = [];
  const recorder = {
    all: (pattern: string) => seen.push(pattern),
    use: () => undefined,
  };
  family(recorder as unknown as Hono<never>);
  return [...new Set(seen)];
}

/** Every distinct pattern the table holds for one module. */
const rowsOf = (module: string): string[] => [
  ...new Set(ROUTE_TABLE.filter((r) => r.module === `routes/${module}`).map((r) => r.pattern)),
];

const ALL_ROW_PATTERNS = new Set(ROUTE_TABLE.map((r) => r.pattern));

// No context is read while the families register; only their handlers read one.
const front = honoFamilies({} as HonoFamiliesContext).map((f) => patternsOf(f as never));
const open = honoOpenFamilies({} as HonoOpenFamiliesContext).map((f) => patternsOf(f as never));
const board = honoBoardFamilies({} as HonoBoardFamiliesContext).map((f) => patternsOf(f as never));

describe('the router registers row-dispatched families on their rows', () => {
  const cases: ReadonlyArray<[app: string, patterns: string[][], modules: string[]]> = [
    [
      'front',
      front,
      [
        'voice-agent-llm.ts',
        'recall-webhook.ts',
        'mcp-connector.ts',
        'agent-identity.ts',
        'board-tokens.ts',
        'board-socket-roots.ts',
        'load-reports.ts',
        'ops.ts',
        'landing-stream.ts',
        'review-queue.ts',
        'voice-page.ts',
        'voice-api.ts',
        'private-messages.ts',
      ],
    ],
    ['open', open, ['home-feed.ts', 'board-import.ts', 'github-hub.ts']],
    ['board', board, ['chat-audit-routes.ts', 'doc-move.ts']],
  ];
  for (const [app, families, modules] of cases) {
    for (const module of modules) {
      it(`${app}: ${module} is registered on exactly its rows`, () => {
        const rows = rowsOf(module);
        expect(rows.length).toBeGreaterThan(0);
        expect(families.map((f) => f.slice().sort())).toContainEqual(rows.slice().sort());
      });
    }
  }
});

describe('the patterns the router still writes by hand', () => {
  it('front: only the families whose handlers answer beyond their rows', () => {
    const handWritten = front.flat().filter((p) => !ALL_ROW_PATTERNS.has(p));
    expect(handWritten.sort()).toEqual(
      [
        // routes/auth-share.ts
        '/api/auth/*',
        '/api/share/*',
        // routes/repos.ts
        '/api/repos/*',
        // routes/mounts.ts
        '/mounts',
        '/mounts/*',
        '/api/mounts/*',
        // routes/prompts.ts
        '/api/:rest{prompts.*}',
        // routes/access.ts
        '/access/*',
        // routes/inbox.ts
        '/inbox/*',
        // routes/coach.ts
        '/coach/*',
      ].sort(),
    );
  });

  it('open: none', () => {
    expect(open.flat().filter((p) => !ALL_ROW_PATTERNS.has(p))).toEqual([]);
  });
});
