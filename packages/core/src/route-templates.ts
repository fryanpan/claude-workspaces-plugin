/**
 * Route templates, and the one function that turns a pathname into a span
 * name — `routePatternForSpan`.
 *
 * It lives beside `trace-privacy.ts` rather than inside it because the table
 * is the bulk of both files put together, and because the table is now a
 * CHECKED claim: `packages/server/test/span-route-names.test.ts` walks
 * `ROUTE_TABLE` — the server's own written-down set of every path it answers
 * — and fails on any route this file cannot name.
 *
 * Why that gate exists. A route missing from the table costs no privacy (see
 * the table's own note), but it costs the name: every segment collapses to
 * `:id`, so unrelated routes arrive at Sentry under one description. 106 of
 * 271 rows were missing when this was split out, which is why a single
 * browser N+1 group covered three different pages — on the doc page it was
 * `…/docs/<id>/meeting-bot` and `…/docs/<id>/notes-method`, two different
 * calls reading as `GET /:id/:id/:id/:id/:id` twice.
 */

/**
 * Every REAL route this server dispatches on, as a whole-path template —
 * literal segments verbatim, `:id` marking a caller-controlled slot. Built
 * directly from server.ts's own route matchers (the workspace middleware's
 * `scope.rest` patterns, the `docs/:id` catch-all's own `rest` dispatch, and
 * its nested `threads`/`agent_anchors` sub-dispatches) — not retyped from
 * memory.
 *
 * This used to be a flat allowlist of literal WORDS, checked per segment
 * independently of where in the path it sat. That was wrong: whether a
 * segment is static depends on its POSITION in a matched route, not its
 * VALUE — a caller-chosen id can legally equal any English word, including
 * one that happens to be a route keyword somewhere else in the API (a doc
 * literally titled "content", landing at `…/docs/content/content`, kept
 * BOTH occurrences of "content" as static under the old check, leaking the
 * id). Matching whole templates instead means a segment is only ever static
 * when it sits at the position a REAL route puts a literal, never merely
 * because its value happens to collide with one.
 *
 * A path that matches no template here still degrades to every segment
 * becoming `:id` (see routePatternForSpan below) — safe by construction,
 * same as an unknown segment always was. Missing a real route from this
 * list costs span-name precision, never privacy: routePatternForSpan has no
 * path where "no template matched" produces anything other than all-`:id`.
 */
