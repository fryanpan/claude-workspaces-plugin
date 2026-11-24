/**
 * Reading share scope off the route table admits nothing the hand-written
 * allowlist did not.
 *
 * `shareScopeAllows` used to be five tables and two if-chains in
 * `middleware/host-guard.ts`; it is now the route table's share-visible rows
 * plus one rule per path parameter. `fixtures/share-scope-old-allowed.json` is
 * every probe the OLD function admitted, recorded from it at 32712935e over
 * the frozen probe set in `share-scope-probes.ts`. This file holds the new
 * function to that record:
 *
 * - it admits no probe the old one refused (no widening, without exception);
 * - every probe the old one admitted, it admits too, except the probes in
 *   `NARROWED`, each a named class of address no route answers with that
 *   method. A probe outside every class, or one a row does answer, fails.
 *
 * Making the record: `share-scope-probes.ts` is the input, and the old
 * function is in git (`git show 32712935e:packages/server/src/middleware/host-guard.ts`).
 * Never regenerate it from the new function: it is the old behaviour or it is
 * nothing.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shareRoutesOf, shareScopeAllows, shareScopeFrom } from '../src/middleware/host-guard.ts';
import { ROUTE_TABLE } from '../src/route-table-rows.ts';
import { exampleFor, gated, patternMatches } from '../src/route-table.ts';
import {
  METHODS,
  OTHER,
  SHARED,
  TARGETS,
  probeKey,
  probePaths,
  workspacesOf,
} from './share-scope-probes.ts';

const RECORD = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'share-scope-old-allowed.json'), 'utf8'),
) as { allowed: string[] };
const OLD_ALLOWED = new Set(RECORD.allowed);

/**
 * The addresses the old allowlist admitted and the rows do not, each with why
 * nothing is lost. Matched against `<method> <path>`.
 */
const NARROWED: readonly { readonly why: string; readonly match: RegExp }[] = [
  {
    why: 'the shell’s static files answered every method; their rows list GET, the one a page fetches them with',
    match:
      /^(?!GET )\S+ \/(app\/.*|widget\/.*|widget\.js|widget\.esm\.js|widget\.iife\.js|favicon\.ico|manifest\.webmanifest|apple-touch-icon\.png|icon\.svg|icon-192\.png|icon-512\.png)$/,
  },
  { why: 'bare `/app` has no handler; the files are under `/app/`', match: /^\S+ \/app$/ },
  {
    why: 'a trailing-slash board address and a `mine` pane, neither of which the board page answers',
    match: /^GET \/workspaces\/[^/]+\/(mine)?$/,
  },
  {
    why: 'the old rule admitted every method under a doc’s `threads/` and `suggestions/`; only the verbs with rows are answered',
    match: /^\S+ \/workspaces\/[^/]+\/docs\/[^/]*\/(threads|suggestions)(\/.*)?$/,
  },
  {
    why: 'a mockup’s and a whiteboard’s data is its doc’s, under `docs/`; nothing answers these under their page’s collection',
    match: /^\S+ \/workspaces\/[^/]+\/(mockups|whiteboards)\/[^/]*\/.+$/,
  },
  {
    why: 'an empty id segment, which names nothing: Bun’s router does not match one, and every handler’s own pattern is `[^/]+`',
    match: /^\S+ \/workspaces\/[^/]+\/(members\/(\/role)?|tasks\/[^/]+\/review-items\/\/answer)$/,
  },
];

/** Does a row's `:name` segment sit on an empty segment of this path? Bun never matches that. */
const emptyParam = (pattern: string, path: string): boolean => {
  const got = path.split('/');
  return pattern.split('/').some((seg, i) => seg.startsWith(':') && got[i] === '');
};

/** Does any row (other than the two answered above the guard at `*`) answer this? */
const aRowAnswers = (method: string, path: string): string | null => {
  const row = ROUTE_TABLE.find(
    (r) =>
      r.pattern !== '*' &&
      r.methods.includes(method) &&
      patternMatches(r.pattern, path) &&
      !emptyParam(r.pattern, path),
  );
  return row ? `${row.gate} ${row.pattern}` : null;
};

interface Verdicts {
  widened: string[];
  narrowed: { key: string; method: string; path: string }[];
}

function compare(): Verdicts {
  const widened: string[] = [];
  const narrowed: Verdicts['narrowed'] = [];
  for (const [name, target] of Object.entries(TARGETS)) {
    for (const method of METHODS) {
      for (const path of probePaths()) {
        const key = probeKey(name, method, path);
        const now = shareScopeAllows(path, method, target, workspacesOf);
        const before = OLD_ALLOWED.has(key);
        if (now && !before) widened.push(key);
        if (before && !now) narrowed.push({ key, method, path });
      }
    }
  }
  return { widened, narrowed };
}

