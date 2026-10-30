/**
 * Creating a board or binding a folder, the diff review beside it, and the two reads of a board.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `WorkspaceRoutesContext` instead of the scope.
 */
import { classifyActor } from '../actor-identity.ts';
import {
  ATTACHMENT_PRIVACY_ERROR,
  parseAttachmentPrivacy,
  privacyNote,
} from '../attachment-privacy.ts';
import { leadSetId } from '../board-socket-roots.ts';
import { restIs } from '../middleware/workspace-scope.ts';
import { browserCannotBindBody, isBrowserRequest } from '../middleware/write-gate.ts';
import {
  redactBoardWorkspaceForVisitor,
  redactCapChangeForVisitor,
} from '../share/redact-workspace.ts';
import { summarizeGoals } from '../task-queue.ts';
import { isRetired, retiredNotice } from '../tasks.ts';
import { wantsJson } from '../workspace-path.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceCreateRead(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const {
    taskStore,
    taskProjection,
    docStore,
    j,
    safeJson,
    isValidDocId,
    withReviewUrl,
    parallelismCapView,
    fileUnderBoardWorkspace,
    attachmentPrivacy,
    externalBaseUrl,
  } = ctx;
  /**
   * The page a review opens on: its meatiest member, or — when it has no
   * member to land on — the review's own address, which the shell redirects
   * to whichever member it holds by the time a person clicks.
   */
  const reviewEntryUrl = (
    boardWorkspaceId: string,
    setId: string,
    files: ReadonlyArray<{ reviewUrl?: string; additions?: number; deletions?: number }>,
  ): string => {
    const weight = (f: { additions?: number; deletions?: number }) =>
      (f.additions ?? 0) + (f.deletions ?? 0);
    const entry = files.reduce<(typeof files)[number] | undefined>(
      (best, f) => (best === undefined || weight(f) > weight(best) ? f : best),
      undefined,
    );
    return (
      entry?.reviewUrl ??
      `${externalBaseUrl()}/workspaces/${encodeURIComponent(boardWorkspaceId)}/attachments/${encodeURIComponent(setId)}`
    );
  };
  /**
   * A folder bind's `links` with each file's page link as `url`. Most are not
   * docs yet, so there is no doc for `withReviewUrl` to place: the link is
   * minted under the board the set was just filed on, the address an opened
   * member has, and the first request to it opens the doc
   * (`openListedMember`).
   */
  const withLinkUrls = (
    boardWorkspaceId: string,
    links: ReadonlyArray<{ relPath: string; docId: string }>,
  ) =>
    links.map((l) => ({
      ...l,
      url: `${externalBaseUrl()}/workspaces/${encodeURIComponent(boardWorkspaceId)}/docs/${encodeURIComponent(l.docId)}`,
    }));
  const { req, pathname, url, scope, visitor, authorFor } = rq;
  // --- REST: workspaces (board create OR folder bind) ---
  // One resource, two shapes: `folderPath` binds a folder of files
  // (the review), `name` creates a board Workspace —
  // a NEW first-class entity with a crypto-random id that tasks and
  // goals hang off (plan §3.12 commit 1). Nothing is migrated between
  // the two; attach_doc LINKS existing docs/attachments to a board workspace.
  if (pathname === '/workspaces' && req.method === 'POST') {
    const body = await safeJson(req);
    const folderPath = body?.folderPath as string | undefined;
    // A board's lead reaches this path (`middleware/lead-scope.ts`) for a
    // folder bind on its own board, and nothing else: the path names no
    // board, so the body is held to it here.
    let lead: LeadBind | null = null;
    if (visitor || rq.leadBoard) {
      const judged = refuseLeadBind(rq.leadBoard ?? null, body, ctx.leadBindRoot);
      if ('error' in judged) return j(403, judged);
      // A set id of the lead's board's own, so the bind can never land on a
      // set another board holds for the same folder.
      const elsewhere = taskStore
        .listWorkspaces()
        .some((w) => w.id !== judged.board && w.docIds.includes(judged.setId));
      if (elsewhere)
        return j(403, {
          error: 'out_of_lead_scope',
          message: 'That folder’s set is filed on another board.',
        });
      lead = judged;
    }
    // Creating a board by name involves no file and stays open to the
    // app; binding a FOLDER names a host path, and that is agents only
    // — see browserCannotBindBody.
    if (folderPath && isBrowserRequest(req.headers)) {
      return j(403, browserCannotBindBody());
    }
    if (!folderPath && typeof body?.name === 'string' && body.name.trim().length > 0) {
      // `body.goal` is the removed workspace-level text goal. Read
      // deliberately nowhere: bundles built before the removal still
      // send it, and refusing a field the server has stopped caring
      // about would fail a caller for saying something harmless.
      // Who leads the board. Explicit `leadAgentId` wins; otherwise the
      // CREATING agent takes the seat — which is the whole point of
      // "every workspace has a lead, always": the common path is an
      // agent minting a board for work it is about to do. A person
      // creating one leaves the seat open rather than being installed
      // as an agent lead; the first agent to attach claims it.
      const claimed = body?.leadAgentId;
      const author = authorFor(body?.author);
      const leadAgentId =
        typeof claimed === 'string' && claimed.trim().length > 0
          ? claimed.trim()
          : author && classifyActor(author) === 'agent'
            ? author.id
            : undefined;
      const workspace = taskStore.createWorkspace(body.name.trim(), {
        ...(leadAgentId !== undefined ? { leadAgentId } : {}),
      });
      // createWorkspace emits no event (nothing subscribes to a
      // workspace that doesn't exist yet), so the route brings the
      // board doc up itself.
      taskProjection.ensureWorkspace(workspace.id);
      return j(200, {
        workspace,
        url: `${externalBaseUrl()}/workspaces/${encodeURIComponent(workspace.id)}`,
      });
    }
    if (!folderPath || typeof folderPath !== 'string') {
      return j(400, { error: 'folderPath (folder bind) or name (board workspace) required' });
    }
    // Whether the set's files may leave this machine (attachment-privacy.ts).
    // Checked BEFORE the bind, so a typo binds nothing: the only reason to
    // write this field is to restrict, and a bind that went ahead as
    // shareable over a misspelled `local-only` is the one wrong outcome.
    const requestedPrivacy = parseAttachmentPrivacy(body?.privacy);
    if (requestedPrivacy === 'bad') return j(400, { error: ATTACHMENT_PRIVACY_ERROR });
    if (requestedPrivacy !== null && !attachmentPrivacy.writable()) {
      return j(503, {
        error: 'privacy_store_unreadable',
        detail: attachmentPrivacy.loadError,
        hint: 'attachment-privacy.json in the data directory cannot be read, so every attachment set is served as local-only and none can be changed until it is fixed.',
      });
    }
    const res = await docStore.bindFolder({
      // A lead's bind is by the registered root, never the path it sent.
      folderPath: lead?.root ?? folderPath,
      // `workspaceId` is what this body key was called before a review
      // stopped being a workspace; both are read, neither is required.
      setId: lead?.setId ?? ((body?.setId ?? body?.workspaceId) as string | undefined),
      title: body?.title as string | undefined,
      include: Array.isArray(body?.include) ? (body.include as string[]) : undefined,
      // Accepted by bindFolder and honoured by the scan since forever,
      // but this route never forwarded it — so bind_folder's exclude had
      // no effect end-to-end. It matters more now: refresh_workspace
      // persists and replays the exclude, which is meaningless if the
      // bind could never set one. (/api/diffs already forwarded it.)
      exclude: Array.isArray(body?.exclude) ? (body.exclude as string[]) : undefined,
      maxFiles: typeof body?.maxFiles === 'number' ? Number(body.maxFiles) : undefined,
      owner: body?.owner as string | undefined,
      // A lead's claim of who produced the set is not taken.
      producedBy: lead
        ? undefined
        : (body?.producedBy as { agentId?: string; sessionId?: string } | undefined),
    });
    if (!res.ok) {
      // not-found → 404; reserved-namespace → 400 (the caller chose an
      // id it may not have, and no amount of narrowing fixes that);
      // too-many-files → 409 (guardrail, caller must narrow the folder
      // or raise maxFiles).
      const status =
        res.error === 'not-found' ? 404 : res.error === 'reserved-namespace' ? 400 : 409;
      return j(status, res);
    }
    // The privacy is recorded BEFORE the set is filed on a board, so there is
    // no moment at which a share on that board reaches a set meant to stay
    // here. Omitted keeps what the set already had: a re-bind that forgot the
    // flag must not quietly widen a local-only set back to shareable.
    if (requestedPrivacy !== null) attachmentPrivacy.set(res.workspaceId, requestedPrivacy);
    const privacy = attachmentPrivacy.privacyOf(res.workspaceId);
    // The GROUPING goes on the board, not its members: `res.workspaceId`
    // is the review id, and one row for the whole bind is the unit a
    // reader thinks in. See the vocabulary note above `fileUnderBoardWorkspace`.
    const boardWorkspaceId = fileUnderBoardWorkspace(
      res.workspaceId,
      body?.hubWorkspaceId as string | undefined,
    );
    // Minted AFTER the filing: a doc no board holds has no address.
    const files = res.files.map((f) => ({
      ...f,
      reviewUrl: withReviewUrl({ docId: f.docId, type: f.type }).reviewUrl,
    }));
    const entryUrl = reviewEntryUrl(boardWorkspaceId, res.workspaceId, files);
    return j(200, {
      ...res,
      // The review's id, under the name the CRDT already stores it as.
      // `workspaceId` (from ...res) carries the SAME value and is
      // deprecated for one release — a caller built before the rename
      // reads it by that name, and a key must never change MEANING.
      setId: res.workspaceId,
      hubWorkspaceId: boardWorkspaceId,
      // Said on every answer, not only when asked for: a caller that omitted
      // the flag is told its folder is shareable rather than left to assume.
      privacy,
      privacyNote: privacyNote(privacy),
      files,
      links: withLinkUrls(boardWorkspaceId, res.links),
      entryUrl,
      url: entryUrl,
    });
  }
  // --- REST: diff attachments — POST /workspaces/<ws>/attachments ---
  // One doc per changed file, grouped as a review (= the review id), FILED ON
  // THE BOARD IN THE PATH. It was `POST /api/diffs` with an optional
  // `hubWorkspaceId` in the body, which meant the board a review landed on
  // was a field a caller could forget — and a forgotten one filed the review
  // under a default nobody chose. Under the canonical shape the board is the
  // address, so there is no version of this call that does not say where the
  // review goes.
  //
  // Default mode diffs base → the WORKING TREE (live: docs bind to the
  // files on disk and re-render as the agent edits); pass `target` for a
  // review pinned to a commit. Returns per-file reviewUrls plus an
  // entryUrl (= `url`) that always opens the review, for a human.
  if (restIs(scope, 'attachments') && req.method === 'POST') {
    // `repo` is a host path this server will read and serve — the same
    // class as the folder bind above, and refused on the same terms.
    // See browserCannotBindBody. Omitting `base` scans the WHOLE folder
    // and makes every file in it lazily openable, so this is the wider
    // of the two, not the narrower.
    if (isBrowserRequest(req.headers)) return j(403, browserCannotBindBody());
    const body = await safeJson(req);
    const repoPath = body?.repo as string | undefined;
    const base = body?.base as string | undefined;
    const target = body?.target as string | undefined;
    if (!repoPath) {
      return j(400, {
        error:
          'repo is required. base optional: omit for a BROWSE workspace (no diff); pass base to diff against the working tree; base+target for a pinned range.',
      });
    }
    if (target && !base) {
      return j(400, { error: 'target requires base' });
    }
    const reviewId = body?.reviewId as string | undefined;
    if (reviewId !== undefined && !isValidDocId(reviewId)) {
      return j(400, { error: 'bad reviewId' });
    }
    const res = await docStore.bindDiff({
      repoPath,
      base,
      target,
      reviewId,
      title: body?.title as string | undefined,
      exclude: Array.isArray(body?.exclude) ? (body.exclude as string[]) : undefined,
      groups: Array.isArray(body?.groups)
        ? (body.groups as Array<{ title: string; paths: string[]; details?: string }>)
        : undefined,
      maxFiles: typeof body?.maxFiles === 'number' ? Number(body.maxFiles) : undefined,
      owner: body?.owner as string | undefined,
      producedBy: body?.producedBy as { agentId?: string; sessionId?: string } | undefined,
    });
    if (!res.ok) {
      const status =
        res.error === 'not-found' || res.error === 'bad-ref'
          ? 404
          : res.error === 'empty-diff' ||
              res.error === 'group-details-too-long' ||
              res.error === 'bad-groups'
            ? 400
            : 409;
      return j(status, res);
    }
    // One row per REVIEW on the board, never one per changed file — the
    // members are reachable through the review's own tree. Idempotent, so
    // a re-run cannot sweep a live review out of the board a reviewer
    // already filed it on.
    // The board comes from the PATH now — `hubWorkspaceId` in the body is
    // gone with the old address, and is not read as a fallback: two ways to
    // say where a review is filed is one way for them to disagree.
    //
    // FILED BEFORE any URL is minted. A doc is addressed under the board
    // holding it, so minting first gave a first bind's members no URL at
    // all, and `entryUrl` went missing on every review except a re-run.
    const boardWorkspaceId = fileUnderBoardWorkspace(res.reviewId, scope?.workspaceId);
    const files = res.files.map((f) => ({
      ...f,
      reviewUrl: withReviewUrl({ docId: f.docId, type: f.type }).reviewUrl,
    }));
    // Land the reviewer on the MEATIEST change, not the first file
    // alphabetically (which is usually dotfile/config noise on a big
    // review). The in-page tree navigates to everything else.
    const entryUrl = reviewEntryUrl(boardWorkspaceId, res.reviewId, files);
    // `setId` is the same value as `reviewId`, under the name the CRDT
    // stores it as — both stay, and neither changes meaning.
    return j(200, {
      ...res,
      setId: res.reviewId,
      hubWorkspaceId: boardWorkspaceId,
      files,
      ...(res.links ? { links: withLinkUrls(boardWorkspaceId, res.links) } : {}),
      entryUrl,
      url: entryUrl,
    });
  }
  // List bound workspaces with rolled-up triage signals (fileCount,
  // openThreads, allIdle, owner, lastActivityAt). The daily triage uses
  // this to treat a folder bind as one cleanup unit.
  if (pathname === '/workspaces' && req.method === 'GET') {
    return j(200, {
      workspaces: docStore.listWorkspaces(),
      // Board workspaces (the boards) are a different thing from the
      // reviews above and stay in their own key rather than
      // being mixed into one list. They belong on this route because a
      // workspace the SERVER materialized for an unfiled doc has no
      // other way to be found: nobody was told its id at creation time.
      boardWorkspaces: taskStore.listWorkspaces().map((w) => ({
        id: w.id,
        name: w.name,
        docCount: w.docIds.length,
        createdAt: w.createdAt,
        // Present only when true, so a client that has never heard of
        // retirement reads exactly what it read before, and one that
        // has can filter on the key's presence.
        ...(isRetired(w) ? { retired: true, retiredAt: w.retiredAt } : {}),
      })),
    });
  }
  // --- REST: board workspaces + tasks (plan §3.10) ---
  // Every handler below hand-copies body fields into the store call.
  // A field that isn't copied is silently discarded while the request
  // still returns 200 — so every param here has an HTTP-level test in
  // task-routes.test.ts (the `groups` lesson).
  const boardWsMatch = pathname.match(/^\/workspaces\/([^/]+)$/);
  // `?format=json` and nothing else. `/workspaces/<id>` is the board's PAGE
  // as well as its record now that the `/api` prefix is gone, and the browser
  // asking for the page must fall through to the HTML shell at the tail of
  // the chain rather than be answered here with a body it cannot render.
  if (boardWsMatch && req.method === 'GET' && wantsJson(url)) {
    const workspaceId = decodeURIComponent(boardWsMatch[1] ?? '');
    const stored = taskStore.getWorkspace(workspaceId);
    if (!stored) return j(404, { error: 'workspace not found' });
    // A visitor gets a PROJECTION, never the stored record. This route
    // is on the visitor allowlist as "workspace name + goal text"
    // (host-guard.ts), and the record it used to answer with verbatim
    // carries `notesHome.repoRoot` — an absolute path on this machine —
    // and `retiredBy`, an actor id every neighbouring visitor surface
    // strips. See redactBoardWorkspaceForVisitor. The local surface keeps
    // the whole record: `notesHome` is what the settings panel edits.
    const workspace = visitor ? redactBoardWorkspaceForVisitor(stored) : stored;
    // Goals with their counts, in priority order. The goals were always
    // in this payload and no MCP tool read it, so ordering lived in
    // each agent's head; the counts are what make the list answer
    // "where is the open work" without a second call per goal.
    const capView = parallelismCapView(workspaceId);
    // Who moved the cap, given to a visitor the way every other visitor
    // surface gives an actor: name and kind, no id. The SAME change over
    // their SSE feed is already reduced by `displayActor`
    // (redactBoardEventForVisitor), and the transport and the surface have
    // to agree about the same fact — an id here is one the neighbouring
    // `retiredBy` redaction exists to strip. The local surface keeps the
    // full actor. Shared with `GET …/settings`, the third door onto this
    // fact, which used to answer it with the id still on.
    const capLastChange =
      capView?.lastChange === undefined
        ? undefined
        : visitor
          ? redactCapChangeForVisitor(capView.lastChange)
          : capView.lastChange;
    return j(200, {
      workspace,
      // How many builders the board may run and how many it is running,
      // so an agent deciding what to work on sees the ceiling in the
      // same read as the goals — `set_parallelism_cap` changes it.
      ...(capView
        ? {
            parallelismCap: {
              value: capView.cap,
              isDefault: capView.isDefault,
              inUse: capView.inUse,
              free: capView.free,
              // Who moved it last, when, from what — so a lowered cap
              // is a fact with an author, not a mystery.
              ...(capLastChange !== undefined ? { lastChange: capLastChange } : {}),
            },
          }
        : {}),
      // The rows argument is what lets each band carry its own status
      // (and done attribution) — the counts say where the open work is,
      // the status says what somebody declared about the band itself.
      goalSummary: summarizeGoals(
        taskStore.listTasks(workspaceId),
        stored.goals,
        taskStore.listGoalRows(workspaceId),
      ),
      // The board has been stood down. Present only when it has, and
      // carrying prose rather than a flag, because the reader is
      // usually an agent deciding whether to work here and a boolean
      // gives it nothing to act on.
      ...(isRetired(stored) ? { retired: retiredNotice(stored) } : {}),
    });
  }
  return undefined;
}