export const ROUTE_TEMPLATES: readonly (readonly string[])[] = [
  // top-level static (no dynamic segment at all)
  ['api', 'auth', 'logout'],
  ['api', 'auth', 'profile'],
  ['api', 'auth', 'session'],
  ['api', 'auth', 'start'],
  ['api', 'auth', 'verify'],
  ['api', 'auth', 'widget-session'],
  ['api', 'auth', 'widget-token'],
  ['workspaces', ':id', 'chat-audit'],
  ['api', 'deploy'],
  ['workspaces', ':id', 'attachments'],
  ['workspaces', ':id', 'dispatches'],
  ['workspaces', ':id', 'docs'],
  ['workspaces', ':id', 'docs:attach'],
  ['api', 'links', 'titles'],
  ['api', 'metrics'],
  ['api', 'plugin', 'refresh'],
  ['api', 'push', 'key'],
  ['api', 'push', 'subscriptions'],
  ['api', 'refs', 'backlinks'],
  ['api', 'share'],
  ['api', 'share', 'doc'],
  ['api', 'share', 'enabled'],
  ['api', 'share', 'link'],
  ['api', 'share', 'workspace'],
  ['api', 'summaries', 'backfill'],
  ['api', 'webhooks', 'log'],
  ['signin'],
  ['workspaces'],
  ['widget-auth'],
  ['widget.esm.js'],
  ['widget.iife.js'],
  ['widget.js'],
  // one id, top level
  ['workspaces', ':id', 'attachments', ':id'],
  ['workspaces', ':id', 'attachments', ':id', 'archive'],
  ['workspaces', ':id', 'attachments', ':id', 'unarchive'],
  // An attachment set's eight subroutes, under the board that holds it. A
  // set is not a board — it is a member of one — so it sits in the
  // `attachments` collection, not at the board's own address.
  ['workspaces', ':id', 'attachments', ':id', 'refresh'],
  ['workspaces', ':id', 'attachments', ':id', 'groups'],
  ['workspaces', ':id', 'attachments', ':id', 'grouped'],
  ['workspaces', ':id', 'attachments', ':id', 'threads'],
  ['workspaces', ':id', 'attachments', ':id', 'files'],
  ['workspaces', ':id', 'attachments', ':id', 'tree'],
  ['workspaces', ':id', 'attachments', ':id', 'context-file'],
  ['workspaces', ':id', 'attachments', ':id', 'editable-file'],
  ['share', ':id'],
  ['s', ':id'],
  ['api', 'share', ':id'],
  ['api', 'share', ':id', 'ttl'],
  ['workspaces', ':id', 'dispatches', ':id'],
  ['workspaces', ':id', 'chat-audit', ':id'],
  ['workspaces', ':id', 'docs', ':id', 'audio'],
  ['workspaces', ':id', 'y'],
  ['workspaces', ':id', 'docs', ':id', 'y'],
  ['workspaces', ':id', 'docs', ':id', 'events:stream'],
  // /workspaces/:id/tasks/:id/...
  ['workspaces', ':id', 'tasks', ':id', 'transition'],
  ['workspaces', ':id', 'tasks', ':id', 'evidence'],
  ['workspaces', ':id', 'tasks', ':id', 'links'],
  ['workspaces', ':id', 'tasks', ':id', 'goal'],
  ['workspaces', ':id', 'tasks', ':id', 'answer'],
  ['workspaces', ':id', 'tasks', ':id', 'answer', 'undo'],
  ['workspaces', ':id', 'tasks', ':id', 'more-info'],
  ['workspaces', ':id', 'tasks', ':id', 'review-items'],
  ['workspaces', ':id', 'tasks', ':id', 'review-items', ':id', 'answer'],
  ['workspaces', ':id', 'tasks', ':id', 'review-items', ':id', 'more-info'],
  ['workspaces', ':id', 'tasks', ':id', 'review-items', ':id', 'release'],
  ['workspaces', ':id', 'tasks', ':id', 'review-items', ':id', 'revise'],
  ['workspaces', ':id', 'tasks', ':id', 'review-items', ':id', 'secrets'],
  ['workspaces', ':id', 'tasks', ':id', 'after'],
  ['workspaces', ':id', 'tasks', ':id', 'title'],
  ['workspaces', ':id', 'tasks', ':id', 'body'],
  ['workspaces', ':id', 'tasks', ':id', 'assignee'],
  ['workspaces', ':id', 'tasks', ':id', 'due'],
  ['workspaces', ':id', 'tasks', ':id', 'park'],
  ['workspaces', ':id', 'tasks', ':id', 'archive'],
  ['workspaces', ':id', 'tasks', ':id', 'restore'],
  ['workspaces', ':id', 'tasks', ':id', 'notes'],
  // /api/agents/:id/...
  ['api', 'agents', ':id', 'watches'],
  ['api', 'agents', ':id', 'merge'],
  // /workspaces/:id/docs/:id and its ~30 subroutes (canonicalized once in
  // server.ts, then dispatched on the literal 'rest' of the path)
  ['workspaces', ':id', 'docs', ':id'],
  ['workspaces', ':id', 'docs', ':id', 'archive'],
  ['workspaces', ':id', 'docs', ':id', 'unarchive'],
  ['workspaces', ':id', 'docs', ':id', 'meetings'],
  ['workspaces', ':id', 'docs', ':id', 'meetings', ':id'],
  ['workspaces', ':id', 'docs', ':id', 'threads'],
  ['workspaces', ':id', 'docs', ':id', 'tasks'],
  ['workspaces', ':id', 'docs', ':id', 'content'],
  ['workspaces', ':id', 'docs', ':id', 'status'],
  ['workspaces', ':id', 'docs', ':id', 'reparse_from_disk'],
  ['workspaces', ':id', 'docs', ':id', 'diff'],
  ['workspaces', ':id', 'docs', ':id', 'activity'],
  ['workspaces', ':id', 'docs', ':id', 'find_and_replace'],
  ['workspaces', ':id', 'docs', ':id', 'agent_anchors'],
  ['workspaces', ':id', 'docs', ':id', 'suggestions'],
  ['workspaces', ':id', 'docs', ':id', 'suggestions', 'resolve_all'],
  ['workspaces', ':id', 'docs', ':id', 'suggestions', ':id', 'accept'],
  ['workspaces', ':id', 'docs', ':id', 'suggestions', ':id', 'reject'],
  ['workspaces', ':id', 'docs', ':id', 'delete_block_at_anchor'],
  ['workspaces', ':id', 'docs', ':id', 'delete_blocks_in_range'],
  ['workspaces', ':id', 'docs', ':id', 'delete_section'],
  ['workspaces', ':id', 'docs', ':id', 'hooks', 'fire'],
  // …/docs/:id/threads/:id/... (nested inside the rest dispatch above)
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'promote'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'comments'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'answer'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'revise'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'withdraw'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'withdraw', 'undo'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'answer', 'undo'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'summary'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'resolve'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'reopen'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'reanchor'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'rewrite_region'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'insert_after'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'insert_blocks_after'],
  ['workspaces', ':id', 'docs', ':id', 'threads', 'by_find'],
  ['workspaces', ':id', 'docs', ':id', 'outline'],
  ['workspaces', ':id', 'docs', ':id', 'block_edits'],
  // …/docs/:id/agent_anchors/:id/... (nested inside the rest dispatch above)
  ['workspaces', ':id', 'docs', ':id', 'agent_anchors', ':id'],
  ['workspaces', ':id', 'docs', ':id', 'agent_anchors', ':id', 'edit'],
  ['workspaces', ':id', 'docs', ':id', 'agent_anchors', ':id', 'insert_blocks'],
  // A board and everything it owns, at ONE prefix.
  //
  // A tab in a browser and the JSON behind it are one address distinguished
  // by `?format=json`, and a query string is not part of a route pattern, so
  // `''`, `home` and `tasks` each appear ONCE here and cover both. Two
  // entries would not have been wrong; they would have been a second place
  // to forget.
  ['workspaces', ':id'],
  ['workspaces', ':id', 'home'],
  ['workspaces', ':id', 'home', 'read'],
  ['workspaces', ':id', 'home', 'instructions'],
  ['workspaces', ':id', 'tasks'],
  ['workspaces', ':id', 'tasks', 'batch'],
  ['workspaces', ':id', 'activity'],
  ['workspaces', ':id', 'mockups', ':id'],
  ['workspaces', ':id', 'review-items'],
  ['workspaces', ':id', 'next'],
  ['workspaces', ':id', 'related-work'],
  ['workspaces', ':id', 'load-reports'],
  ['workspaces', ':id', 'events'],
  ['workspaces', ':id', 'goal'],
  ['workspaces', ':id', 'goals'],
  ['workspaces', ':id', 'goals', 'rename'],
  ['workspaces', ':id', 'goals', 'add'],
  ['workspaces', ':id', 'goals', 'reorder'],
  // A goal BAND's own verbs. They were `/api/goals/:id/<verb>` — a row that
  // named no board — and the board in front of the id is what lets one guard
  // check that the band is on the board the caller named.
  ['workspaces', ':id', 'goals', ':id', 'cascade'],
  ['workspaces', ':id', 'goals', ':id', 'archive'],
  ['workspaces', ':id', 'goals', ':id', 'restore'],
  ['workspaces', ':id', 'retired'],
  ['workspaces', ':id', 'settings'],
  ['workspaces', ':id', 'parallelism-cap'],
  ['workspaces', ':id', 'rename'],
  ['workspaces', ':id', 'lead'],
  ['workspaces', ':id', 'voice'],
  ['workspaces', ':id', 'import-tasks'],
  ['workspaces', ':id', 'huddles'],
  ['workspaces', ':id', 'comment-queue', ':id', 'ack'],
  ['workspaces', ':id', 'voice-queue', ':id', 'ack'],
  // Board collections addressed the canonical way — the live event stream
  // and the agent roster, both moved off names the glossary spends elsewhere.
  ['workspaces', ':id', 'events:stream'],
  ['workspaces', ':id', 'agents'],
  ['workspaces', ':id', 'agents', ':id'],
  ['workspaces', ':id', 'agents', ':id', 'heartbeat'],
  ['workspaces', ':id', 'agents', ':id', 'notes'],
  ['workspaces', ':id', 'agent-notes'],

  // ── The rest of ROUTE_TABLE ──────────────────────────────────────────
  //
  // The rows above were written by hand from server.ts's matchers and stopped
  // where that reading stopped. These are the remaining 88, derived from the
  // route table's own patterns — every fixed-length row whose span name was
  // still all-`:id`. The gate that found them
  // (`packages/server/test/span-route-names.test.ts`) is what keeps the list
  // whole from here: a new route lands red until it is named.
  //
  // A `*` row is not here and cannot be: a template matches on exact segment
  // COUNT, and a wildcard family has no count. The four static-asset roots
  // are collapsed by `STATIC_ASSET_ROUTE_ROOTS` below instead, and the
  // stale-client `/api/<family>/*` rows keep the all-`:id` name — nothing but
  // a client too old to have been restarted reaches them.
  ['api', 'agent-notes'],
  ['api', 'agents', ':id', 'token'],
  ['api', 'attachments'],
  ['api', 'calendar', 'events'],
  ['api', 'calendar', 'google', 'callback'],
  ['api', 'calendar', 'google', 'connect'],
  ['api', 'calendar', 'google'],
  ['api', 'calendar'],
  ['api', 'chat-audit'],
  ['api', 'diffs'],
  ['api', 'dispatches'],
  ['api', 'docs'],
  ['api', 'goals'],
  ['api', 'meeting-engines'],
  ['api', 'mounts', 'conventions'],
  ['api', 'mounts', 'files'],
  ['api', 'mounts', 'meetings'],
  ['api', 'mounts', 'privacy'],
  ['api', 'mounts'],
  ['api', 'next'],
  ['api', 'prompts', ':id'],
  ['api', 'prompts'],
  ['api', 'refs'],
  ['api', 'repos', 'checkouts'],
  ['api', 'repos', 'live-copy'],
  ['api', 'repos'],
  ['api', 'review-items'],
  ['api', 'review-queue'],
  ['api', 'review-size'],
  ['api', 'review-wait'],
  ['api', 'reviews'],
  ['api', 'sentry'],
  ['api', 'share', 'member', 'remove'],
  ['api', 'tasks'],
  ['api', 'threads'],
  ['api', 'workspaces'],
  ['apple-touch-icon.png'],
  ['events', 'agent', ':id'],
  ['favicon.ico'],
  ['icon-192.png'],
  ['icon-512.png'],
  ['icon.svg'],
  ['manifest.webmanifest'],
  ['mcp'],
  ['mounts', ':id', 'raw'],
  ['mounts', ':id'],
  ['recall', ':id'],
  ['recall', 'status'],
  ['review'],
  ['settings', 'prompts', ':id'],
  ['settings', 'prompts'],
  ['settings'],
  ['sw.js'],
  ['sw.js.map'],
  ['workspaces', ':id', 'calendar', 'events', ':id', 'join'],
  ['workspaces', ':id', 'docs', ':id', 'home'],
  ['workspaces', ':id', 'docs', ':id', 'lead-presence'],
  ['workspaces', ':id', 'docs', ':id', 'meeting-bot'],
  ['workspaces', ':id', 'docs', ':id', 'meetings', ':id', 'notes-cleanup'],
  ['workspaces', ':id', 'docs', ':id', 'meetings', ':id', 'speakers'],
  ['workspaces', ':id', 'docs', ':id', 'move'],
  ['workspaces', ':id', 'docs', ':id', 'notes-method'],
  ['workspaces', ':id', 'docs', ':id', 'plan'],
  ['workspaces', ':id', 'docs', ':id', 'plan-request'],
  ['workspaces', ':id', 'docs', ':id', 'research-request'],
  ['workspaces', ':id', 'docs', ':id', 'review-request'],
  ['workspaces', ':id', 'docs', ':id', 'threads', ':id', 'edit-comment'],
  ['workspaces', ':id', 'docs', ':id', 'title'],
  ['workspaces', ':id', 'docs', ':id', 'voice'],
  ['workspaces', ':id', 'docs', ':id', 'voice-feedback', ':id'],
  ['workspaces', ':id', 'docs', ':id', 'voice-feedback.md'],
  ['workspaces', ':id', 'keep-moving'],
  ['workspaces', ':id', 'library', 'items'],
  ['workspaces', ':id', 'library', 'open'],
  ['workspaces', ':id', 'library'],
  ['workspaces', ':id', 'links:titles'],
  ['workspaces', ':id', 'manifest.webmanifest'],
  ['workspaces', ':id', 'members', ':id', 'role'],
  ['workspaces', ':id', 'members', ':id'],
  ['workspaces', ':id', 'members'],
  ['workspaces', ':id', 'refs:backfill'],
  ['workspaces', ':id', 'refs:backlinks'],
  ['workspaces', ':id', 'review-items', ':id'],
  ['workspaces', ':id', 'tasks', ':id', 'detail'],
  ['workspaces', ':id', 'tasks', ':id', 'review-items', ':id', 'withdraw', 'undo'],
  ['workspaces', ':id', 'tasks', ':id', 'review-items', ':id', 'withdraw'],
  ['workspaces', ':id', 'tasks', ':id', 'schedule'],
  ['workspaces', ':id', 'tasks', ':id'],
];

