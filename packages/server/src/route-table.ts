/**
 * ── The route table: every front-door path pattern, and the gate it is behind ──
 *
 * WHY THIS EXISTS. Until this file, the answer to "what does this server
 * answer, and what stops a stranger reading it?" was a 560-line ordered chain
 * plus thirty-odd modules under `routes/`, each naming its own paths. Nobody
 * could read the set, so nobody could see a route that had been added ABOVE
 * the gate that was supposed to cover it — the one mistake in this shape that
 * is a breach rather than a bug. `ROUTE_TABLE` is that set written once, and
 * `test/route-table.test.ts` turns each row's declared gate into a claim CI
 * checks against the guard's own decision.
 *
 * WHAT A ROW CLAIMS. A row names a path pattern, the methods it answers, the
 * module that decides it, and the gate it sits behind. The gate is not a
 * label: `shareScopeAllows` in `middleware/host-guard.ts` is BUILT from it.
 * A share visitor reaches exactly the rows whose gate is in
 * `SHARE_VISIBLE_GATES`, for the methods the row lists, and nothing else, so
 * the row is the only place a share-visible path is written. The test still
 * drives the guard with every row's own `example` path, which is what catches
 * a share row whose pattern overlaps a `trusted-local` one.
 *
 * WHY THESE FILES ARE NOT UNDER `routes/`. They name paths but answer none,
 * and the host guard reads them: only `server.ts` may import out of
 * `routes/`, so a registry the guard reads lives beside it.
 *
 * WHY MOUNTING IT CHANGES NO DISPATCH. `mountRouteTable` builds the object
 * `Bun.serve` takes as `routes`, and every entry's handler is the SAME
 * front-door handler an unmatched address reaches through `fetch`. That is
 * deliberate. Bun matches by specificity; this router's order is BEHAVIOUR in
 * eight places its comments name, among them:
 *
 *   - the Recall status webhook immediately above the `/recall/` upgrade,
 *     whose own test is `startsWith('/recall/')` and would answer a status
 *     POST with the token lookup's 404;
 *   - every `…/docs/:docId/meetings…` pattern above the doc resource
 *     catch-all, which would otherwise swallow all of them;
 *   - `threads/:threadId/promote` above the doc resource block, and
 *     `threads/by_find` below the `threads` POST;
 *   - the browser-write refusal on `/api/share*` above every share route, so
 *     a mint added later is covered by construction;
 *   - `/share/<slug>` redemption above the retired `/s/<slug>` reply, both
 *     above the mints;
 *   - the workspace-scope resolver below the stream block and above every
 *     REST handler;
 *   - the wrong-prefix 404 below everything that exists, so it shadows
 *     nothing.
 *
 * Handing dispatch to a matcher that does not know those adjacencies would
 * change what a request is answered by, and this table exists to make the
 * server readable, not to re-route it. So the table is the REGISTRY and the
 * chain is the ROUTER. Mounting is still what keeps the registry honest: it
 * is a value Bun holds rather than a document that rots, and the drift test
 * reads the same object.
 *
 * HONO (M12). Families are moving one at a time into the Hono app in
 * `hono-front.ts`, which the chain tries below its gates and above every
 * family it still holds. A row's `module` names whichever module answers it;
 * `test/route-answers.test.ts` records what every row answers and fails when a
 * move changes any of it.
 *
 * ROWS THAT DISPATCH. The ORDER of families stays in the router, but for a
 * family whose handler answers only the addresses its rows name, the PATTERNS
 * it is registered on are its rows (`rowPatterns` in `routes/hono-families.ts`).
 * For those modules a row is no longer only a claim: delete one and its
 * address stops being answered. Eighteen modules are dispatched this way; the
 * rest still register hand-written patterns, and
 * `test/hono-row-dispatch.test.ts` names both sets.
 *
 * ADDING A ROUTE. Add its row here in the same commit, then run
 * `bun run routes:table`. It writes the rendered table,
 * `docs/architecture/routes.md`, and the span-name templates in
 * `packages/core/src/route-templates.ts`; a drift test fails on each until it
 * agrees with the rows.
 */

