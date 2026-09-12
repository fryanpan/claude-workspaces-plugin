/**
 * ── The rows of the route table ──
 *
 * The data half of `route-table.ts`, kept apart from the types and the
 * renderer for one reason: this file grows every time the server gains an
 * address, and the machinery around it does not. Read `route-table.ts` first
 * — it says what a row claims, why the gate is a checked claim rather than a
 * comment, and why mounting the table changes no dispatch.
 *
 * ORDER HERE IS NOT DISPATCH ORDER. Rows are grouped by the module that
 * answers them so a reader can follow one family; the chain in `server.ts`
 * decides which family sees a request, and `route-table.ts` lists the eight
 * adjacencies where that order is behaviour.
 *
 * ADDING A ROUTE: add its row to its family below, then `bun run routes:table`.
 */

import { type RouteEntry, type RouteGate, exampleFor, gated } from './route-table.ts';

/**
 * One row: the gate, the pattern, the methods it answers, and — only for an
 * `open` gate — why reading it is free.
 *
 * A tuple rather than an object because there are nearly two hundred of them
 * and a reader is scanning columns, not fields. The module is bound once per
 * family below, and the example path is derived from the pattern rather than
 * written out, so a row cannot name an address the server does not have.
 */
type Row = readonly [gate: RouteGate, pattern: string, methods: string, reason?: string];

function family(module: string, rows: readonly Row[]): RouteEntry[] {
  return rows.map(([gate, pattern, methods, reason]) =>
    gated(gate, {
      pattern,
      methods: methods.split(' '),
      module,
      example: exampleFor(pattern),
      ...(reason ? { reason } : {}),
    }),
  );
}

const ANY_METHOD = 'GET POST PUT DELETE';

/**
 * The `/api/<family>` words a pre-cutover client still calls, answered 410 by
 * `routes/stale-client.ts` — the same set that module holds, spelled here
 * because the table is about addresses and that one is about a verdict.
 */
const PRE_CUTOVER_FAMILIES = [
  'workspaces',
  'docs',
  'tasks',
  'goals',
  'refs',
  'reviews',
  'review-items',
  'dispatches',
  'diffs',
  'agent-notes',
  'chat-audit',
] as const;

/**
 * The wrong-prefix families the stale-client answer does NOT already claim.
 * These reach `routes/wrong-prefix.ts` and are told the address without the
 * prefix; the four it shares with the set above never get that far.
 */
const WRONG_PREFIX_ONLY_FAMILIES = ['threads', 'attachments', 'next'] as const;

