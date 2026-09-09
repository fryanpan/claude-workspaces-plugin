import type { DocStore } from '../doc-store.ts';
import { type ShareTarget, isLoopbackAddress } from '../middleware/host-guard.ts';
import { browserCannotOperateBody, isBrowserRequest } from '../middleware/write-gate.ts';

/**
 * The repo registry over HTTP: which checkouts of a project are registered,
 * and which copy of a document is live.
 *
 * Every value these routes read and write is a HOST PATH — a checkout root, a
 * repo's main directory, the absolute path of a copy. That is not workspace
 * content, and the board rule is explicit that host-machine facts stay out of
 * what a member sees. So the whole family sits behind the gate
 * `POST /api/deploy` uses, for the same reason: the answer names the machine's
 * filesystem, and nobody off the box has business reading a map of it.
 *
 * Three refusals, and each catches something the others do not:
 *
 * - **`cf-ray`** — Cloudflare stamps it on everything it proxies and strips
 *   any the client sent, so it is the one test that separates "came through
 *   the edge" from "came from here" whatever the socket address says.
 * - **loopback** — the SOCKET address via `requestAddress`, never a header,
 *   because a header is the caller's claim about itself.
 * - **a share or collab visitor** — belt to the admission layer's braces.
 *   `shareScopeAllows` is an allowlist and `/api/repos` is not on it, so a
 *   visitor is already refused before reaching here; this makes the refusal
 *   local, so a path added under an allowed prefix later cannot open it
 *   silently.
 *
 * A browser on this machine is refused too. Nothing above distinguishes a page
 * from an agent — the origin policy admits any machine-local hostname on any
 * port, so a session cookie rides along — and registering a checkout is an
 * operator action, not something a page a person happened to open should do on
 * their behalf.
 */

export interface RepoRoutesContext {
  /** Doc store — owns the registry, the bindings and the live-copy verdict. */
  docStore: DocStore;
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** The request's SOCKET address, never a header. */
  requestAddress: (req: Request) => string | undefined;
}

export interface RepoRouteRequest {
  req: Request;
  pathname: string;
  url: URL;
  /** The share target this request resolved to, or null for a member. */
  visitor: ShareTarget | null;
}

/** The refusal every route here shares, or null when the caller may proceed. */
function offBox(ctx: RepoRoutesContext, rq: RepoRouteRequest): Response | null {
  const { j, requestAddress } = ctx;
  const { req, visitor } = rq;
  if (visitor) return j(403, { error: 'not available to share visitors' });
  if (req.headers.has('cf-ray')) {
    return j(403, {
      error: 'the repo registry is not reachable through the edge — run this from the box',
    });
  }
  if (!isLoopbackAddress(requestAddress(req))) {
    return j(403, {
      error: 'the repo registry is loopback-only — it names host filesystem paths',
    });
  }
  if (isBrowserRequest(req.headers)) return j(403, browserCannotOperateBody());
  return null;
}

/**
 * Validate a caller-supplied checkout path.
 *
 * A host path is the input class that has bitten this repo most, so it is
 * checked here rather than trusted into the registry: a string, absolute, and
 * free of NUL. Whether it is a REPO is the registry's answer, not this one's —
 * that needs the filesystem, and it lives where it can be tested against a
 * real one.
 */
function readPath(body: Record<string, unknown> | null): string | null {
  const raw = body?.path;
  if (typeof raw !== 'string') return null;
  const path = raw.trim();
  if (path === '' || !path.startsWith('/') || path.includes('\u0000')) return null;
  return path;
}