function matchesRouteTemplate(segments: readonly string[], template: readonly string[]): boolean {
  if (segments.length !== template.length) return false;
  return segments.every((seg, i) => template[i] === ':id' || template[i] === seg);
}

/**
 * The matching template with the most literal segments — not the first one in
 * the list.
 *
 * Two templates can both match: `/workspaces/<ws>/tasks/batch` matches
 * `['workspaces', ':id', 'tasks', 'batch']` and, since the table gained
 * `['workspaces', ':id', 'tasks', ':id']`, the id-shaped one as well. Taking
 * the first made the answer depend on where in a 250-line list somebody had
 * pasted an entry, which is not a property a table can be maintained against;
 * `/recall/status` vs `/recall/:id` is the same pair, and the existing
 * `…/threads/by_find` had already lost it to `…/threads/:id`.
 *
 * It never widens what stays literal: a segment can only survive here if some
 * REAL route puts a literal at that position, which is exactly the rule the
 * whole-template match exists to enforce. Preferring more literals only picks
 * the more specific of two routes that both claim the address.
 */
function mostLiteralMatch(segments: readonly string[]): readonly string[] | undefined {
  let best: readonly string[] | undefined;
  let bestLiterals = -1;
  for (const t of ROUTE_TEMPLATES) {
    if (!matchesRouteTemplate(segments, t)) continue;
    const literals = t.filter((seg) => seg !== ':id').length;
    if (literals > bestLiterals) {
      best = t;
      bestLiterals = literals;
    }
  }
  return best;
}