/**
 * What stands between a stranger and this address.
 *
 * The vocabulary is `docs/architecture/security.md`'s, not a new one:
 *
 * - `trusted-local` — reachable only from a trusted local host, or an
 *   Access-verified operator host. This is the default, and a share visitor
 *   is refused it.
 * - `loopback-only` — additionally requires a loopback peer address and
 *   refuses anything carrying `cf-ray`. The deploy POST, the Sentry state,
 *   the agent merge, the agent token, watch set and event stream, the mount
 *   table and the repo registry. The plugin refresh is NOT one: its POST
 *   refuses `cf-ray` and a browser but checks no address. Unlike the share
 *   gates, `shareScopeAllows` cannot tell this gate from `trusted-local`, so
 *   `test/route-table-loopback.test.ts` checks it by dialling each row from
 *   a loopback and a non-loopback address.
 * - `share-scope` — a share visitor scoped to the board in the path reaches
 *   it: `shareScopeAllows` admits it, for the row's methods, when every id in
 *   the path is inside that board (`PARAM_SCOPE` in `host-guard.ts` says what
 *   each parameter must belong to).
 * - `owner-in-handler` — the host guard ADMITS a visitor to this address, and
 *   the route refuses one itself. Owner-only, enforced a layer lower than
 *   every other owner-only route, which is exactly why it needs a name: a
 *   route added under an allowed prefix either declares `share-scope` and
 *   says so, or declares this and carries the refusal. The guard admits it
 *   exactly as it admits `share-scope`, so the `reason` must name where the
 *   refusal lives.
 * - `collab-scope` — reached through `collabScope`, which is
 *   `shareScopeAllows` plus a membership check on a collaboration host. Only
 *   the board's own Yjs socket, where the membership half is the operative
 *   condition.
 * - `recall-callback` — served only on the vendor callback host, and carrying
 *   its own credential (an unguessable token in the path, a Svix signature
 *   over the body, or setup 4's bearer secret).
 * - `home-feed` — answered ABOVE the host guard by `routes/home-feed.ts`,
 *   which admits two callers only: a loopback peer with no `cf-ray`, or an
 *   Access stamp naming no email whose `common_name` is the service token
 *   client id this server was configured with. No person and no share or
 *   collab visitor reaches it.
 * - `github-push` — answered ABOVE the host guard by `routes/github-hub.ts`:
 *   the `home-feed` caller check, then the board's live push key (`gp1`).
 *   A request carrying a cookie is refused before either. The Mac's GitHub
 *   relay is its one caller.
 * - `board-import` — answered ABOVE the host guard by `routes/board-import.ts`,
 *   and only on a project machine (`CW_BOARD_IMPORT_DIR`). Through the tunnel
 *   only (`cf-ray`), an Access stamp for the host's own application naming no
 *   email and carrying a `common_name`, and a board the machine is for. No
 *   person, no loopback caller and no share or collab visitor reaches it.
 * - `open` — answered ABOVE the host guard. A row claiming this must say in
 *   `reason` why reading it is free; `gated` refuses one that does not.
 */
export type RouteGate =
  | 'trusted-local'
  | 'loopback-only'
  | 'share-scope'
  | 'owner-in-handler'
  | 'collab-scope'
  | 'recall-callback'
  | 'home-feed'
  | 'github-push'
  | 'board-import'
  | 'open';

/** One front-door path pattern. */
export interface RouteEntry {
  /** Bun's pattern syntax: `:name` for a segment, `*` for a wildcard tail. */
  readonly pattern: string;
  /** The methods this pattern answers, uppercase, in a stable order. */
  readonly methods: readonly string[];
  /** The module that decides it, relative to `packages/server/src/`. */
  readonly module: string;
  /** The gate it sits behind. */
  readonly gate: RouteGate;
  /**
   * A concrete path matching `pattern`, with every parameter filled.
   *
   * This is what makes the gate a checked claim rather than a comment: the
   * test hands it to `shareScopeAllows` and compares the guard's answer with
   * `gate`. A row whose example does not match its own pattern is caught by
   * the same test.
   */
  readonly example: string;
  /**
   * Why reading it is free (`open`), or where the in-route refusal lives
   * (`owner-in-handler`). Required for both, and optional otherwise.
   */
  readonly reason?: string;
}