describe('share scope read off the route table, against the old allowlist', () => {
  const { widened, narrowed } = compare();

  it('the record is the old allowlist’s, not an empty file', () => {
    // A positive control on the fixture itself: the old function admitted
    // the board, a doc on it and the app shell, and these must be in it.
    for (const key of [
      `shared GET /workspaces/${SHARED}`,
      `shared GET /workspaces/${SHARED}/docs/doc-1/threads`,
      `shared POST /workspaces/${SHARED}/tasks/t-1/transition`,
      'shell GET /widget.js',
    ]) {
      expect(OLD_ALLOWED.has(key), key).toBe(true);
    }
    expect(OLD_ALLOWED.size).toBeGreaterThan(1000);
  });

  it('admits no probe the old allowlist refused', () => {
    expect(widened).toEqual([]);
  });

  it('refuses an old-admitted probe only in a named class no route answers', () => {
    const unexplained = narrowed
      .filter(({ method, path }) => !NARROWED.some((n) => n.match.test(`${method} ${path}`)))
      .map((n) => n.key);
    expect(unexplained).toEqual([]);
    const answered = narrowed
      .map(({ key, method, path }) => {
        const row = aRowAnswers(method, path);
        return row ? `${key} ← ${row}` : null;
      })
      .filter((x): x is string => x !== null);
    expect(answered).toEqual([]);
  });

  it('names no class that narrows nothing', () => {
    for (const n of NARROWED) {
      expect(
        narrowed.some(({ method, path }) => n.match.test(`${method} ${path}`)),
        n.why,
      ).toBe(true);
    }
  });

  it('still refuses every id on another board, under every share row', () => {
    for (const path of probePaths()) {
      if (!path.includes(OTHER) && !/-other(\/|$)/.test(path)) continue;
      for (const method of METHODS) {
        expect(shareScopeAllows(path, method, TARGETS.shared ?? {}, workspacesOf), path).toBe(
          false,
        );
      }
    }
  });
});

describe('a share row is the only thing that opens an address', () => {
  const row = (gate: Parameters<typeof gated>[0], methods = 'GET') =>
    gated(gate, {
      pattern: '/workspaces/:ws/docs/:docId/riverbend',
      methods: methods.split(' '),
      module: 'routes/riverbend.ts',
      example: exampleFor('/workspaces/:ws/docs/:docId/riverbend'),
    });
  const path = `/workspaces/${SHARED}/docs/doc-1/riverbend`;
  const target = { workspaceId: SHARED };

  it('refuses a new row filed under a gate a share visitor does not pass', () => {
    for (const gate of ['trusted-local', 'loopback-only', 'home-feed'] as const) {
      const allows = shareScopeFrom(shareRoutesOf([...ROUTE_TABLE, row(gate)]));
      expect(allows(path, 'GET', target, workspacesOf), gate).toBe(false);
    }
  });

  it('admits the same row filed as share-scope, for its own methods and its own board only', () => {
    const allows = shareScopeFrom(shareRoutesOf([...ROUTE_TABLE, row('share-scope')]));
    expect(allows(path, 'GET', target, workspacesOf)).toBe(true);
    expect(allows(path, 'POST', target, workspacesOf)).toBe(false);
    expect(allows(path.replace('doc-1', 'doc-other'), 'GET', target, workspacesOf)).toBe(false);
    expect(allows(path.replace(SHARED, OTHER), 'GET', target, workspacesOf)).toBe(false);
  });

  it('refuses to read a share row whose parameter has no scope rule', () => {
    const odd = gated('share-scope', {
      pattern: '/workspaces/:ws/riverbend/:slug',
      methods: ['GET'],
      module: 'routes/riverbend.ts',
      example: exampleFor('/workspaces/:ws/riverbend/:slug'),
    });
    expect(() => shareRoutesOf([odd])).toThrow(/no PARAM_SCOPE entry for :slug/);
  });

  it('refuses to read a share row with a parameter outside a board', () => {
    const odd = gated('share-scope', {
      pattern: '/riverbend/:docId',
      methods: ['GET'],
      module: 'routes/riverbend.ts',
      example: exampleFor('/riverbend/:docId'),
    });
    expect(() => shareRoutesOf([odd])).toThrow(/outside \/workspaces\/:ws\//);
  });

  it('refuses a method spelled in lower case, which no row lists', () => {
    expect(shareScopeAllows(`/workspaces/${SHARED}`, 'GET', target, workspacesOf)).toBe(true);
    expect(shareScopeAllows(`/workspaces/${SHARED}`, 'get', target, workspacesOf)).toBe(false);
  });
});
