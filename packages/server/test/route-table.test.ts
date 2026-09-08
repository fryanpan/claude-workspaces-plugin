/**
 * The route table is a claim about this server, and this is what checks it.
 *
 * Three properties, and each one is a different way the table could become a
 * lie: the rows could stop describing addresses the server has, the GATE a
 * row names could stop being the gate the guard applies, and the rendered
 * `docs/architecture/routes.md` could drift from the rows.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ShareTarget, shareScopeAllows } from '../src/middleware/host-guard.ts';
import { ROUTE_TABLE } from '../src/routes/route-table-rows.ts';
import {
  type RouteEntry,
  exampleFor,
  gated,
  mountRouteTable,
  patternMatches,
  renderRouteTable,
} from '../src/routes/route-table.ts';

const SHARED_BOARD = 'w-shared';
const TARGET: ShareTarget = { workspaceId: SHARED_BOARD };

/**
 * Every id an example path can name belongs to the shared board.
 *
 * That is the generous case on purpose: it is the visitor with the widest
 * legitimate claim, so anything the guard still refuses is refused by the
 * rule and not by a bookkeeping accident in this test.
 */
const workspacesOf = (): string[] => [SHARED_BOARD];

/**
 * Does the HOST GUARD admit a share visitor to this address?
 *
 * `owner-in-handler` counts: the guard admits it and the route refuses the
 * visitor a layer lower, which is the whole reason that gate has a name.
 */
const guardAdmitsAVisitor = (entry: RouteEntry): boolean =>
  entry.gate === 'share-scope' ||
  entry.gate === 'collab-scope' ||
  entry.gate === 'owner-in-handler';

describe('gated()', () => {
  it('refuses an ungated route that does not say why reading it is free', () => {
    expect(() =>
      gated('open', { pattern: '/x', methods: ['GET'], module: 'm.ts', example: '/x' }),
    ).toThrow(/why reading it is free/);
    expect(() =>
      gated('open', {
        pattern: '/x',
        methods: ['GET'],
        module: 'm.ts',
        example: '/x',
        reason: '  ',
      }),
    ).toThrow(/why reading it is free/);
  });

  it('accepts an ungated route that does', () => {
    const entry = gated('open', {
      pattern: '/x',
      methods: ['GET'],
      module: 'm.ts',
      example: '/x',
      reason: 'answered above the host guard',
    });
    expect(entry.gate).toBe('open');
  });

  it('refuses an owner-in-handler route that does not name where the refusal lives', () => {
    expect(() =>
      gated('owner-in-handler', {
        pattern: '/x',
        methods: ['POST'],
        module: 'm.ts',
        example: '/x',
      }),
    ).toThrow(/must name the refusal/);
  });

  it('refuses a gated route that answers no method', () => {
    expect(() =>
      gated('trusted-local', { pattern: '/x', methods: [], module: 'm.ts', example: '/x' }),
    ).toThrow(/no methods/);
  });
});

describe('exampleFor()', () => {
  it('fills every parameter and keeps every literal segment', () => {
    expect(exampleFor('/workspaces/:ws/docs/:docId/threads/:threadId')).toBe(
      '/workspaces/w-shared/docs/doc-1/threads/th-1',
    );
    expect(exampleFor('/workspaces/:ws/docs:attach')).toBe('/workspaces/w-shared/docs:attach');
    expect(exampleFor('/app/*')).toBe('/app/asset.js');
  });

  it('refuses a parameter it has no value for, rather than inventing one', () => {
    expect(() => exampleFor('/x/:nothingKnowsThis')).toThrow(/no example value/);
  });
});

describe('the route table', () => {
  it('is not empty, and every row’s example is an address its own pattern matches', () => {
    expect(ROUTE_TABLE.length).toBeGreaterThan(100);
    for (const entry of ROUTE_TABLE) {
      expect(patternMatches(entry.pattern, entry.example), entry.pattern).toBe(true);
    }
  });

  it('names each pattern/method pair once', () => {
    const seen = new Map<string, string>();
    for (const entry of ROUTE_TABLE) {
      for (const method of entry.methods) {
        const key = `${method} ${entry.pattern}`;
        expect(seen.has(key) ? `${key} also in ${seen.get(key)}` : key, key).toBe(key);
        seen.set(key, entry.module);
      }
    }
  });

  it('names a module for every row', () => {
    for (const entry of ROUTE_TABLE) {
      expect(entry.module, entry.pattern).toMatch(/\.ts$/);
    }
  });
});

/**
 * The property the table exists for.
 *
 * `shareScopeAllows` is the guard's own decision, a pure function of the
 * path, the method and the share. Driving it with each row's example turns
 * the gate column into something CI checks rather than something a reviewer
 * hopes is true — a route added under an already-allowed prefix and declared
 * `trusted-local` fails here, and so does one declared `share-scope` that the
 * guard does not actually let a visitor reach.
 */
describe('every row’s declared gate is the gate the guard applies', () => {
  for (const entry of ROUTE_TABLE) {
    if (entry.gate === 'open') continue;
    for (const method of entry.methods) {
      it(`${method} ${entry.pattern} — ${entry.gate}`, () => {
        expect(shareScopeAllows(entry.example, method, TARGET, workspacesOf)).toBe(
          guardAdmitsAVisitor(entry),
        );
      });
    }
  }

  it('grants a share visitor nothing at all on another board', () => {
    for (const entry of ROUTE_TABLE) {
      if (!entry.example.startsWith(`/workspaces/${SHARED_BOARD}/`)) continue;
      const elsewhere = entry.example.replace(
        `/workspaces/${SHARED_BOARD}/`,
        '/workspaces/w-other/',
      );
      for (const method of entry.methods) {
        expect(shareScopeAllows(elsewhere, method, TARGET, workspacesOf), elsewhere).toBe(false);
      }
    }
  });
});

describe('mountRouteTable()', () => {
  it('mounts every pattern on the caller’s own handler, and mounts the fallback on none', () => {
    const handler = (): string => 'front door';
    const mounted = mountRouteTable(ROUTE_TABLE, handler);
    const expected = new Set(ROUTE_TABLE.map((e) => e.pattern).filter((p) => p !== '*'));
    expect(new Set(Object.keys(mounted))).toEqual(expected);
    for (const value of Object.values(mounted)) expect(value).toBe(handler);
  });
});

describe('docs/architecture/routes.md', () => {
  it('is what the rows render to', () => {
    const checkedIn = readFileSync(
      join(import.meta.dir, '../../../docs/architecture/routes.md'),
      'utf8',
    );
    expect(renderRouteTable(ROUTE_TABLE)).toBe(checkedIn);
  });
});
