/**
 * The document half of the dispatch: everything an agent calls to put a file
 * under review and work the comments on it.
 *
 * Docs and their threads, review docs and diff reviews, suggestions, the
 * anchor and block edits, the per-doc watches, and the share links that let
 * somebody outside the machine open one. What they have in common is a
 * `docId` — this is the family the implicit auto-watch in `mcp.ts` was
 * written for, and the reason `observe_url`, `watch_doc` and `unwatch_doc`
 * are exempted from it by name.
 *
 * Dependencies arrive in an explicit context rather than captured from
 * `mcp.ts`, following `routes/task-routes-context.ts` in the server: the
 * entry point owns the HTTP client, the identity and the watch registry, and
 * hands this file the narrow slice it reads. `mcp.ts` is a bundle entry point
 * with top-level side effects, so importing it back would be a cycle through
 * a module that connects a transport on load.
 *
 * The handler answers `undefined` for a name it does not know, and `mcp.ts`
 * chains the three domains with `??` the way the server chains its route
 * families. Every arm is the code that stood in the switch, moved with its
 * comments and dedented one level; nothing about a tool's arguments, its
 * behaviour or its reply changed here.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentAuthor } from '../author.ts';
import { boardIdOf, boardPathOf } from '../board-path.ts';
import {
  agentNotesClient,
  attachmentsClient,
  docEditsClient,
  docLifecycleClient,
  docThreadsClient,
  shareClient,
} from '../server-client.ts';
import { inactiveWatches } from '../sse-loop.ts';
import { type ThreadCreateInput, threadCreateRequest } from '../thread-create.ts';
import type { RestoreState, WatchCoverage } from '../watch-coverage.ts';

/** What the document tools read out of `mcp.ts`. */
export interface DocsToolContext {
  /** The REST call to the feedback server; throws on a non-2xx. */
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ok: (data: unknown) => CallToolResult;
  err: (message: string) => CallToolResult;
  /** This process's identity, sent on everything it authors. */
  AUTHOR: AgentAuthor;
  /** The session's working directory, sent as `owner` on every bind. A field
   *  rather than `process.cwd()`: the shared server hosts sessions from many
   *  directories in one process. */
  CWD: string;
  /** The board a bare `post_status` lands on (`CW_WORKSPACE_ID`), or empty. */
  DEFAULT_WORKSPACE_ID: string;
  /** `post_status`'s ceiling — the server's own `NOTE_TEXT_MAX`. */
  STATUS_TEXT_MAX: number;
  /** The {id,name,color} subset a `suggest: true` route call wants. */
  suggestionAuthor: () => { id: string; name: string; color: string };
  /** Where the SSE stream lives, for `observe_url` to hand back. */
  resolveBaseUrl: () => string;
  /** The live watcher registry, read for its keys only. */
  watchers: ReadonlyMap<string, unknown>;
  watchDoc: (docId: string, persist?: boolean) => Promise<boolean>;
  watchWorkspace: (
    workspaceId: string,
    persist?: boolean,
  ) => Promise<{ open: boolean; persisted: boolean }>;
  unwatchDoc: (docId: string) => Promise<boolean>;
  refreshCoverage: () => Promise<WatchCoverage | undefined>;
  /**
   * The watch-restore state and the last persist failure, as of the start of
   * this tool call. Snapshots rather than live reads: `list_watched_docs` is
   * their only reader and the one call it awaits first, `refreshCoverage`,
   * touches neither.
   */
  restoreState: RestoreState;
  lastPersistError: string | undefined;
  watchPersistenceMode: () => 'server' | 'session-only';
  /** Which transport this session's watches ride — one multiplexed stream, or
   *  a socket per key. Reported so a silent session can be diagnosed without
   *  reading the child's stderr. */
  streamMode: () => 'multiplexed' | 'per-key';
  /** Whether every peer collapsed into one shared identity. */
  IDENTITY_IS_SHARED: boolean;
  SHARED_IDENTITY_REASON: string;
}

/** The arguments `set_sharing_enabled` reads. Anything else is refused. */
const SHARING_SWITCH_ARGS = new Set(['enabled', 'workspaceId', 'reason', 'taskId', 'why']);

/** The arguments `set_board_sharing_lock` reads. Anything else is refused. */
const BOARD_LOCK_ARGS = new Set(['locked', 'workspaceId', 'reason', 'taskId', 'why']);

/**
 * Watch a doc an attach just made, by the id the server answered with. The
 * pre-call auto-watch skips these tools (`ATTACH_THEN_WATCH_TOOLS`): before
 * the create, the alias names no doc, and a board token's watch set refuses a
 * key on no board. Honours `subscribe: false` as the auto-watch does.
 */
async function watchCreated(
  watchDoc: (docId: string) => Promise<boolean>,
  a: Record<string, unknown>,
  res: { docId?: string },
): Promise<void> {
  if (a.subscribe === false) return;
  const docId = res.docId !== undefined && res.docId !== '' ? res.docId : a.docId;
  if (typeof docId === 'string' && docId !== '') await watchDoc(docId);
}