export async function handleRepoRoutes(
  ctx: RepoRoutesContext,
  rq: RepoRouteRequest,
): Promise<Response | undefined> {
  const { docStore, j, safeJson } = ctx;
  const { req, pathname, url } = rq;
  if (pathname !== '/api/repos' && !pathname.startsWith('/api/repos/')) return undefined;

  const refused = offBox(ctx, rq);
  if (refused) return refused;

  // --- The registry, read whole ---
  if (pathname === '/api/repos' && req.method === 'GET') {
    return j(200, {
      repos: docStore.repos.listRepos().map((r) => ({
        repoKey: r.repoKey,
        aliasKeys: r.aliasKeys,
        mainRoot: r.mainRoot,
        remoteUrl: r.remoteUrl,
        checkouts: r.checkouts,
        // What the registry would actually search today: git's own worktree
        // list unioned with the registered rows that still exist on disk. A
        // row whose directory is gone stays listed above, and is absent here.
        live: docStore.repos.checkoutsFor(r.repoKey),
      })),
    });
  }

  if (pathname === '/api/repos/checkouts' && req.method === 'POST') {
    const path = readPath(await safeJson(req));
    if (!path) {
      return j(400, { error: 'path must be an absolute filesystem path to a checkout' });
    }
    const res = docStore.repos.registerCheckout(path);
    if (!res.ok) {
      return j(400, {
        error: res.error,
        hint: "not a git checkout — register a repo's main checkout or a worktree of it",
      });
    }
    return j(200, res);
  }

  // --- Retire a checkout ---
  //
  // The flush is the point of having this verb at all. A removal we are TOLD
  // about is one we can write pending edits out for first; a
  // `git worktree remove` nobody mentioned is not, and this cannot pretend
  // otherwise. Nothing here is destructive — the row keeps its dates, and
  // every doc key still resolves to the same document.
  //
  // Flush, then MOVE: writing the pending edits out is only half of it. Every
  // doc bound inside the checkout is still bound to a path the caller is
  // about to delete, so each one is re-resolved onto another copy of the same
  // file before this answers. The response says what moved, what needs a
  // person to pick between two other copies, and what has no copy left
  // anywhere — the last of which is flagged on the doc rather than left as a
  // write-back that will fail quietly later.
  if (pathname === '/api/repos/checkouts' && req.method === 'DELETE') {
    const path = readPath(await safeJson(req));
    if (!path) {
      return j(400, { error: 'path must be an absolute filesystem path to a checkout' });
    }
    // Ask BEFORE doing anything. This used to flush every pending write and
    // move every binding under the path, and only then discover the registry
    // had never heard of it — real work, on a doc somebody else was editing,
    // done for a caller who gets a 404 and never learns it happened.
    const known = docStore.repos.checkoutRecordFor(path);
    if (!known) return j(404, { error: 'not-registered', path });
    const flushed = docStore.flushBoundWrites([known.root]);
    const retarget = docStore.retargetCheckout(known.root);
    const res = docStore.repos.unregisterCheckout(known.root);
    if (!res.ok) return j(404, { error: 'not-registered', path });
    return j(200, {
      ok: true,
      repoKey: res.repoKey,
      flushed,
      retargeted: retarget.moved,
      needsPick: retarget.ambiguous,
      noCopyLeft: retarget.lost,
    });
  }

  // --- Which copy of a doc is live ---
  //
  // A GET that can write, which is worth saying out loud: resolving records
  // the verdict on the doc and may move the binding. It is a GET because it is
  // idempotent — asking twice gives the same answer and leaves the same state
  // — and because every caller is asking a question.
  if (pathname === '/api/repos/live-copy' && req.method === 'GET') {
    const docId = url.searchParams.get('docId');
    if (!docId) return j(400, { error: 'docId is required' });
    const checkout = url.searchParams.get('checkout');
    const opts: Parameters<DocStore['resolveLiveCopy']>[1] = { withGitStatus: true };
    if (checkout !== null) {
      if (!checkout.startsWith('/') || checkout.includes('\u0000')) {
        return j(400, { error: 'checkout must be an absolute filesystem path' });
      }
      opts.checkout = checkout;
    }
    const res = docStore.resolveLiveCopy(docId, opts);
    if (res.ok) {
      return j(200, {
        ok: true,
        docId,
        live: res.live,
        retargeted: res.retargeted,
        drift: res.drift,
        driftFirings: docStore.peekMeta(docId)?.driftFirings ?? 0,
      });
    }
    // A doc with no repo identity is not an error — most docs have none. It
    // has one copy, wherever it is bound, and that is the whole answer.
    if (res.error === 'no-key') {
      return j(200, {
        ok: true,
        docId,
        live: docStore.boundPathOf(docId) ?? null,
        retargeted: false,
        drift: [],
        driftFirings: 0,
      });
    }
    // 409, not 400: the request was well formed and the server cannot answer
    // it alone. The candidate table IS the body — a refusal that does not say
    // what the choices are is just a failure.
    return j(409, {
      error: 'ambiguous-copy',
      docId,
      candidates: res.candidates,
      hint: 'two checkouts hold different, recently-edited copies — re-request with ?checkout=<root> naming the one to treat as live',
    });
  }

  return j(405, { error: 'method not allowed' });
}