/**
 * The stand-in value each path parameter takes in a row's `example`.
 *
 * Derived rather than written per row, for two reasons. A hand-written
 * example is a second spelling of the pattern and drifts from it silently —
 * the table would then be checking the gate of an address the server does not
 * have. And the ids have to be the ones the test's `workspacesOf` answers
 * for, so they belong beside the substitution rather than in 190 literals.
 */
const EXAMPLE_PARAMS: Readonly<Record<string, string>> = {
  ws: 'w-shared',
  docId: 'doc-1',
  taskId: 't-1',
  goalId: 'g-1',
  setId: 'rev-1',
  threadId: 'th-1',
  itemId: 'ri-1',
  lineId: 'dw-1',
  agentId: 'a-1',
  agent: 'a-1',
  meetingId: 'm-1',
  anchorId: 'an-1',
  sid: 's-1',
  id: 'x-1',
  slug: 'sl-1',
  shareId: 'sh-1',
  owner: 'o-1',
  eventId: 'ev-1',
  fileId: 'f-1',
  folderId: 'fo-1',
  personId: 'user-1',
  // The access page's sections: `waiting`, or one board's id.
  section: 'waiting',
  // A voice feedback recording — the handler matches `seg-<N>.wav` exactly.
  file: 'seg-1.wav',
  // A membership is addressed by the address Cloudflare verified. The example
  // stands in for one rather than being one: this table renders into a public
  // document, and a rendered address there is a person's, invented or not.
  email: 'member-1',
  token: '0123456789abcdef0123456789abcdef',
};

/** The concrete path a pattern's parameters, filled in, spell. */
export function exampleFor(pattern: string): string {
  // `*` is the whole address space — the two rows answered above the host
  // guard. It is not mounted (see `mountRouteTable`), so its example only has
  // to be an address, and any address will do.
  if (pattern === '*') return '/asset.js';
  return pattern
    .split('/')
    .map((seg) => {
      if (seg === '*') return 'asset.js';
      if (!seg.startsWith(':')) return seg;
      const value = EXAMPLE_PARAMS[seg.slice(1)];
      if (value === undefined) throw new Error(`route ${pattern}: no example value for ${seg}`);
      return value;
    })
    .join('/');
}

/**
 * Register one route, naming its gate.
 *
 * The one construction site, so a row cannot arrive without a gate: the type
 * makes the field mandatory, and this makes `open` cost a sentence. That
 * asymmetry is the point — an ungated address is the row a reader must be
 * able to find, and "no gate" with no reason beside it is exactly the shape
 * that gets waved through.
 */
export function gated(gate: RouteGate, spec: Omit<RouteEntry, 'gate'>): RouteEntry {
  if (gate === 'open' && !spec.reason?.trim()) {
    throw new Error(`route ${spec.pattern}: an "open" route must say why reading it is free`);
  }
  if (gate === 'owner-in-handler' && !spec.reason?.trim()) {
    throw new Error(`route ${spec.pattern}: an "owner-in-handler" route must name the refusal`);
  }
  if (gate !== 'open' && spec.methods.length === 0) {
    throw new Error(`route ${spec.pattern}: no methods`);
  }
  return { ...spec, gate };
}

/**
 * Does this concrete path match this pattern?
 *
 * Bun owns the real matcher; this is the same shape spelled once more so the
 * drift test can prove every row's `example` belongs to its own `pattern`.
 * A trailing `*` matches one or more segments, `:name` matches exactly one.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const pat = pattern.split('/');
  const got = path.split('/');
  for (let i = 0; i < pat.length; i++) {
    const seg = pat[i];
    if (seg === '*') return got.length > i;
    const here = got[i];
    if (here === undefined) return false;
    if (seg?.startsWith(':')) continue;
    if (seg?.includes(':') || seg?.includes('*')) {
      // A mid-segment parameter, e.g. `docs:attach` — literal on both sides.
      if (seg !== here) return false;
      continue;
    }
    if (seg !== here) return false;
  }
  return pat.length === got.length;
}

/**
 * The object `Bun.serve` takes as `routes`.
 *
 * One handler for every pattern, and it is the caller's own front door — see
 * this file's header for why dispatch stays with the ordered chain. Rows that
 * share a pattern across methods collapse to one entry, because the handler
 * does not branch on method.
 */