/** Answers the document tools; `undefined` means "not one of mine". */
export async function handleDocsTool(
  name: string,
  a: Record<string, unknown>,
  ctx: DocsToolContext,
): Promise<CallToolResult | undefined> {
  const {
    http,
    ok,
    err,
    AUTHOR,
    CWD,
    DEFAULT_WORKSPACE_ID,
    STATUS_TEXT_MAX,
    suggestionAuthor,
    resolveBaseUrl,
    watchers,
    watchDoc,
    watchWorkspace,
    unwatchDoc,
    refreshCoverage,
    watchPersistenceMode,
    streamMode,
    restoreState,
    lastPersistError,
    IDENTITY_IS_SHARED,
    SHARED_IDENTITY_REASON,
  } = ctx;
  /** The board this call is addressed under — see board-path.ts. */
  const boardId = (): string => boardIdOf(name, a);
  const board = (): string => boardPathOf(name, a);
  /** One doc's thread routes, through the typed client (`server-client.ts`). */
  const threadsApi = () => docThreadsClient(http).workspaces[':ws'].docs[':docId'];
  const threadParam = (docId: string, threadId: string) => ({
    ws: encodeURIComponent(boardId()),
    docId: encodeURIComponent(docId),
    threadId: encodeURIComponent(threadId),
  });
  /** The board's docs collection, and one doc's lifecycle routes. */
  const boardDocs = () => docLifecycleClient(http).workspaces[':ws'];
  const lifecycleApi = () => boardDocs().docs[':docId'];
  /** Attachment sets, the folder bind, and a board's delete. */
  const sets = () => attachmentsClient(http).workspaces;
  /** The `/api/share` operator routes; a member's role and audience are under `board`. */
  const shares = () => shareClient(http);
  const boardParam = () => ({ ws: encodeURIComponent(boardId()) });
  const setParam = (setId: string) => ({ ...boardParam(), setId: encodeURIComponent(setId) });
  /** One doc's edit and anchor routes, through the typed client. */
  const editsApi = () => docEditsClient(http).workspaces[':ws'].docs[':docId'];
  const docParam = (docId: string) => ({
    ws: encodeURIComponent(boardId()),
    docId: encodeURIComponent(docId),
  });
  const anchorParam = (docId: string, anchorId: string) => ({
    ...docParam(docId),
    anchorId: encodeURIComponent(anchorId),
  });
  const suggestionParam = (docId: string, sid: string) => ({
    ...docParam(docId),
    sid: encodeURIComponent(sid),
  });
  // Sent on every scoped edit: the author is whose get_doc reads the server's
  // stale-write rule judges the edit by, and the confirm flag is forwarded
  // only when true, so the default stays the protected path.
  const scoped = (): { author: unknown; confirmOverwriteHumanEdits?: true } => ({
    author: AUTHOR,
    ...(a.confirmOverwriteHumanEdits === true ? { confirmOverwriteHumanEdits: true } : {}),
  });
  switch (name) {
    case 'list_docs': {
      // Every param has to reach the wire: this handler used to issue a
      // bare GET, so a caller's workspaceId was accepted and silently
      // dropped — a board-scoped question answered with the whole server.
      //
      // `limit` is ALWAYS sent. Its presence is what puts the route into
      // paged mode (compact rows, a cursor); without it the route answers
      // the legacy whole-server dump for REST callers, and that dump —
      // 7.4 MB on 2026-09-01, pretty-printed here on the way through — is
      // exactly what a fresh session's first tool call must never be.
      const { kind, query, sourcePrefix, limit, cursor, full } = a as {
        kind?: string;
        query?: string;
        sourcePrefix?: string;
        limit?: number;
        cursor?: string;
        full?: boolean;
      };
      const res = await boardDocs()
        .docs.$get({
          param: { ws: encodeURIComponent(boardId()) },
          query: {
            kind: kind || undefined,
            query: query || undefined,
            sourcePrefix: sourcePrefix || undefined,
            limit: String(
              typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 500) : 50,
            ),
            cursor: cursor || undefined,
            full: full ? '1' : undefined,
          },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'list_threads': {
      const { docId, status } = a as { docId: string; status?: string };
      const res = await threadsApi()
        .threads.$get({
          param: { ws: encodeURIComponent(boardId()), docId: encodeURIComponent(docId) },
          query: status ? { status } : {},
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'get_thread': {
      const { docId, threadId } = a as { docId: string; threadId: string };
      const res = await threadsApi()
        .threads[':threadId'].$get({ param: threadParam(docId, threadId) })
        .then((r) => r.json());
      return ok(res);
    }
    case 'post_reply': {
      const { docId, threadId, text, review, to } = a as {
        docId: string;
        threadId: string;
        text: string;
        review?: unknown;
        to?: unknown;
      };
      const res = await threadsApi()
        .threads[':threadId'].comments.$post({
          param: threadParam(docId, threadId),
          json: {
            author: AUTHOR,
            text,
            review,
            to,
          },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'link_review_item': {
      const { docId, threadId, item, text } = a as {
        docId: string;
        threadId: string;
        item: unknown;
        text?: string;
      };
      const res = await threadsApi()
        .threads[':threadId']['linked-items'].$post({
          param: threadParam(docId, threadId),
          json: { author: AUTHOR, item, text },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'edit_comment': {
      const { docId, threadId, commentId, text, reason } = a as {
        docId: string;
        threadId: string;
        commentId: string;
        text: string;
        reason?: string;
      };
      const res = await threadsApi()
        .threads[':threadId']['edit-comment'].$post({
          param: threadParam(docId, threadId),
          json: { author: AUTHOR, commentId, text, reason },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'post_status': {
      // A status is a NOTE on the row (kind `status`, beside the hooks'
      // `turn` and `denial`), never a comment: the same body the Stop hook
      // posts, under the same agent name, to the row the caller names —
      // or, with no taskId, to the agent's own notes route on the board,
      // which pins it to this agent's current claim there. The board is
      // the workspaceId argument, or the session's CW_WORKSPACE_ID — the
      // same setting the hooks read, since a hook has no argument to
      // carry one. Empty and over-cap text are refused here, where the
      // message can say why; the server would 400 either.
      const { text, taskId } = a as { text?: unknown; taskId?: string };
      const body = typeof text === 'string' ? text.trim() : '';
      if (body === '') return err('text is empty — say where the work stands');
      if (body.length > STATUS_TEXT_MAX) {
        return err(
          `text is over ${STATUS_TEXT_MAX} chars — a status is a line to a few sentences; the full report is already on the Activity tab from your end-of-turn message`,
        );
      }
      const note = { agent: AUTHOR.name, kind: 'status' as const, text: body, at: Date.now() };
      const notes = agentNotesClient(http).workspaces[':ws'];
      let sent: ReturnType<(typeof notes.agents)[':agent']['notes']['$post']>;
      if (taskId !== undefined && taskId !== '') {
        sent = notes.tasks[':taskId'].notes.$post({
          param: { ...boardParam(), taskId: encodeURIComponent(taskId) },
          json: note,
        });
      } else {
        const given = typeof a.workspaceId === 'string' ? a.workspaceId.trim() : '';
        const ws = given !== '' ? given : DEFAULT_WORKSPACE_ID;
        if (ws === '') {
          return err(
            'post_status needs a board: pass workspaceId, or launch the session with CW_WORKSPACE_ID set — a note is addressed under the board whose task it lands on',
          );
        }
        sent = notes.agents[':agent'].notes.$post({
          param: { ws: encodeURIComponent(ws), agent: encodeURIComponent(AUTHOR.name) },
          json: note,
        });
      }
      const res = await sent.then((r) => r.json());
      return ok({
        posted: true,
        ...(res.taskId !== undefined ? { taskId: res.taskId } : {}),
        ...(res.workspaceId !== undefined ? { workspaceId: res.workspaceId } : {}),
        ...(res.taskId === undefined
          ? {
              note: 'no in-progress task of yours to pin this to — kept on your own recent-activity list; pass taskId to put it on a task',
            }
          : {}),
      });
    }
    case 'create_thread': {
      // Two endpoints; omitting `find` opens the thread on the subject.
      // See thread-create.ts.
      const input = a as unknown as ThreadCreateInput;
      const req = threadCreateRequest(input, AUTHOR, board());
      const param = docParam(input.docId);
      const res =
        req.by === 'find'
          ? await threadsApi().threads.by_find.$post({ param, json: req.body })
          : await threadsApi().threads.$post({ param, json: req.body });
      return ok(await res.json());
    }
    case 'resolve_thread': {
      const { docId, threadId } = a as { docId: string; threadId: string };
      const res = await threadsApi()
        .threads[':threadId'].resolve.$post({ param: threadParam(docId, threadId) })
        .then((r) => r.json());
      return ok(res);
    }
    case 'set_thread_progress': {
      const { docId, threadId, state } = a as { docId: string; threadId: string; state: unknown };
      if (state !== 'working' && state !== 'done' && state !== 'open') {
        return err("state must be 'working', 'done' or 'open'");
      }
      const res = await threadsApi()
        .threads[':threadId'].progress.$post({
          param: threadParam(docId, threadId),
          json: { state, author: AUTHOR },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'summarize_thread': {
      const { docId, threadId, force } = a as {
        docId: string;
        threadId: string;
        force?: boolean;
      };
      const res = await threadsApi()
        .threads[':threadId'].summary.$post({
          param: threadParam(docId, threadId),
          json: force ? { force: true } : {},
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'reopen_thread': {
      const { docId, threadId } = a as { docId: string; threadId: string };
      const res = await threadsApi()
        .threads[':threadId'].reopen.$post({ param: threadParam(docId, threadId) })
        .then((r) => r.json());
      return ok(res);
    }
    case 'get_doc': {
      const { docId } = a as { docId: string };
      // `reader` records that THIS session's copy of the doc is current as
      // of now — the marker the stale-write guard compares against the last
      // human edit before allowing a set_doc_content from this author.
      const res = await lifecycleApi()
        .content.$get({ param: docParam(docId), query: { reader: AUTHOR.id } })
        .then((r) => r.json());
      return ok(res);
    }
    case 'doc_status': {
      const { docId } = a as { docId: string };
      const res = await lifecycleApi()
        .status.$get({ param: docParam(docId) })
        .then((r) => r.json());
      return ok(res);
    }
    case 'create_review_doc':
    case 'attach_markdown': {
      const { docId, path, title, setId, producedBy } = a as {
        docId: string;
        path: string;
        title?: string;
        setId?: string;
        producedBy?: { agentId?: string; sessionId?: string };
      };
      const res = await boardDocs()
        .docs.$post({
          param: { ws: encodeURIComponent(boardId()) },
          json: {
            docId,
            type: 'markdown',
            sourceUrl: path,
            owner: CWD,
            title: title || undefined,
            setId: setId || undefined,
            producedBy: producedBy || undefined,
          },
        })
        .then((r) => r.json());
      await watchCreated(watchDoc, a, res);
      return ok(res);
    }
    case 'set_doc_content': {
      const { docId, markdown, confirmOverwriteHumanEdits } = a as {
        docId: string;
        markdown: string;
        confirmOverwriteHumanEdits?: boolean;
      };
      // Author: sent so a rewrite of a `task:<id>` body doc can be
      // attributed the way `rewrite_task` is — and so the stale-write guard
      // can judge this caller by its own get_doc reads instead of the blunt
      // 10-minute window. The confirm flag is forwarded only when true:
      // the default path stays the protected one.
      const res = await lifecycleApi()
        .content.$post({
          param: docParam(docId),
          json: {
            markdown,
            author: AUTHOR,
            confirmOverwriteHumanEdits: confirmOverwriteHumanEdits === true ? true : undefined,
          },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'reparse_from_disk': {
      const { docId } = a as { docId: string };
      const res = await lifecycleApi()
        .reparse_from_disk.$post({ param: docParam(docId) })
        .then((r) => r.json());
      return ok(res);
    }
    case 'delete_doc': {
      const { docId, force } = a as { docId: string; force?: boolean };
      const res = await lifecycleApi()
        .$delete({ param: docParam(docId), query: { force: force ? 'true' : undefined } })
        .then((r) => r.json());
      return ok(res);
    }
    // COMPAT: `bind_mock` and `bind_folder` are the names these two had
    // before Attachment became the product's word for what they do. A peer
    // still running last week's bundle, or an agent working from a stale
    // skill, calls the old name; it lands on the same arm and the log says so
    // once (deprecated-aliases.ts). The tool LIST advertises the new names
    // only — one name for one thing in the table an agent reads.
    case 'bind_mock':
    case 'attach_mockup': {
      const { docId, sourceHtmlPath, title } = a as {
        docId: string;
        sourceHtmlPath?: string;
        title?: string;
      };
      // Same POST /workspaces/<ws>/docs route as attach_markdown, type='mockup'.
      // The server's getOrCreate accepts both shapes; `sourceUrl` is optional
      // for mockups (mockups are served via /demos/ rather than file-watched).
      const res = await boardDocs()
        .docs.$post({
          param: { ws: encodeURIComponent(boardId()) },
          json: {
            docId,
            type: 'mockup',
            owner: CWD,
            sourceUrl: sourceHtmlPath || undefined,
            title: title || undefined,
          },
        })
        .then((r) => r.json());
      await watchCreated(watchDoc, a, res);
      return ok(res);
    }
    case 'attach_app': {
      const { docId, origin, title, servesPrefix } = a as {
        docId: string;
        origin: string;
        title?: string;
        servesPrefix?: boolean;
      };
      // The server owns the loopback rule and answers a refusal naming it, so
      // nothing is checked here that could disagree with it.
      const res = await boardDocs()
        .apps.$post({
          param: { ws: encodeURIComponent(boardId()) },
          json: {
            docId,
            origin,
            owner: CWD,
            // Who the server tells when the dev server stops answering.
            producedBy: { agentId: AUTHOR.id },
            title: title || undefined,
            servesPrefix: typeof servesPrefix === 'boolean' ? servesPrefix : undefined,
          },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'bind_folder':
    case 'attach_folder': {
      const {
        folderPath,
        setId,
        title,
        include,
        exclude,
        maxFiles,
        subscribe,
        producedBy,
        privacy,
      } = a as {
        folderPath: string;
        privacy?: string;
        setId?: string;
        workspaceId?: string;
        title?: string;
        include?: string[];
        exclude?: string[];
        maxFiles?: number;
        subscribe?: boolean;
        producedBy?: { agentId?: string; sessionId?: string };
      };
      const res = await sets()
        .$post({
          json: {
            folderPath,
            owner: CWD,
            // The SET's own id, re-used to refresh an existing attachment set.
            // It used to be spelled `workspaceId` here, which is the word every
            // other tool uses for the BOARD — two meanings on one name, on the
            // one call that takes both. The board is `workspaceId` now, like
            // everywhere else, and the set is `setId`, like delete_review's.
            workspaceId: setId || undefined,
            // Not a path: a folder bind MINTS the set, so it posts to the
            // collection that fronts both stores. The board still has to be
            // named, and `boardId()` is the same requirement the path form
            // makes — one rule, two spellings of the same call.
            hubWorkspaceId: boardId(),
            title: title || undefined,
            include: include || undefined,
            exclude: exclude || undefined,
            maxFiles,
            producedBy: producedBy || undefined,
            // Passed through unchecked: the server refuses anything but its two
            // words, and a typo guessed into `workspace` here would be a folder
            // shared that was meant to stay on the machine.
            privacy,
          },
        })
        .then((r) => r.json());
      // One workspace-level stream covers every member doc (including
      // files the reviewer opens lazily later). Opt out with subscribe:false.
      if (subscribe !== false && 'workspaceId' in res && res.workspaceId) {
        await watchWorkspace(res.workspaceId);
      }
      return ok(res);
    }
    case 'create_diff_review': {
      const {
        repo,
        base,
        target,
        reviewId,
        title,
        exclude,
        groups,
        maxFiles,
        subscribe,
        producedBy,
      } = a as {
        repo: string;
        base: string;
        target?: string;
        reviewId?: string;
        title?: string;
        exclude?: string[];
        groups?: Array<{ title: string; paths: string[]; details?: string }>;
        maxFiles?: number;
        subscribe?: boolean;
        producedBy?: { agentId?: string; sessionId?: string };
      };
      const res = await sets()
        [':ws'].attachments.$post({
          param: boardParam(),
          json: {
            repo,
            base,
            target: target || undefined,
            owner: CWD,
            reviewId: reviewId || undefined,
            title: title || undefined,
            exclude: exclude || undefined,
            groups: groups || undefined,
            maxFiles,
            producedBy: producedBy || undefined,
          },
        })
        .then((r) => r.json());
      // One workspace-level stream covers every member doc (including
      // files opened lazily from the all-files sidebar later). Opt out
      // with subscribe:false.
      if (subscribe !== false && res.reviewId) {
        await watchWorkspace(res.reviewId);
      }
      return ok(res);
    }
    case 'delete_review':
    case 'delete_attachment_set': {
      const { setId, force, purge } = a as { setId: string; force?: boolean; purge?: boolean };
      const res = await sets()
        [':ws'].attachments[':setId'].$delete({
          param: setParam(setId),
          query: { force: force ? 'true' : undefined, purge: purge ? 'true' : undefined },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'archive_review':
    case 'archive_attachment_set': {
      const { setId, reason } = a as { setId: string; reason?: string };
      const res = await sets()
        [':ws'].attachments[':setId'].archive.$post({
          param: setParam(setId),
          json: { author: AUTHOR, reason },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'unarchive_review':
    case 'unarchive_attachment_set': {
      const { setId } = a as { setId: string };
      const res = await sets()
        [':ws'].attachments[':setId'].unarchive.$post({
          param: setParam(setId),
          json: { author: AUTHOR },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'archive_doc': {
      const { docId, reason } = a as { docId: string; reason?: string };
      const res = await lifecycleApi()
        .archive.$post({ param: docParam(docId), json: { author: AUTHOR, reason } })
        .then((r) => r.json());
      return ok(res);
    }
    case 'unarchive_doc': {
      const { docId } = a as { docId: string };
      const res = await lifecycleApi()
        .unarchive.$post({ param: docParam(docId), json: { author: AUTHOR } })
        .then((r) => r.json());
      return ok(res);
    }
    case 'list_archived_reviews':
    case 'list_archived_attachments': {
      const res = await sets()
        [':ws'].attachments.$get({ param: boardParam(), query: { archived: 'true' } })
        .then((r) => r.json());
      return ok(res);
    }
    case 'delete_workspace': {
      const { workspaceId, force, purge } = a as {
        workspaceId: string;
        force?: boolean;
        purge?: boolean;
      };
      // `purge` reaches no reader: the review branch this route once had is
      // gone, and a board's delete reads only `force`.
      const res = await sets()
        [':ws'].$delete({
          param: { ws: encodeURIComponent(workspaceId) },
          query: { force: force ? 'true' : undefined, purge: purge ? 'true' : undefined },
        })
        .then((r) => r.json());
      return ok(res);
    }
    // COMPAT, two generations deep: these two were `refresh_workspace` and
    // `set_workspace_groups` before a review stopped being called a
    // workspace, and `refresh_review` / `set_review_groups` before an
    // attachment set stopped being called a review. An agent working from a
    // stale skill or from memory reaches for whichever name it learned, and
    // either key for the id; all of them are accepted here so the call lands
    // instead of erroring. The tool LIST advertises the newest name only.
    case 'refresh_workspace':
    case 'refresh_review':
    case 'refresh_attachment_set': {
      const { setId, workspaceId } = a as { setId?: string; workspaceId?: string };
      const id = setId ?? workspaceId ?? '';
      const res = await sets()
        [':ws'].attachments[':setId'].refresh.$post({ param: setParam(id), json: {} })
        .then((r) => r.json());
      return ok(res);
    }
    case 'set_workspace_groups':
    case 'set_review_groups':
    case 'set_attachment_groups': {
      const { setId, workspaceId, groups } = a as {
        setId?: string;
        workspaceId?: string;
        groups: Array<{ title: string; paths: string[]; details?: string }>;
      };
      const id = setId ?? workspaceId ?? '';
      const res = await sets()
        [':ws'].attachments[':setId'].groups.$post({ param: setParam(id), json: { groups } })
        .then((r) => r.json());
      return ok(res);
    }
    case 'find_and_replace': {
      const {
        docId,
        find,
        replace,
        contextBefore,
        contextAfter,
        occurrence,
        replaceAll,
        parseInlineMarks,
        suggest,
      } = a as {
        docId: string;
        find: string;
        replace: string;
        contextBefore?: string;
        contextAfter?: string;
        occurrence?: number;
        replaceAll?: boolean;
        parseInlineMarks?: boolean;
        suggest?: boolean;
      };
      // Absent fields are named as `undefined`, which the JSON body leaves
      // out: a named field is one a server-side rename fails typecheck on.
      const res = await editsApi()
        .find_and_replace.$post({
          param: docParam(docId),
          json: {
            ...scoped(),
            find,
            replace,
            contextBefore,
            contextAfter,
            occurrence,
            replaceAll: replaceAll === true ? true : undefined,
            // Forwarded whenever it is a boolean, not only when true: a
            // proposal's offered text parses by DEFAULT, so `false` is the
            // only way to ask for literal characters and dropping it here
            // would answer the opposite of what the caller wrote.
            parseInlineMarks: typeof parseInlineMarks === 'boolean' ? parseInlineMarks : undefined,
            suggest: suggest === true ? true : undefined,
            ...(suggest === true ? { author: suggestionAuthor() } : {}),
          },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'rewrite_thread_region': {
      const { docId, threadId, replacement, parseInlineMarks, suggest } = a as {
        docId: string;
        threadId: string;
        replacement: string;
        parseInlineMarks?: boolean;
        suggest?: boolean;
      };
      const res = await threadsApi()
        .threads[':threadId'].rewrite_region.$post({
          param: threadParam(docId, threadId),
          json: {
            ...scoped(),
            replacement,
            // Forwarded as a boolean, never only-when-true — see
            // find_and_replace above.
            ...(typeof parseInlineMarks === 'boolean' ? { parseInlineMarks } : {}),
            ...(suggest === true ? { suggest: true, author: suggestionAuthor() } : {}),
          },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'list_suggestions': {
      const { docId } = a as { docId: string };
      const res = await editsApi()
        .suggestions.$get({ param: docParam(docId) })
        .then((r) => r.json());
      return ok(res);
    }
    case 'accept_suggestion': {
      const { docId, sid } = a as { docId: string; sid: string };
      const res = await editsApi()
        .suggestions[':sid'].accept.$post({ param: suggestionParam(docId, sid) })
        .then((r) => r.json());
      return ok(res);
    }
    case 'reject_suggestion': {
      const { docId, sid } = a as { docId: string; sid: string };
      const res = await editsApi()
        .suggestions[':sid'].reject.$post({ param: suggestionParam(docId, sid) })
        .then((r) => r.json());
      return ok(res);
    }
    case 'resolve_all_suggestions': {
      const { docId, action, authorId } = a as {
        docId: string;
        action: 'accept' | 'reject';
        authorId?: string;
      };
      const res = await editsApi()
        .suggestions.resolve_all.$post({ param: docParam(docId), json: { action, authorId } })
        .then((r) => r.json());
      return ok(res);
    }
    case 'insert_after_thread': {
      const { docId, threadId, text, markdown } = a as {
        docId: string;
        threadId: string;
        text?: unknown;
        markdown?: unknown;
      };
      if (typeof text !== 'string' || text.length === 0) {
        return err(
          markdown !== undefined
            ? 'insert_after_thread takes `text`, not `markdown` — nothing was inserted. For a new paragraph or section use insert_blocks_after_thread, whose field is `markdown`.'
            : 'insert_after_thread needs a non-empty `text` — nothing was inserted.',
        );
      }
      const res = await threadsApi()
        .threads[':threadId'].insert_after.$post({
          param: threadParam(docId, threadId),
          json: { ...scoped(), text },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'insert_blocks_after_thread': {
      const { docId, threadId, markdown, placement } = a as {
        docId: string;
        threadId: string;
        markdown: string;
        placement?: 'after-block' | 'top-level';
      };
      const res = await threadsApi()
        .threads[':threadId'].insert_blocks_after.$post({
          param: threadParam(docId, threadId),
          json: { ...scoped(), markdown, placement },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'create_anchor': {
      const { docId, find, contextBefore, contextAfter, occurrence, label } = a as {
        docId: string;
        find: string;
        contextBefore?: string;
        contextAfter?: string;
        occurrence?: number;
        label?: string;
      };
      const res = await editsApi()
        .agent_anchors.$post({
          param: docParam(docId),
          json: { find, contextBefore, contextAfter, occurrence, label },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'edit_at_anchor': {
      const { docId, anchorId, op } = a as {
        docId: string;
        anchorId: string;
        op: { kind: 'replace' | 'insert_after'; text: string };
      };
      const res = await editsApi()
        .agent_anchors[':anchorId'].edit.$post({
          param: anchorParam(docId, anchorId),
          json: { ...scoped(), kind: op.kind, text: op.text },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'read_doc_outline': {
      const { docId, headingsOnly, recentBlocks } = a as {
        docId: string;
        headingsOnly?: boolean;
        recentBlocks?: number;
      };
      const q = new URLSearchParams();
      if (headingsOnly === true) q.set('headings_only', '1');
      if (typeof recentBlocks === 'number') q.set('recent', String(recentBlocks));
      const qs = q.toString();
      const res = await http(
        'GET',
        `${board()}/docs/${encodeURIComponent(docId)}/outline${qs ? `?${qs}` : ''}`,
      );
      return ok(res);
    }
    case 'apply_block_edits': {
      const { docId, edits } = a as { docId: string; edits: unknown };
      const res = await editsApi()
        .block_edits.$post({
          param: docParam(docId),
          json: {
            edits,
            // Always sent: block edits are ATTRIBUTED — the id is what later lets
            // this session rewrite its own blocks and stops it rewriting anyone
            // else's, and the name/colour are what a proposal is signed with when
            // an edit lands on a block a person has since touched.
            author: suggestionAuthor(),
          },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'insert_blocks_under_heading': {
      const { docId, headingId, markdown } = a as {
        docId: string;
        headingId: string;
        markdown: string;
      };
      const res = await editsApi()
        .block_edits.$post({
          param: docParam(docId),
          json: {
            edits: [{ op: 'insert_under_heading', headingId, markdown }],
            author: suggestionAuthor(),
          },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'insert_blocks_at_anchor': {
      const { docId, anchorId, markdown, placement } = a as {
        docId: string;
        anchorId: string;
        markdown: string;
        placement?: 'after-block' | 'top-level';
      };
      const res = await editsApi()
        .agent_anchors[':anchorId'].insert_blocks.$post({
          param: anchorParam(docId, anchorId),
          json: { ...scoped(), markdown, placement },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'delete_anchor': {
      const { docId, anchorId } = a as { docId: string; anchorId: string };
      const res = await editsApi()
        .agent_anchors[':anchorId'].$delete({ param: anchorParam(docId, anchorId) })
        .then((r) => r.json());
      return ok(res);
    }
    case 'delete_block_at_anchor': {
      const { docId, threadId, anchorId } = a as {
        docId: string;
        threadId?: string;
        anchorId?: string;
      };
      const res = await editsApi()
        .delete_block_at_anchor.$post({
          param: docParam(docId),
          json: { ...scoped(), threadId, anchorId },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'delete_blocks_in_range': {
      const {
        docId,
        startFind,
        endFind,
        contextBefore,
        contextAfter,
        startOccurrence,
        endOccurrence,
      } = a as {
        docId: string;
        startFind: string;
        endFind: string;
        contextBefore?: string;
        contextAfter?: string;
        startOccurrence?: number;
        endOccurrence?: number;
      };
      const res = await editsApi()
        .delete_blocks_in_range.$post({
          param: docParam(docId),
          json: {
            ...scoped(),
            startFind,
            endFind,
            contextBefore,
            contextAfter,
            startOccurrence,
            endOccurrence,
          },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'delete_section': {
      const { docId, heading, level, occurrence } = a as {
        docId: string;
        heading: string;
        level?: number;
        occurrence?: number;
      };
      const res = await editsApi()
        .delete_section.$post({
          param: docParam(docId),
          json: { ...scoped(), heading, level, occurrence },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'observe_url': {
      const { docId } = a as { docId: string };
      return ok({ sseUrl: `${resolveBaseUrl()}/events/${encodeURIComponent(docId)}` });
    }
    case 'watch_doc': {
      const { docId } = a as { docId: string };
      const persisted = await watchDoc(docId);
      return ok({
        docId,
        watching: Array.from(watchers.keys()),
        persisted,
        persistence: watchPersistenceMode(),
      });
    }
    case 'unwatch_doc': {
      const { docId } = a as { docId: string };
      const persisted = await unwatchDoc(docId);
      return ok({
        docId,
        watching: Array.from(watchers.keys()),
        persisted,
        persistence: watchPersistenceMode(),
      });
    }
    case 'list_watched_docs': {
      // `watching` answers "what am I subscribed to". `coverage` answers
      // the question that actually goes wrong: what am I MISSING. Six live
      // watches is a true answer to the first and an all-clear to nobody —
      // the peer that measured this held exactly that while a voice note
      // queued for a board it had never attached to. Absent rather than
      // empty when the server did not say.
      const coverage = await refreshCoverage();
      // A key whose loop GAVE UP, with the reason. `open: false` alone cannot
      // tell "reconnecting" from "stopped trying", and a doc deleted out from
      // under a watch is the case where the difference matters: the key stays
      // in `watching` and nothing will ever arrive on it. Absent when every
      // watch is still being retried.
      const inactive = inactiveWatches(watchers);
      return ok({
        watching: Array.from(watchers.keys()),
        ...(inactive.length > 0 ? { inactive } : {}),
        persistence: {
          mode: watchPersistenceMode(),
          agentId: AUTHOR.id,
          ...(IDENTITY_IS_SHARED ? { reason: SHARED_IDENTITY_REASON } : {}),
        },
        // `multiplexed` is one socket for the whole set; `per-key` is the old
        // one-socket-per-watch transport, which now happens only for a shared
        // identity or against a server older than the mux route. A session
        // that is unexpectedly on `per-key` is a session whose host is one
        // deploy behind, and that is worth being able to read.
        streamMode: streamMode(),
        restore: restoreState,
        ...(coverage ? { coverage } : {}),
        ...(lastPersistError ? { lastPersistError } : {}),
      });
    }
    case 'share_workspace': {
      // Forwarded AS SENT, plus this session's name. The server reads
      // `allowDomains` as the link's audience and refuses a malformed one;
      // `name` is ignored there for an older bundle's sake. Destructuring
      // named keys here is what once turned an argument nobody honoured into
      // a share wider than the caller asked for; the server refuses or
      // honours each key by name instead.
      const res = await shares()
        .api.share.workspace.$post({
          json: { ...(a as { workspaceId: string }), createdBy: AUTHOR.name },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'remove_share_member': {
      const { workspaceId, email } = a as { workspaceId: string; email: string };
      const res = await shares()
        .api.share.member.remove.$post({ json: { workspaceId, email } })
        .then((r) => r.json());
      return ok(res);
    }
    case 'set_share_member_role': {
      // Addressed under the BOARD, not under `/api/share`: the role lives on
      // the board's membership list, and this is the same route the board's
      // own Settings panel calls. One door, so an agent and a person cannot
      // be judged by two different rules.
      // A promotion files an approval card on `taskId` for the owner; a
      // demotion applies at once (Bryan, 29 Oct: only he lets anyone in).
      const { email, role, taskId, why } = a as {
        email: string;
        role: string;
        taskId?: string;
        why?: string;
      };
      const res = await shares()
        .workspaces[':ws'].members[':email'].role.$post({
          param: { ...boardParam(), email: encodeURIComponent(email) },
          json: { role, taskId, why, author: AUTHOR },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'set_share_audience': {
      // Same door as the board's Settings: removals apply at once, an add
      // that names somebody new files an approval card on `taskId`.
      const { add, remove, taskId, why } = a as {
        add?: string[];
        remove?: string[];
        taskId?: string;
        why?: string;
      };
      const res = await shares()
        .workspaces[':ws'].audience.$post({
          param: boardParam(),
          json: { add, remove, taskId, why, author: AUTHOR },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'set_share_ttl': {
      const { shareId, ttlSeconds } = a as { shareId: string; ttlSeconds: number };
      const res = await shares()
        .api.share[':shareId'].ttl.$post({
          param: { shareId: encodeURIComponent(shareId) },
          json: { ttlSeconds },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'list_shares': {
      const res = await shares()
        .api.share.$get()
        .then((r) => r.json());
      return ok(res);
    }
    case 'unshare': {
      const { shareId } = a as { shareId: string };
      const res = await shares()
        .api.share[':shareId'].$delete({ param: { shareId: encodeURIComponent(shareId) } })
        .then((r) => r.json());
      return ok(res);
    }
    case 'set_sharing_enabled': {
      // Every argument is read or refused. The 23 September call passed a
      // workspaceId this handler dropped, and the master switch went off for
      // every board while the answer said `ok`.
      const extra = Object.keys(a).filter((k) => !SHARING_SWITCH_ARGS.has(k));
      if (extra.length > 0) {
        return err(
          `set_sharing_enabled does not take ${extra.sort().join(', ')}. It takes enabled, workspaceId, reason, taskId and why.`,
        );
      }
      const { enabled, workspaceId, reason, taskId, why } = a as {
        enabled?: boolean;
        workspaceId?: string;
        reason?: string;
        taskId?: string;
        why?: string;
      };
      // No `enabled` = read-only. GET /api/share carries the same `sharing`
      // object the POST returns, so a status check costs nothing and can't
      // change anything by accident.
      if (typeof enabled !== 'boolean') {
        const res = await shares()
          .api.share.$get()
          .then((r) => r.json());
        if (typeof workspaceId !== 'string') return ok(res);
        const closed = res.sharing.closedBoards ?? [];
        return ok({
          ...res,
          workspaceId,
          board: { workspaceId, enabled: !closed.includes(workspaceId) },
        });
      }
      const res = await shares()
        .api.share.enabled.$post({
          json: {
            enabled,
            workspaceId,
            reason,
            taskId,
            why,
            actor: { id: AUTHOR.id, name: AUTHOR.name },
          },
        })
        .then((r) => r.json());
      return ok(res);
    }
    case 'set_board_sharing_lock': {
      const extra = Object.keys(a).filter((k) => !BOARD_LOCK_ARGS.has(k));
      if (extra.length > 0) {
        return err(
          `set_board_sharing_lock does not take ${extra.sort().join(', ')}. It takes workspaceId, locked, reason, taskId and why.`,
        );
      }
      const { locked, workspaceId, reason, taskId, why } = a as {
        locked?: boolean;
        workspaceId?: string;
        reason?: string;
        taskId?: string;
        why?: string;
      };
      if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
        return err('set_board_sharing_lock needs workspaceId: the board to lock or unlock.');
      }
      if (typeof locked !== 'boolean') {
        const res = await shares()
          .api.share.$get()
          .then((r) => r.json());
        const lockedBoards = res.sharing.lockedBoards ?? [];
        return ok({
          workspaceId,
          board: { workspaceId, locked: lockedBoards.includes(workspaceId) },
        });
      }
      const res = await shares()
        .api.share.lock.$post({
          json: {
            workspaceId,
            locked,
            reason,
            taskId,
            why,
            actor: { id: AUTHOR.id, name: AUTHOR.name },
          },
        })
        .then((r) => r.json());
      return ok(res);
    }
  }
  return undefined;
}