/** Every front-door path pattern this server answers. */
export const ROUTE_TABLE: readonly RouteEntry[] = [
  // Answered ABOVE the host guard, so both rows have to say why that is safe.
  ...family('server.ts', [
    [
      'open',
      '*',
      'OPTIONS',
      'CORS preflight, answered with a bare 204 before the guard runs. It carries no body, and no `Access-Control-Allow-*` unless the origin is allowed, so it discloses only that a server is here.',
    ],
    [
      'open',
      '*',
      'GET HEAD POST PUT DELETE',
      'A path segment that is not valid percent-encoding is answered 400 `bad-path` at the top of the front door, above every gate. The answer depends only on the caller’s own typo — see `path-params.ts`.',
    ],
  ]),

  // The bot callback host: two addresses and nothing else, each carrying its
  // own credential.
  ...family('routes/upgrade-stream.ts', [
    ['recall-callback', '/recall/:token', 'GET'],
    ['trusted-local', '/events/agent/:agentId', 'GET'],
    ['share-scope', '/workspaces/:ws/events:stream', 'GET'],
    ['share-scope', '/workspaces/:ws/docs/:docId/events:stream', 'GET'],
    ['share-scope', '/workspaces/:ws/docs/:docId/audio', 'GET'],
    ['share-scope', '/workspaces/:ws/docs/:docId/y', 'GET'],
    ['collab-scope', '/workspaces/:ws/y', 'GET'],
  ]),
  ...family('routes/recall-webhook.ts', [['recall-callback', '/recall/status', 'POST']]),

  ...family('routes/auth-share.ts', [
    ['trusted-local', '/widget-auth', 'GET'],
    ['trusted-local', '/api/auth/widget-token', 'POST'],
    ['trusted-local', '/api/auth/widget-session', 'GET'],
    ['trusted-local', '/api/auth/start', 'POST'],
    ['trusted-local', '/api/auth/verify', 'POST'],
    ['share-scope', '/api/auth/session', 'GET'],
    ['trusted-local', '/api/auth/logout', 'POST'],
    ['trusted-local', '/api/auth/profile', 'POST'],
    ['trusted-local', '/api/share', 'GET'],
    ['trusted-local', '/api/share/enabled', 'POST'],
    ['trusted-local', '/api/share/doc', 'POST'],
    ['trusted-local', '/api/share/link', 'POST'],
    ['trusted-local', '/api/share/workspace', 'POST'],
    ['trusted-local', '/api/share/member/remove', 'POST'],
    ['trusted-local', '/api/share/:shareId/ttl', 'POST'],
    ['trusted-local', '/api/share/:shareId', 'DELETE'],
    ['trusted-local', '/share/:slug', 'GET'],
    ['trusted-local', '/s/:slug', 'GET'],
  ]),

  ...family('routes/ops.ts', [
    ['trusted-local', '/api/metrics', 'GET'],
    ['trusted-local', '/api/summaries/backfill', 'POST'],
    ['trusted-local', '/api/webhooks/log', 'GET POST'],
    ['trusted-local', '/api/plugin/refresh', 'GET'],
    ['loopback-only', '/api/push/key', 'GET'],
    ['trusted-local', '/api/push/subscriptions', 'POST DELETE'],
    ['trusted-local', '/api/deploy', 'GET POST'],
    ['loopback-only', '/api/sentry', 'GET POST'],
  ]),

  ...family('routes/prompts.ts', [
    ['trusted-local', '/api/prompts', 'GET'],
    ['trusted-local', '/api/prompts/:id', 'GET PUT'],
  ]),

  ...family('routes/agent-identity.ts', [
    ['trusted-local', '/api/agents/:agentId/token', 'GET'],
    ['trusted-local', '/api/agents/:agentId/watches', 'GET POST'],
    ['loopback-only', '/api/agents/:agentId/merge', 'POST'],
  ]),

  ...family('routes/workspaces-create-read.ts', [
    ['trusted-local', '/workspaces', 'GET POST'],
    ['share-scope', '/workspaces/:ws', 'GET'],
    ['trusted-local', '/workspaces/:ws/attachments', 'GET POST'],
  ]),
  ...family('routes/workspace-delete.ts', [['trusted-local', '/workspaces/:ws', 'DELETE']]),

  ...family('routes/workspace-home.ts', [
    ['share-scope', '/workspaces/:ws/review-items', 'GET'],
    ['trusted-local', '/workspaces/:ws/review-items/:itemId', 'GET'],
    ['share-scope', '/workspaces/:ws/home', 'GET'],
    ['share-scope', '/workspaces/:ws/home/read', 'POST'],
    ['share-scope', '/workspaces/:ws/home/instructions', 'PUT'],
  ]),
  ...family('routes/workspace-manifest.ts', [
    ['share-scope', '/workspaces/:ws/manifest.webmanifest', 'GET'],
  ]),
  ...family('routes/workspace-keep-moving.ts', [
    ['trusted-local', '/workspaces/:ws/keep-moving', 'GET'],
  ]),
  ...family('routes/workspace-next.ts', [
    ['trusted-local', '/workspaces/:ws/next', 'GET'],
    ['share-scope', '/workspaces/:ws/load-reports', 'GET POST'],
    ['share-scope', '/workspaces/:ws/events', 'GET'],
  ]),
  ...family('routes/workspace-related.ts', [
    ['trusted-local', '/workspaces/:ws/related-work', 'GET'],
  ]),
  // The Library's data names files in a repo on this machine, so it is not on
  // `shareScopeAllows` even though the page it feeds is a board tab; both
  // handlers refuse a share visitor as well.
  ...family('routes/workspace-library.ts', [
    ['trusted-local', '/workspaces/:ws/library/items', 'GET'],
    ['trusted-local', '/workspaces/:ws/library/open', 'POST'],
  ]),

  ...family('routes/workspace-settings.ts', [
    ['trusted-local', '/workspaces/:ws/goal', 'PUT'],
    ['trusted-local', '/workspaces/:ws/retired', 'PUT'],
    ['trusted-local', '/workspaces/:ws/parallelism-cap', 'GET PUT'],
    [
      'owner-in-handler',
      '/workspaces/:ws/settings',
      'GET PUT',
      'the guard admits both verbs; the GET is a member’s and `workspace-settings.ts` ' +
        'refuses a Regular User’s PUT itself — every field it writes is board-wide',
    ],
    ['trusted-local', '/workspaces/:ws/rename', 'POST'],
    ['trusted-local', '/workspaces/:ws/lead', 'PUT'],
    ['trusted-local', '/workspaces/:ws/voice', 'POST'],
  ]),

  // Who has access, and at what level. The LIST is a member's — everything in
  // a workspace is available to everyone in it — and the two writes are the
  // board owner's. The guard admits the paths so that a PROMOTED owner
  // reaching the board through the share hostname can manage it at all; the
  // role is what refuses, one layer lower.
  ...family('routes/workspace-members.ts', [
    ['share-scope', '/workspaces/:ws/members', 'GET'],
    [
      'owner-in-handler',
      '/workspaces/:ws/members/:email/role',
      'POST',
      'the guard admits `members/*`; `workspace-members.ts` refuses a Regular User itself',
    ],
    [
      'owner-in-handler',
      '/workspaces/:ws/members/:email',
      'DELETE',
      'the guard admits `members/*`; `workspace-members.ts` refuses a Regular User itself',
    ],
  ]),

  ...family('routes/workspace-content.ts', [
    ['share-scope', '/workspaces/:ws/docs:attach', 'POST'],
    ['trusted-local', '/workspaces/:ws/import-tasks', 'POST'],
    ['share-scope', '/workspaces/:ws/huddles', 'POST'],
  ]),

  ...family('routes/tasks-list-create.ts', [['share-scope', '/workspaces/:ws/tasks', 'GET POST']]),
  ...family('routes/tasks-batch.ts', [['trusted-local', '/workspaces/:ws/tasks/batch', 'POST']]),

  // The bare task address, which is a browser's rather than an API's: it
  // redirects to `/workspaces/:ws?task=:taskId`. `trusted-local` because
  // `shareScopeAllows` deliberately leaves bare `tasks/<id>` out of its
  // table — a visitor reads a row over the board doc, not over this path —
  // so the redirect reaches nobody the board page did not already reach.
  //
  // The wildcard row is the SAME module's second answer, and it is a row
  // rather than an omission because an address that is answered is an address
  // the inventory has to name: a GET under a task that no task route claims
  // gets the readable not-found page from here. It does not widen the ones
  // above it — a pattern nothing else matches is what reaches this module,
  // and the specific rows keep their own gates.
  ...family('routes/task-page.ts', [
    ['trusted-local', '/workspaces/:ws/tasks/:taskId', 'GET'],
    ['trusted-local', '/workspaces/:ws/tasks/:taskId/*', 'GET'],
  ]),

  ...family('routes/task-detail.ts', [
    ['share-scope', '/workspaces/:ws/tasks/:taskId/detail', 'GET'],
  ]),

  ...family('routes/task-status-links.ts', [
    ['share-scope', '/workspaces/:ws/tasks/:taskId/transition', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/evidence', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/links', 'GET POST DELETE'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/goal', 'POST'],
    ['trusted-local', '/workspaces/:ws/refs:backlinks', 'POST'],
    ['trusted-local', '/workspaces/:ws/refs:backfill', 'POST'],
    ['trusted-local', '/workspaces/:ws/links:titles', 'POST'],
  ]),
  ...family('routes/task-answers.ts', [
    ['share-scope', '/workspaces/:ws/tasks/:taskId/answer', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/answer/undo', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/more-info', 'POST'],
  ]),
  ...family('routes/task-review-items.ts', [
    ['share-scope', '/workspaces/:ws/tasks/:taskId/review-items', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/review-items/:itemId/answer', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/review-items/:itemId/more-info', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/review-items/:itemId/release', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/review-items/:itemId/revise', 'POST'],
    // NOT `share-scope`, and that is the point: every sibling verb above is
    // named in the host guard's member allowlist and this one is not, so no
    // share visitor of any role reaches the address at all. The value lands
    // in the OWNER'S OWN machine's store, so the owner's own admission path
    // is the only one that may write it. The route carries
    // `refuseOwnerOnlyWrite` besides, which is what fails closed if the
    // allowlist ever gains the prefix.
    ['trusted-local', '/workspaces/:ws/tasks/:taskId/review-items/:itemId/secrets', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/review-items/:itemId/withdraw', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/review-items/:itemId/withdraw/undo', 'POST'],
  ]),
  ...family('routes/task-fields.ts', [
    ['share-scope', '/workspaces/:ws/tasks/:taskId/after', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/title', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/body', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/assignee', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/due', 'POST'],
    ['trusted-local', '/workspaces/:ws/tasks/:taskId/schedule', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/park', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/archive', 'POST'],
    ['share-scope', '/workspaces/:ws/tasks/:taskId/restore', 'POST'],
  ]),

  ...family('routes/workspace-goals.ts', [
    ['trusted-local', '/workspaces/:ws/goals', 'PUT'],
    ['share-scope', '/workspaces/:ws/goals/add', 'POST'],
    ['share-scope', '/workspaces/:ws/goals/rename', 'POST'],
    ['share-scope', '/workspaces/:ws/goals/reorder', 'POST'],
    ['share-scope', '/workspaces/:ws/goals/:goalId/cascade', 'GET'],
    ['share-scope', '/workspaces/:ws/goals/:goalId/archive', 'POST'],
    ['share-scope', '/workspaces/:ws/goals/:goalId/restore', 'POST'],
  ]),

  ...family('routes/dispatch-and-notes.ts', [
    ['trusted-local', '/workspaces/:ws/dispatches', 'GET POST'],
    ['trusted-local', '/workspaces/:ws/dispatches/:taskId', 'DELETE'],
    ['trusted-local', '/workspaces/:ws/tasks/:taskId/notes', 'GET POST'],
    ['trusted-local', '/workspaces/:ws/agents/:agent/notes', 'GET POST'],
  ]),
  ...family('routes/chat-audit-routes.ts', [
    ['trusted-local', '/workspaces/:ws/chat-audit', 'GET POST'],
    ['trusted-local', '/workspaces/:ws/chat-audit/:agent', 'GET'],
  ]),

  ...family('routes/workspace-attachments.ts', [
    ['share-scope', '/workspaces/:ws/agents', 'GET'],
    ['trusted-local', '/workspaces/:ws/agents', 'POST'],
    ['trusted-local', '/workspaces/:ws/agents/:agentId', 'DELETE'],
    ['trusted-local', '/workspaces/:ws/agents/:agentId/heartbeat', 'POST'],
    ['trusted-local', '/workspaces/:ws/comment-queue/:id/ack', 'POST'],
    ['trusted-local', '/workspaces/:ws/voice-queue/:id/ack', 'POST'],
  ]),

  ...family('routes/archive.ts', [
    ['trusted-local', '/workspaces/:ws/attachments/:setId/archive', 'POST'],
    ['trusted-local', '/workspaces/:ws/attachments/:setId/unarchive', 'POST'],
    ['trusted-local', '/workspaces/:ws/attachments/:setId', 'DELETE'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/archive', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/unarchive', 'POST'],
  ]),

  ...family('routes/review-files.ts', [
    ['share-scope', '/workspaces/:ws/attachments/:setId/threads', 'GET'],
    ['share-scope', '/workspaces/:ws/attachments/:setId/grouped', 'GET'],
    ['trusted-local', '/workspaces/:ws/attachments/:setId/refresh', 'POST'],
    ['trusted-local', '/workspaces/:ws/attachments/:setId/groups', 'POST'],
    ['share-scope', '/workspaces/:ws/attachments/:setId/files', 'GET'],
    ['share-scope', '/workspaces/:ws/attachments/:setId/context-file', 'POST'],
    ['share-scope', '/workspaces/:ws/attachments/:setId/editable-file', 'POST'],
    ['share-scope', '/workspaces/:ws/attachments/:setId/tree', 'GET'],
  ]),

  ...family('routes/meetings-calendar.ts', [
    ['share-scope', '/workspaces/:ws/docs/:docId/meetings', 'GET'],
    ['share-scope', '/workspaces/:ws/docs/:docId/meetings/:meetingId', 'GET'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/meetings/:meetingId/speakers', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/meetings/:meetingId/notes-cleanup', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/notes-method', 'GET PUT'],
    ['share-scope', '/workspaces/:ws/docs/:docId/meeting-bot', 'GET'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/meeting-bot', 'POST DELETE'],
    ['share-scope', '/api/meeting-engines', 'GET'],
    ['trusted-local', '/api/calendar', 'GET'],
    ['trusted-local', '/api/calendar/events', 'GET'],
    ['trusted-local', '/api/calendar/google', 'DELETE'],
    ['trusted-local', '/api/calendar/google/connect', 'GET'],
    ['trusted-local', '/api/calendar/google/callback', 'GET'],
    ['trusted-local', '/workspaces/:ws/calendar/events/:eventId/join', 'POST'],
  ]),

  ...family('routes/docs.ts', [
    ['trusted-local', '/workspaces/:ws/docs', 'GET POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/promote', 'POST'],
  ]),

  ...family('routes/doc-resource.ts', [
    ['share-scope', '/workspaces/:ws/docs/:docId', 'GET'],
    ['trusted-local', '/workspaces/:ws/docs/:docId', 'DELETE'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads', 'GET'],
    ['share-scope', '/workspaces/:ws/docs/:docId/tasks', 'GET'],
    ['share-scope', '/workspaces/:ws/docs/:docId/lead-presence', 'GET'],
    ['share-scope', '/workspaces/:ws/docs/:docId/status', 'GET'],
    ['share-scope', '/workspaces/:ws/docs/:docId/diff', 'GET'],
    ['share-scope', '/workspaces/:ws/docs/:docId/activity', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/title', 'PUT'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/plan', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/plan-request', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/review-request', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/research-request', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/home', 'GET PUT DELETE'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/hooks/fire', 'POST'],
  ]),

  ...family('routes/doc-threads-routes.ts', [
    ['share-scope', '/workspaces/:ws/docs/:docId/threads', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/by_find', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId', 'GET'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/comments', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/answer', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/answer/undo', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/edit-comment', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/revise', 'POST'],
    [
      'owner-in-handler',
      '/workspaces/:ws/docs/:docId/threads/:threadId/withdraw',
      'POST',
      'the guard admits `threads/*`; `doc-threads-routes.ts` refuses a visitor itself',
    ],
    [
      'owner-in-handler',
      '/workspaces/:ws/docs/:docId/threads/:threadId/withdraw/undo',
      'POST',
      'the guard admits `threads/*`; `doc-threads-routes.ts` refuses a visitor itself',
    ],
    [
      'owner-in-handler',
      '/workspaces/:ws/docs/:docId/threads/:threadId/summary',
      'POST',
      'the guard admits `threads/*`; `doc-threads-routes.ts` refuses a visitor itself',
    ],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/resolve', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/reopen', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/reanchor', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/rewrite_region', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/insert_after', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/threads/:threadId/insert_blocks_after', 'POST'],
  ]),

  ...family('routes/doc-edit-routes.ts', [
    ['trusted-local', '/workspaces/:ws/docs/:docId/content', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/content', 'GET'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/reparse_from_disk', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/agent_anchors', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/agent_anchors/:anchorId', 'DELETE'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/agent_anchors/:anchorId/edit', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/agent_anchors/:anchorId/insert_blocks', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/find_and_replace', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/delete_block_at_anchor', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/delete_blocks_in_range', 'POST'],
    ['trusted-local', '/workspaces/:ws/docs/:docId/delete_section', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/suggestions', 'GET'],
    ['share-scope', '/workspaces/:ws/docs/:docId/suggestions/resolve_all', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/suggestions/:sid/accept', 'POST'],
    ['share-scope', '/workspaces/:ws/docs/:docId/suggestions/:sid/reject', 'POST'],
  ]),

  // Every value the repo registry reads and writes is a HOST PATH — a
  // checkout root, a repo's main directory, the absolute path of a copy — so
  // the family sits behind `offBox`, the gate `POST /api/deploy` uses:
  // loopback socket address, no `cf-ray`, no share or collab visitor, and no
  // browser on this machine either.
  ...family('routes/repos.ts', [
    ['loopback-only', '/api/repos', 'GET'],
    ['loopback-only', '/api/repos/checkouts', 'POST DELETE'],
    ['loopback-only', '/api/repos/live-copy', 'GET'],
  ]),

  // The lead's mount table sits behind `offBox`, which is the gate
  // `POST /api/deploy` uses: loopback socket address, no `cf-ray`, no share
  // or collab visitor, no browser. Host paths go in and come out of it.
  ...family('routes/mounts.ts', [
    ['loopback-only', '/api/mounts', 'GET POST DELETE'],
    ['loopback-only', '/api/mounts/files', 'GET'],
    ['loopback-only', '/api/mounts/privacy', 'PUT'],
    ['loopback-only', '/api/mounts/conventions', 'GET PUT'],
    ['loopback-only', '/api/mounts/meetings', 'GET PUT'],
    // The bytes themselves are member-facing rather than lead-only, so they
    // are not behind `offBox` — but `shareScopeAllows` does not name
    // `/mounts/…`, so a share visitor never reaches them, and the handler
    // refuses one anyway. A project marked `local-only` narrows these two
    // further, to the box, at serve time.
    ['trusted-local', '/mounts/:fileId', 'GET HEAD'],
    ['trusted-local', '/mounts/:fileId/raw', 'GET HEAD'],
  ]),

  ...family('routes/shell-static.ts', [
    ['share-scope', '/app/*', 'GET'],
    ['share-scope', '/widget/*', 'GET'],
    ['share-scope', '/widget.js', 'GET'],
    ['share-scope', '/widget.esm.js', 'GET'],
    ['share-scope', '/widget.iife.js', 'GET'],
    ['share-scope', '/favicon.ico', 'GET'],
    ['share-scope', '/manifest.webmanifest', 'GET'],
    ['share-scope', '/apple-touch-icon.png', 'GET'],
    ['share-scope', '/icon.svg', 'GET'],
    ['share-scope', '/icon-192.png', 'GET'],
    ['share-scope', '/icon-512.png', 'GET'],
    ['trusted-local', '/sw.js', 'GET'],
    ['trusted-local', '/sw.js.map', 'GET'],
    ['share-scope', '/workspaces/:ws/activity', 'GET'],
    ['share-scope', '/workspaces/:ws/library', 'GET'],
    ['share-scope', '/workspaces/:ws/mockups/:docId', 'GET'],
    ['share-scope', '/workspaces/:ws/attachments/:setId', 'GET'],
    ['trusted-local', '/demos/*', 'GET'],
    ['trusted-local', '/settings', 'GET'],
    ['trusted-local', '/settings/prompts', 'GET'],
    ['trusted-local', '/settings/prompts/:id', 'GET'],
    ['trusted-local', '/signin', 'GET'],
    ['trusted-local', '/', 'GET'],
    ['trusted-local', '/projects/:owner', 'GET'],
  ]),

  // The two tail answers for an address that no longer exists, in the order
  // they run. `stale-client.ts` is above `wrong-prefix.ts`, so a family named
  // by both is answered 410 and belongs to the first — which is why four of
  // wrong-prefix's seven families are not listed under it here.
  ...family(
    'routes/stale-client.ts',
    PRE_CUTOVER_FAMILIES.flatMap((f): Row[] => [
      ['trusted-local', `/api/${f}`, ANY_METHOD],
      ['trusted-local', `/api/${f}/*`, ANY_METHOD],
    ]),
  ),
  ...family(
    'routes/wrong-prefix.ts',
    WRONG_PREFIX_ONLY_FAMILIES.flatMap((f): Row[] => [
      ['trusted-local', `/api/${f}`, ANY_METHOD],
      ['trusted-local', `/api/${f}/*`, ANY_METHOD],
    ]),
  ),
];