/**
 * Static-asset roots server.ts serves with a `pathname.startsWith('/<root>/')`
 * prefix match (widgetDist, workspaces-app's dist, the demos dir, the
 * project-card assets) — arbitrary depth beneath the root (an asset can sit
 * in a subdirectory), so no fixed-length ROUTE_TEMPLATES entry can name it:
 * a template matches on exact segment COUNT, and these routes have none.
 * codex review (this branch): the whole-template rewrite above silently
 * dropped these from `/app/:id` etc. to the generic `/:id/:id` fallback,
 * an observability regression with no privacy fix behind it — the OLD flat
 * per-segment allowlist happened to keep segment 0 static for exactly these
 * four words. Collapsing everything past the root to one `:id` restores
 * that, and stays position-keyed rather than value-keyed for the same
 * reason ROUTE_TEMPLATES is: nothing in ROUTE_TEMPLATES ever puts a
 * caller-chosen id at segment 0 under these literal strings, so a request
 * only lands here by actually hitting one of these four static routes.
 */
const STATIC_ASSET_ROUTE_ROOTS = new Set(['widget', 'app', 'demos', 'projects']);

/**
 * Route pattern for a span/transaction name — NEVER `url.pathname` directly.
 * A raw path can carry a doc id that's a bound file's relative path, a task
 * title alias (`task:<taskId>`), or a share token; this collapses every
 * segment that isn't at a literal position in a known route to `:id`, so the
 * name is safe to send off-machine no matter what the id turns out to
 * contain — see ROUTE_TEMPLATES above for why this matches whole shapes
 * rather than classifying segments independently.
 */
export function routePatternForSpan(pathname: string): string {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return '/';
  const template = mostLiteralMatch(segments);
  if (template) return `/${template.join('/')}`;
  if (segments.length >= 2 && STATIC_ASSET_ROUTE_ROOTS.has(segments[0]!)) {
    return `/${segments[0]}/:id`;
  }
  return `/${segments.map(() => ':id').join('/')}`;
}