/** The most files a lead's bind may ask the scan for. */
const LEAD_MAX_FILES = 5_000;

interface LeadBind {
  board: string;
  /** The registered root the folder resolved to: what is bound. */
  root: string;
  setId: string;
}

/**
 * Why a lead's `POST /workspaces` is refused, or what it binds. Only a
 * folder bind; only on the lead's own board; never re-filing a set by id,
 * which could name one on another board; and only a folder that resolves to
 * a root registered for that board (`board-socket-roots.ts`). Every read
 * and write the bind leads to then goes through `tree-fs.ts`.
 */
function refuseLeadBind(
  leadBoard: string | null,
  body: Record<string, unknown> | null,
  leadBindRoot: (boardId: string, folderPath: string) => string | null,
): { error: string; message: string } | LeadBind {
  const refuse = (message: string) => ({ error: 'out_of_lead_scope', message });
  if (leadBoard === null) return refuse('Only a board’s lead may bind a folder from here.');
  const folderPath = body?.folderPath;
  if (typeof folderPath !== 'string' || folderPath === '')
    return refuse('A lead may bind a folder here, and not create a board.');
  if (body?.hubWorkspaceId !== leadBoard)
    return refuse('A lead binds a folder onto its own board only.');
  if (body?.setId !== undefined || body?.workspaceId !== undefined)
    return refuse('A lead may not re-file an attachment set by id.');
  const { maxFiles } = body;
  if (
    maxFiles !== undefined &&
    !(
      Number.isInteger(maxFiles) &&
      (maxFiles as number) > 0 &&
      (maxFiles as number) <= LEAD_MAX_FILES
    )
  )
    return refuse(`A lead’s maxFiles is a whole number from 1 to ${LEAD_MAX_FILES}.`);
  const root = leadBindRoot(leadBoard, folderPath);
  if (root === null)
    return refuse(
      'A lead binds one of the folders registered for its board (PUT /api/board-sockets/<board>/roots), and narrows to a subfolder with include.',
    );
  return { board: leadBoard, root, setId: leadSetId(root, leadBoard) };
}
