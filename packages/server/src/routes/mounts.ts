import { mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  MEETING_RETENTIONS,
  applyMeetingGitignore,
  parseMeetingRetention,
} from '../meeting-home.ts';
import { type ShareTarget, isLoopbackAddress } from '../middleware/host-guard.ts';
import { browserCannotOperateBody, isBrowserRequest } from '../middleware/write-gate.ts';
import { isMountableRelPath } from '../mount-scan.ts';
import type { MountStore } from '../mount-store.ts';

/**
 * Mounted project folders over HTTP: the lead's mount table, and the address
 * every file in it answers at.
 *
 * **Two families with two different gates**, and the split is the whole
 * security story of this feature.
 *
 * `/api/mounts…` is the lead's table. Every value it reads and writes is a
 * HOST PATH — a folder to mount, a repo's main directory, the relative path
 * of a conventions index — so it sits behind exactly the gate `/api/repos`
 * and `POST /api/deploy` use: no share or collab visitor, no `cf-ray`, a
 * loopback socket address, and no browser. Registering storage is an operator
 * action.
 *
 * `/mounts/<fileId>` is the ADDRESS, and it has to be readable by the people
 * a file was mounted for. It is not on `shareScopeAllows`, so a share or
 * collab visitor never reaches it — and it refuses one locally as well, so a
 * path added under an allowed prefix later cannot open it silently. What is
 * left is a board member, over the tunnel or the tailnet.
 *
 * **Privacy is what narrows that.** A project marked `local-only` serves its
 * files only to a loopback caller with no `cf-ray` — an agent or a browser on
 * the box itself. Its bytes do not leave the machine even for a signed-in
 * member on Bryan's own iPad, because "must not leave the machine" is a claim
 * about the network and not about who is asking.
 */

export interface MountRoutesContext {
  mounts: MountStore;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** The request's SOCKET address, never a header. */
  requestAddress: (req: Request) => string | undefined;
}

export interface MountRouteRequest {
  req: Request;
  pathname: string;
  url: URL;
  /** The share target this request resolved to, or null for a member. */
  visitor: ShareTarget | null;
}

/** Did this request come from this machine, unproxied? */
function isOnBox(ctx: MountRoutesContext, req: Request): boolean {
  if (req.headers.has('cf-ray')) return false;
  return isLoopbackAddress(ctx.requestAddress(req));
}

/** The refusal the whole `/api/mounts` family shares, or null to proceed. */
function offBox(ctx: MountRoutesContext, rq: MountRouteRequest): Response | null {
  const { j } = ctx;
  const { req, visitor } = rq;
  if (visitor) return j(403, { error: 'not available to share visitors' });
  if (req.headers.has('cf-ray')) {
    return j(403, {
      error: 'the mount table is not reachable through the edge — run this from the box',
    });
  }
  if (!isLoopbackAddress(ctx.requestAddress(req))) {
    return j(403, { error: 'the mount table is loopback-only — it names host filesystem paths' });
  }
  if (isBrowserRequest(req.headers)) return j(403, browserCannotOperateBody());
  return null;
}

/**
 * Validate a caller-supplied host path.
 *
 * A string, absolute, and free of NUL. Whether it is inside a repo, and
 * whether it is a directory, are the store's answers rather than this one's:
 * both need the filesystem.
 */
function readPath(body: Record<string, unknown> | null, field = 'path'): string | null {
  const raw = body?.[field];
  if (typeof raw !== 'string') return null;
  const path = raw.trim();
  if (path === '' || !path.startsWith('/') || path.includes('\u0000')) return null;
  return path;
}

/** Content types a mounted file is served as. Anything else is a download. */
const CT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * The mount routes. `undefined` means none matched and the chain continues.
 */
