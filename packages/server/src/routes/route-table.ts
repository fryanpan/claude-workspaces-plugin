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
 * label: `shareScopeAllows` in `middleware/host-guard.ts` is a pure function
 * of (path, method, share target), so the test drives it with the row's own
 * `example` path and fails when the guard disagrees with what the row says.
 * A route added under an already-allowed prefix therefore cannot be declared
 * `trusted-local` and merged — the guard says otherwise and CI reads the
 * guard, not the comment.
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
 * ADDING A ROUTE. Add its row here in the same commit. The rendered table is
 * `docs/architecture/routes.md`, regenerated with `bun run routes:table`, and
 * the drift test fails until the two agree.
 */

/**
 * What stands between a stranger and this address.
 *
 * The vocabulary is `docs/architecture/security.md`'s, not a new one:
 *
 * - `trusted-local` — reachable only from a trusted local host, or an
 *   Access-verified operator host. This is the default, and every route that
 *   `shareScopeAllows` does not name has it.
 * - `loopback-only` — additionally requires a loopback peer address and
 *   refuses anything carrying `cf-ray`. The deploy POST, the Sentry state,
 *   the agent merge, the agent token, watch set and event stream, the mount
 *   table and the repo registry. The plugin refresh is NOT one: its POST
 *   refuses `cf-ray` and a browser but checks no address. Unlike the share
 *   gates, `shareScopeAllows` cannot tell this gate from `trusted-local`, so
 *   `test/route-table-loopback.test.ts` checks it by dialling each row from
 *   a loopback and a non-loopback address.
 * - `share-scope` — named by `shareScopeAllows`, so a share visitor scoped to
 *   the board in the path reaches it.
 * - `owner-in-handler` — the host guard ADMITS a visitor to this address, and
 *   the route refuses one itself. Owner-only, enforced a layer lower than
 *   every other owner-only route, which is exactly why it needs a name: a
 *   route added under an allowed prefix either declares `share-scope` and
 *   says so, or declares this and carries the refusal. It cannot be quietly
 *   filed as `trusted-local`, because the guard would disagree and CI reads
 *   the guard. The `reason` must name where the refusal lives.
 * - `collab-scope` — reached through `collabScope`, which is
 *   `shareScopeAllows` plus a membership check on a collaboration host. Only
 *   the board's own Yjs socket, where the membership half is the operative
 *   condition.
 * - `recall-callback` — served only on the bot callback host, and carrying
 *   its own credential (an unguessable token in the path, or a Svix
 *   signature over the body).
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

/** The table as the markdown `docs/architecture/routes.md` holds. */
export function renderRouteTable(entries: readonly RouteEntry[]): string {
  const rows = [...entries].sort(
    (a, b) =>
      a.pattern.localeCompare(b.pattern) || a.methods.join().localeCompare(b.methods.join()),
  );
  const lines = [
    '<!-- Generated by `bun run routes:table`. Edit `packages/server/src/routes/route-table-rows.ts`, not this file. -->',
    '',
    '# Front-door routes, and the gate each sits behind',
    '',
    'Every path pattern this server answers. The source is',
    '`packages/server/src/routes/route-table-rows.ts`, which `Bun.serve` mounts as',
    'its `routes` object; `packages/server/test/route-table.test.ts` fails when this',
    'file and that one disagree, and when a row’s declared gate disagrees with what',
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