export function mountRouteTable<T>(
  entries: readonly RouteEntry[],
  handler: (req: Request) => T,
): Record<string, (req: Request) => T> {
  const mounted: Record<string, (req: Request) => T> = {};
  for (const entry of entries) {
    if (entry.pattern === '*') continue; // the fallback's own job
    mounted[entry.pattern] = handler;
  }
  return mounted;
}

/** The line that opens the generated block in `packages/core/src/route-templates.ts`. */
export const ROUTE_TEMPLATES_BEGIN =
  '  // ── BEGIN generated by `bun run routes:table` from route-table-rows.ts ──';
/** The line that closes it. Everything outside the pair is hand-written. */
export const ROUTE_TEMPLATES_END = '  // ── END generated ──';

/**
 * The span-name template for one pattern: literal segments verbatim, every
 * `:name` parameter as `:id`. A mid-segment colon (`docs:attach`) is literal,
 * as it is in `patternMatches`.
 */
export function spanTemplateFor(pattern: string): readonly string[] {
  return pattern
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => (seg.startsWith(':') ? ':id' : seg));
}

/**
 * `packages/core/src/route-templates.ts` with its generated block rebuilt from
 * the rows.
 *
 * Core cannot import the server, so the rows reach the browser's span namer
 * as a generated copy rather than an import. One template per fixed-length
 * pattern, deduplicated and sorted. A `*` row has no segment count, so no
 * template can name it; the root `/` is named before any template is read.
 * Order does not change a match — `routePatternForSpan` takes the template
 * with the most literal segments — so sorting only keeps the diff of a new
 * row to one line.
 */
export function renderRouteTemplates(entries: readonly RouteEntry[], fileText: string): string {
  const begin = fileText.indexOf(`${ROUTE_TEMPLATES_BEGIN}\n`);
  const end = fileText.indexOf(`${ROUTE_TEMPLATES_END}\n`);
  if (begin < 0 || end < begin) {
    throw new Error('route-templates.ts: the generated block markers are missing');
  }
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.pattern.includes('*')) continue;
    const template = spanTemplateFor(entry.pattern);
    if (template.length > 0) paths.add(template.join('/'));
  }
  const lines = [...paths]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      (path) =>
        `  [${path
          .split('/')
          .map((seg) => `'${seg}'`)
          .join(', ')}],\n`,
    );
  const head = fileText.slice(0, begin + ROUTE_TEMPLATES_BEGIN.length + 1);
  return head + lines.join('') + fileText.slice(end);
}

/** The table as the markdown `docs/architecture/routes.md` holds. */
export function renderRouteTable(entries: readonly RouteEntry[]): string {
  const rows = [...entries].sort(
    (a, b) =>
      a.pattern.localeCompare(b.pattern) || a.methods.join().localeCompare(b.methods.join()),
  );
  const lines = [
    '<!-- Generated by `bun run routes:table`. Edit `packages/server/src/route-table-rows.ts`, not this file. -->',
    '',
    '# Front-door routes, and the gate each sits behind',
    '',
    'Every path pattern this server answers. The source is',
    '`packages/server/src/route-table-rows.ts`, which `Bun.serve` mounts as',
    'its `routes` object. The share-visible gates in this table are the share',
    'allowlist itself: `shareScopeAllows` admits a share visitor to exactly the rows',
    'filed `share-scope`, `owner-in-handler` or `collab-scope`, for their methods.',
    '`packages/server/test/route-table.test.ts` fails when this file and that one',
    'disagree, and when a row’s declared gate disagrees with what',
    '`shareScopeAllows` actually decides. That check cannot tell `trusted-local`',
    'from `loopback-only`, so `packages/server/test/route-table-loopback.test.ts`',
    'dials every row filed under either from a loopback and a non-loopback address',
    'and fails when the route refuses a different caller than its row says. It also',
    'calls every `loopback-only` row through the tunnel and fails unless the route',
    'refuses it. The gate vocabulary is [security.md](security.md).',
    '',
    '| Pattern | Methods | Module | Gate | Reason |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push(
      `| \`${r.pattern}\` | ${r.methods.join(', ')} | \`${r.module}\` | ${r.gate} | ${r.reason ?? ''} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