export async function handleMountRoutes(
  ctx: MountRoutesContext,
  rq: MountRouteRequest,
): Promise<Response | undefined> {
  const { pathname } = rq;
  if (pathname === '/mounts' || pathname.startsWith('/mounts/')) return serveMountedFile(ctx, rq);
  if (pathname !== '/api/mounts' && !pathname.startsWith('/api/mounts/')) return undefined;

  const { mounts, j, safeJson } = ctx;
  const { req, url } = rq;
  const refused = offBox(ctx, rq);
  if (refused) return refused;

  // --- The table, read whole ---
  if (pathname === '/api/mounts' && req.method === 'GET') {
    const path = url.searchParams.get('path');
    const only = path ? mounts.locate(path)?.repoKey : undefined;
    if (path && !only) return j(400, { error: 'not-a-repo', path });
    const projects = mounts.registry.listProjects().filter((p) => !only || p.repoKey === only);
    return j(200, {
      projects: projects.map((p) => {
        // One walk per project, not one per mount: the counts below are all
        // slices of the same listing, and that listing is what says which
        // files are there NOW — the table also holds every address the
        // project has ever handed out, and those are not rows to report.
        const listing = mounts.reconcile(p.repoKey);
        return {
          repoKey: p.repoKey,
          root: mounts.rootFor(p.repoKey),
          privacy: p.privacy,
          conventionsPath: p.conventionsPath,
          truncated: listing.truncated,
          mounts: p.mounts.map((m) => ({
            mountId: m.mountId,
            relPath: m.relPath,
            addedAt: m.addedAt,
            removedAt: m.removedAt,
            checkoutRoot: m.checkoutRoot,
            fileCount:
              m.removedAt === undefined
                ? listing.files.filter((f) => f.mountId === m.mountId).length
                : 0,
          })),
        };
      }),
    });
  }

  // --- One mount's files, paged ---
  if (pathname === '/api/mounts/files' && req.method === 'GET') {
    const path = url.searchParams.get('path');
    if (!path) return j(400, { error: 'path is required' });
    const at = mounts.locate(path);
    if (!at) return j(400, { error: 'not-a-repo', path });
    const mountId = url.searchParams.get('mountId') ?? undefined;
    const after = url.searchParams.get('after') ?? undefined;
    const limitRaw = Number(url.searchParams.get('limit') ?? '200');
    const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
    const opts: Parameters<MountStore['listFiles']>[1] = { limit };
    if (mountId !== undefined) opts.mountId = mountId;
    if (after !== undefined) opts.after = after;
    const res = mounts.listFiles(at.repoKey, opts);
    return j(200, { repoKey: at.repoKey, ...res });
  }

  // --- Mount a folder ---
  if (pathname === '/api/mounts' && req.method === 'POST') {
    const path = readPath(await safeJson(req));
    if (!path) return j(400, { error: 'path must be an absolute filesystem path to a folder' });
    const res = mounts.mount(path);
    if (!res.ok) {
      return j(400, {
        error: res.error,
        hint:
          res.error === 'not-a-repo'
            ? 'a mount is a folder inside a git checkout — the repo is what gives its files a durable address'
            : res.error === 'refused-path'
              ? 'dot-directories are never mounted: every file under one is refused at serve time, so the mount would hold nothing'
              : 'that path is not a directory',
      });
    }
    const listing = mounts.reconcile(res.project.repoKey, true);
    return j(200, {
      ok: true,
      mountId: res.mount.mountId,
      repoKey: res.project.repoKey,
      relPath: res.mount.relPath,
      created: res.created,
      privacy: mounts.privacyOf(res.project.repoKey),
      fileCount: listing.files.filter((f) => f.mountId === res.mount.mountId).length,
      // A capped walk is said out loud: the count is a floor, not a total.
      truncated: listing.truncated,
    });
  }

  // --- Retire a mount ---
  //
  // Soft, and it is the only removal there is. Nothing under the folder is
  // touched, no address is dropped, and re-mounting the same folder revives
  // the same row: retention is the project's, and workspaces deletes nothing
  // it did not create.
  if (pathname === '/api/mounts' && req.method === 'DELETE') {
    const body = await safeJson(req);
    const path = readPath(body);
    const mountId = typeof body?.mountId === 'string' ? body.mountId : null;
    if (!path || !mountId) {
      return j(400, { error: 'path (absolute) and mountId are both required' });
    }
    const at = mounts.locate(path);
    if (!at) return j(400, { error: 'not-a-repo', path });
    if (!mounts.unmount(at.repoKey, mountId)) {
      return j(404, { error: 'no-such-mount', mountId });
    }
    return j(200, { ok: true, repoKey: at.repoKey, mountId, filesLeftOnDisk: true });
  }

  // --- Privacy, over all of a project's mounts at once ---
  if (pathname === '/api/mounts/privacy' && req.method === 'PUT') {
    const body = await safeJson(req);
    const path = readPath(body);
    const privacy = body?.privacy;
    if (!path) return j(400, { error: 'path must be an absolute filesystem path' });
    if (privacy !== 'workspace' && privacy !== 'local-only') {
      return j(400, { error: "privacy must be 'workspace' or 'local-only'" });
    }
    const at = mounts.locate(path);
    if (!at) return j(400, { error: 'not-a-repo', path });
    const project = mounts.setPrivacy(at.repoKey, privacy);
    return j(200, { ok: true, repoKey: project.repoKey, privacy: project.privacy });
  }

  // --- The conventions index ---
  if (pathname === '/api/mounts/conventions') {
    if (req.method === 'GET') {
      const path = rq.url.searchParams.get('path');
      if (!path) return j(400, { error: 'path is required' });
      const at = mounts.locate(path);
      if (!at) return j(400, { error: 'not-a-repo', path });
      const found = mounts.conventions(at.repoKey);
      return j(200, { repoKey: at.repoKey, ...found });
    }
    if (req.method === 'PUT') {
      const body = await safeJson(req);
      const path = readPath(body);
      const relPath = typeof body?.conventionsPath === 'string' ? body.conventionsPath.trim() : '';
      if (!path) return j(400, { error: 'path must be an absolute filesystem path' });
      // The same shape a mount takes: repo-relative, no escape, no dotdir.
      // It is read back to the caller, so a `..` here would be an arbitrary
      // file read wearing a settings write's clothes.
      if (!isMountableRelPath(relPath) || relPath.endsWith('/')) {
        return j(400, {
          error:
            'conventionsPath must be a repo-relative file path with no .. and no dot-directory',
        });
      }
      const at = mounts.locate(path);
      if (!at) return j(400, { error: 'not-a-repo', path });
      const project = mounts.setConventionsPath(at.repoKey, relPath);
      return j(200, {
        ok: true,
        repoKey: project.repoKey,
        conventionsPath: project.conventionsPath,
      });
    }
  }

  // --- Where this project's meetings file, and what it keeps ---
  //
  // One PUT for all three, because they are one decision: a project saying
  // "meetings go in docs/meetings, keep the words, keep them out of git" is
  // answering a single question, and three routes would let a caller land
  // half of it. `retention` and `gitignore` are optional only so a caller
  // moving the folder need not restate a choice it already made.
  if (pathname === '/api/mounts/meetings' && req.method === 'PUT') {
    const body = await safeJson(req);
    const path = readPath(body);
    const relPath = typeof body?.meetingsPath === 'string' ? body.meetingsPath.trim() : '';
    if (!path) return j(400, { error: 'path must be an absolute filesystem path' });
    // The shape a mount takes, and for the same reason: this becomes a
    // directory this server WRITES into, so a `..` here is an arbitrary
    // write wearing a settings write's clothes.
    if (!isMountableRelPath(relPath) || relPath.endsWith('/')) {
      return j(400, {
        error: 'meetingsPath must be a repo-relative folder with no .. and no dot-directory',
      });
    }
    const at = mounts.locate(path);
    if (!at) return j(400, { error: 'not-a-repo', path });
    const current = mounts.meetingsOf(at.repoKey);
    const retention =
      body?.retention === undefined
        ? (current?.retention ?? 'transcripts-and-audio')
        : parseMeetingRetention(body.retention);
    if (retention === null) {
      return j(400, { error: `retention must be one of ${MEETING_RETENTIONS.join(', ')}` });
    }
    const gitignore =
      body?.gitignore === undefined ? (current?.gitignore ?? false) : body.gitignore === true;
    const folderAbs = join(at.checkoutRoot, relPath);
    /**
     * The folder is made and mounted BEFORE the choice is stored, and the
     * order is the whole correctness of this route.
     *
     * The folder is created here rather than at the first meeting because
     * mounting refuses a path that is not a directory, and a home with no
     * address would have the Library listing meetings it cannot open. But a
     * refused request must also leave the project exactly as it was: storing
     * first meant a 400 still moved every future meeting to a folder that
     * could not be written — a rejected settings call changing behaviour,
     * which is worse than the failure it was reporting.
     */
    try {
      mkdirSync(folderAbs, { recursive: true });
    } catch (err) {
      return j(400, { error: 'meetings folder could not be created', detail: String(err) });
    }
    const mounted = mounts.mount(folderAbs);
    if (!mounted.ok)
      return j(400, { error: 'meetings folder could not be mounted', mountError: mounted.error });
    const project = mounts.setMeetings(at.repoKey, { relPath, retention, gitignore });
    const gitignoreResult = applyMeetingGitignore(folderAbs, gitignore);
    return j(200, {
      ok: true,
      repoKey: project.repoKey,
      meetings: project.meetings,
      mountId: mounted.mount.mountId,
      gitignoreResult,
    });
  }

  if (pathname === '/api/mounts/meetings' && req.method === 'GET') {
    const path = url.searchParams.get('path');
    if (!path) return j(400, { error: 'path is required' });
    const at = mounts.locate(path);
    if (!at) return j(400, { error: 'not-a-repo', path });
    return j(200, { repoKey: at.repoKey, meetings: mounts.meetingsOf(at.repoKey) ?? null });
  }

  return j(405, { error: 'method not allowed' });
}

/**
 * A mounted file at its address.
 *
 * `GET /mounts/<fileId>` is the metadata and `…/raw` is the bytes. The bytes
 * are streamed with `Bun.file` rather than served through `serveStatic`,
 * which reads the whole file into memory — a mount holds the 23 GB run
 * directories this feature exists for, and one request for one of those would
 * take the server down.
 */
function serveMountedFile(ctx: MountRoutesContext, rq: MountRouteRequest): Response | undefined {
  const { mounts, j } = ctx;
  const { req, pathname, visitor } = rq;
  const rest = pathname.slice('/mounts/'.length);
  if (pathname === '/mounts' || rest === '') return j(404, { error: 'no file id in the address' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return j(405, { error: 'method not allowed' });
  }
  const [rawId, sub, ...extra] = rest.split('/');
  const fileId = decodeURIComponent(rawId ?? '');
  if (extra.length > 0 || (sub !== undefined && sub !== 'raw')) {
    return j(404, { error: 'not a mount address' });
  }

  // Belt to the admission layer's braces: `/mounts/…` is not on
  // `shareScopeAllows`, so a visitor is refused before reaching here. The
  // local refusal is what keeps that true if a prefix is ever widened.
  if (visitor) return j(403, { error: 'mounted files are not available to share visitors' });

  const found = mounts.resolveFile(fileId);
  if (!found) return j(404, { error: 'no mounted file at that address', fileId });

  // The project's own rule. `local-only` means the bytes do not leave the
  // machine, so it is answered against the socket and the edge header rather
  // than against who the caller is.
  if (mounts.privacyOf(found.repoKey) === 'local-only' && !isOnBox(ctx, req)) {
    return j(403, {
      error: 'this project is local-only — its mounted files are served on the box alone',
    });
  }

  if (sub !== 'raw') {
    return j(200, {
      fileId,
      mountId: found.file.mountId,
      relPath: found.file.relPath,
      name: basename(found.file.relPath),
      size: found.file.size,
      mtimeMs: found.file.mtimeMs,
      contentType: CT[extname(found.file.relPath).toLowerCase()] ?? 'application/octet-stream',
      rawUrl: `/mounts/${encodeURIComponent(fileId)}/raw`,
    });
  }

  const ext = extname(found.file.relPath).toLowerCase();
  const headers: Record<string, string> = {
    'content-type': CT[ext] ?? 'application/octet-stream',
    // An address serves whatever the file holds NOW — that is the point of an
    // in-place update — so the browser has to revalidate. The tag is size and
    // mtime rather than a content hash: hashing 23 GB per request is the
    // thing this route exists not to do.
    'cache-control': 'no-cache',
    etag: `"${found.file.size.toString(16)}-${Math.floor(found.file.mtimeMs).toString(16)}"`,
    'content-disposition': `${dispositionFor(ext)}; filename="${safeFilename(found.file.relPath)}"`,
    'x-content-type-options': 'nosniff',
  };
  if (req.method === 'HEAD') {
    headers['content-length'] = String(found.file.size);
    return new Response(null, { headers });
  }
  // Streamed, never read whole: the response must not be bounded by memory
  // when the file is one of the multi-gigabyte ones a mount exists to hold.
  return new Response(Bun.file(found.abs), { headers });
}

/**
 * Inline, or a download?
 *
 * A mounted file is served from the SERVER'S OWN ORIGIN, beside every session
 * cookie it holds — so anything the browser would execute as a document has
 * to arrive as an attachment. That is `.svg` (it carries script and renders
 * as a document), `.html` in every spelling, and everything unrecognised,
 * which is the case that matters most: a type nobody listed is a type nobody
 * reasoned about. What stays inline is the set a reviewer opens by clicking —
 * raster images, PDF, plain text and media.
 */
const INLINE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.txt',
  '.md',
  '.csv',
  '.mp3',
  '.m4a',
  '.wav',
  '.mp4',
  '.webm',
]);

function dispositionFor(ext: string): 'inline' | 'attachment' {
  return INLINE_EXTENSIONS.has(ext) ? 'inline' : 'attachment';
}

/** A filename safe to put inside a quoted header value. */
function safeFilename(relPath: string): string {
  return basename(relPath).replace(/[^A-Za-z0-9._-]/g, '_');
}
