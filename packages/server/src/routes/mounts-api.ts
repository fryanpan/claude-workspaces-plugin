import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type MiddlewareHandler } from 'hono';
import {
  MEETING_RETENTIONS,
  applyMeetingGitignore,
  parseMeetingRetention,
} from '../meeting-home.ts';
import type { ProjectPrivacy } from '../mount-registry-file.ts';
import { isMountableRelPath } from '../mount-scan.ts';
import type { MountStore } from '../mount-store.ts';
import type { MountRoutesContext } from './mount-routes-context.ts';

/**
 * The mount table's REST routes, `/api/mounts…`, as a typed Hono app.
 *
 * WHY TYPED. The MCP child calls these routes through Hono's client
 * (`hc<MountsApi>`, `packages/mcp/src/server-client.ts`). The client reads the
 * request shapes declared here, so renaming a field on one side and not the
 * other fails `bun run typecheck` instead of failing at a session's first
 * call. Each route declares what a caller sends (`json` or `query`), and each
 * handler reads those fields BY NAME from the typed view, so the declaration
 * and the code that reads it cannot drift apart either.
 *
 * WHAT IS NOT HERE. The gate, `offBox` in `mounts.ts`, runs before this app
 * is reached, and so does the HEAD refusal: Hono would answer a HEAD by
 * running the GET handler, and this table has always answered HEAD with 405.
 * `/mounts/<fileId>` (`mount-file.ts`) is the file address, not the table,
 * and stays a plain handler. An address under `/api/mounts` that no route
 * here claims, or a method none takes, answers 405 as it always did.
 *
 * Every body is the object the hand-written chain built, field for field, so
 * the route-answer snapshot is unchanged.
 */

/** What a handler sees of a field a caller sent: present or not, unchecked. */
type Sent<T> = { [K in keyof T]?: unknown };

/**
 * The request body, read the way the chain read it — malformed JSON is an
 * empty body, refused field by field below rather than with a parse error —
 * and declared as `T` so the typed client must send `T`.
 */
function jsonBody<T>(
  ctx: MountRoutesContext,
): MiddlewareHandler<Record<string, never>, string, { in: { json: T }; out: { json: Sent<T> } }> {
  return async (c, next) => {
    c.req.addValidatedData('json', (await ctx.safeJson(c.req.raw)) ?? {});
    await next();
  };
}

/** The query string, declared as `Q`, read as the strings that were present. */
function queryOf<Q extends Record<string, string>>(): MiddlewareHandler<
  Record<string, never>,
  string,
  { in: { query: Q }; out: { query: Partial<Q> } }
> {
  return async (c, next) => {
    const params = new URL(c.req.url).searchParams;
    const present: Record<string, string> = {};
    for (const [key, value] of params) if (!(key in present)) present[key] = value;
    c.req.addValidatedData('query', present);
    await next();
  };
}

/**
 * Validate a caller-supplied host path.
 *
 * A string, absolute, and free of NUL. Whether it is inside a repo, and
 * whether it is a directory, are the store's answers rather than this one's:
 * both need the filesystem.
 */
function readPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.trim();
  if (path === '' || !path.startsWith('/') || path.includes('\u0000')) return null;
  return path;
}

const PRIVACY_ERROR = "privacy must be 'workspace' or 'local-only'";

/**
 * A caller-supplied privacy value: the value, `null` when the field is absent,
 * or `'bad'` when it is present and is neither of the two.
 *
 * Absent and wrong are kept apart so that `POST /api/mounts` can treat "no
 * opinion" as today's behaviour while still refusing a typo. Guessing
 * `workspace` from an unrecognised string is the one wrong direction — the
 * only reason to write in this field at all is to restrict.
 */
function readPrivacy(raw: unknown): ProjectPrivacy | null | 'bad' {
  if (raw === undefined) return null;
  if (raw === 'workspace' || raw === 'local-only') return raw;
  return 'bad';
}

/** The table, read whole: one walk per project, its mounts and their counts. */
function tableOf(mounts: MountStore, only: string | undefined) {
  const projects = mounts.registry.listProjects().filter((p) => !only || p.repoKey === only);
  return projects.map((p) => {
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
        // Both, because they answer different questions: `privacy` is
        // what this mount was set to (absent when nobody set it), and
        // `effectivePrivacy` is what it is actually served against once
        // the project's answer is folded in.
        privacy: m.privacy,
        effectivePrivacy: mounts.mountPrivacyOf(p.repoKey, m.mountId),
        fileCount:
          m.removedAt === undefined
            ? listing.files.filter((f) => f.mountId === m.mountId).length
            : 0,
      })),
    };
  });
}

/** The mount table's routes. Built once per server (`mounts.ts`). */
export function mountsApi(ctx: MountRoutesContext) {
  const { mounts } = ctx;
  return (
    new Hono()
      // --- The table, read whole ---
      .get('/api/mounts', queryOf<{ path?: string }>(), (c) => {
        const { path } = c.req.valid('query');
        const only = path ? mounts.locate(path)?.repoKey : undefined;
        if (path && !only) return c.json({ error: 'not-a-repo', path }, 400);
        return c.json({ projects: tableOf(mounts, only) }, 200);
      })

      // --- One mount's files, paged ---
      .get(
        '/api/mounts/files',
        queryOf<{ path: string; mountId?: string; after?: string; limit?: string }>(),
        (c) => {
          const q = c.req.valid('query');
          if (!q.path) return c.json({ error: 'path is required' }, 400);
          const at = mounts.locate(q.path);
          if (!at) return c.json({ error: 'not-a-repo', path: q.path }, 400);
          const limitRaw = Number(q.limit ?? '200');
          const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
          const opts: Parameters<MountStore['listFiles']>[1] = { limit };
          if (q.mountId !== undefined) opts.mountId = q.mountId;
          if (q.after !== undefined) opts.after = q.after;
          const res = mounts.listFiles(at.repoKey, opts);
          return c.json({ repoKey: at.repoKey, ...res }, 200);
        },
      )

      // --- Mount a folder ---
      .post('/api/mounts', jsonBody<{ path: string; privacy?: string }>(ctx), (c) => {
        const body = c.req.valid('json');
        const path = readPath(body.path);
        if (!path) {
          return c.json({ error: 'path must be an absolute filesystem path to a folder' }, 400);
        }
        // Read BEFORE the mount, so a bad value refuses the whole call rather
        // than leaving a folder mounted at the project's setting while the caller
        // was told it failed — a mount is exactly the moment a narrower answer is
        // known, and half of it landing is the wrong half.
        const wanted = readPrivacy(body.privacy);
        if (wanted === 'bad') return c.json({ error: PRIVACY_ERROR }, 400);
        const res = mounts.mount(path);
        if (!res.ok) {
          return c.json(
            {
              error: res.error,
              hint:
                res.error === 'not-a-repo'
                  ? 'a mount is a folder inside a git checkout — the repo is what gives its files a durable address'
                  : res.error === 'refused-path'
                    ? 'dot-directories are never mounted: every file under one is refused at serve time, so the mount would hold nothing'
                    : 'that path is not a directory',
            },
            400,
          );
        }
        if (wanted !== null) {
          mounts.setMountPrivacy(res.project.repoKey, res.mount.mountId, wanted);
        }
        const listing = mounts.reconcile(res.project.repoKey, true);
        return c.json(
          {
            ok: true,
            mountId: res.mount.mountId,
            repoKey: res.project.repoKey,
            relPath: res.mount.relPath,
            created: res.created,
            privacy: mounts.privacyOf(res.project.repoKey),
            mountPrivacy: mounts.mountPrivacyOf(res.project.repoKey, res.mount.mountId),
            fileCount: listing.files.filter((f) => f.mountId === res.mount.mountId).length,
            // A capped walk is said out loud: the count is a floor, not a total.
            truncated: listing.truncated,
          },
          200,
        );
      })

      // --- Retire a mount ---
      //
      // Soft, and it is the only removal there is. Nothing under the folder is
      // touched, no address is dropped, and re-mounting the same folder revives
      // the same row: retention is the project's, and workspaces deletes nothing
      // it did not create.
      .delete('/api/mounts', jsonBody<{ path: string; mountId: string }>(ctx), (c) => {
        const body = c.req.valid('json');
        const path = readPath(body.path);
        const mountId = typeof body.mountId === 'string' ? body.mountId : null;
        if (!path || !mountId) {
          return c.json({ error: 'path (absolute) and mountId are both required' }, 400);
        }
        const at = mounts.locate(path);
        if (!at) return c.json({ error: 'not-a-repo', path }, 400);
        if (!mounts.unmount(at.repoKey, mountId)) {
          return c.json({ error: 'no-such-mount', mountId }, 404);
        }
        return c.json({ ok: true, repoKey: at.repoKey, mountId, filesLeftOnDisk: true }, 200);
      })

      // --- Privacy: the whole project, or one of its mounts ---
      //
      // One route for both, because it is one decision asked at two scopes, and a
      // second route would be a second place for the combining rule to be got
      // wrong. Naming a `mountId` is what says which scope was meant.
      .put(
        '/api/mounts/privacy',
        jsonBody<{ path: string; privacy: string; mountId?: string }>(ctx),
        (c) => {
          const body = c.req.valid('json');
          const path = readPath(body.path);
          const privacy = readPrivacy(body.privacy);
          const mountId = body.mountId;
          if (!path) return c.json({ error: 'path must be an absolute filesystem path' }, 400);
          if (privacy === null || privacy === 'bad') return c.json({ error: PRIVACY_ERROR }, 400);
          if (mountId !== undefined && typeof mountId !== 'string') {
            return c.json({ error: 'mountId must be a string' }, 400);
          }
          const at = mounts.locate(path);
          if (!at) return c.json({ error: 'not-a-repo', path }, 400);
          if (typeof mountId === 'string') {
            const mount = mounts.setMountPrivacy(at.repoKey, mountId, privacy);
            if (!mount) return c.json({ error: 'no-such-mount', mountId }, 404);
            return c.json(
              {
                ok: true,
                repoKey: at.repoKey,
                mountId: mount.mountId,
                privacy: mount.privacy,
                // What it is actually served against — which is the project's
                // answer when that one is narrower, and saying so is the
                // difference between a caller believing it opened a folder and
                // knowing it did not.
                effectivePrivacy: mounts.mountPrivacyOf(at.repoKey, mount.mountId),
              },
              200,
            );
          }
          const project = mounts.setPrivacy(at.repoKey, privacy);
          return c.json({ ok: true, repoKey: project.repoKey, privacy: project.privacy }, 200);
        },
      )

      // --- The conventions index ---
      .get('/api/mounts/conventions', queryOf<{ path: string }>(), (c) => {
        const { path } = c.req.valid('query');
        if (!path) return c.json({ error: 'path is required' }, 400);
        const at = mounts.locate(path);
        if (!at) return c.json({ error: 'not-a-repo', path }, 400);
        const found = mounts.conventions(at.repoKey);
        return c.json({ repoKey: at.repoKey, ...found }, 200);
      })
      .put(
        '/api/mounts/conventions',
        jsonBody<{ path: string; conventionsPath: string }>(ctx),
        (c) => {
          const body = c.req.valid('json');
          const path = readPath(body.path);
          const relPath =
            typeof body.conventionsPath === 'string' ? body.conventionsPath.trim() : '';
          if (!path) return c.json({ error: 'path must be an absolute filesystem path' }, 400);
          // The same shape a mount takes: repo-relative, no escape, no dotdir.
          // It is read back to the caller, so a `..` here would be an arbitrary
          // file read wearing a settings write's clothes.
          if (!isMountableRelPath(relPath) || relPath.endsWith('/')) {
            return c.json(
              {
                error:
                  'conventionsPath must be a repo-relative file path with no .. and no dot-directory',
              },
              400,
            );
          }
          const at = mounts.locate(path);
          if (!at) return c.json({ error: 'not-a-repo', path }, 400);
          const project = mounts.setConventionsPath(at.repoKey, relPath);
          return c.json(
            { ok: true, repoKey: project.repoKey, conventionsPath: project.conventionsPath },
            200,
          );
        },
      )

      // --- Where this project's meetings file, and what it keeps ---
      //
      // One PUT for all three, because they are one decision: a project saying
      // "meetings go in docs/meetings, keep the words, keep them out of git" is
      // answering a single question, and three routes would let a caller land
      // half of it. `retention` and `gitignore` are optional only so a caller
      // moving the folder need not restate a choice it already made.
      .put(
        '/api/mounts/meetings',
        jsonBody<{
          path: string;
          meetingsPath: string;
          retention?: string;
          gitignore?: boolean;
        }>(ctx),
        (c) => {
          const body = c.req.valid('json');
          const path = readPath(body.path);
          const relPath = typeof body.meetingsPath === 'string' ? body.meetingsPath.trim() : '';
          if (!path) return c.json({ error: 'path must be an absolute filesystem path' }, 400);
          // The shape a mount takes, and for the same reason: this becomes a
          // directory this server WRITES into, so a `..` here is an arbitrary
          // write wearing a settings write's clothes.
          if (!isMountableRelPath(relPath) || relPath.endsWith('/')) {
            return c.json(
              {
                error:
                  'meetingsPath must be a repo-relative folder with no .. and no dot-directory',
              },
              400,
            );
          }
          const at = mounts.locate(path);
          if (!at) return c.json({ error: 'not-a-repo', path }, 400);
          const current = mounts.meetingsOf(at.repoKey);
          const retention =
            body.retention === undefined
              ? (current?.retention ?? 'transcripts-and-audio')
              : parseMeetingRetention(body.retention);
          if (retention === null) {
            return c.json(
              { error: `retention must be one of ${MEETING_RETENTIONS.join(', ')}` },
              400,
            );
          }
          const gitignore =
            body.gitignore === undefined ? (current?.gitignore ?? false) : body.gitignore === true;
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
          if (mounts.refuses(folderAbs)) {
            return c.json(
              { error: 'meetings folder could not be mounted', mountError: 'refused-path' },
              400,
            );
          }
          try {
            mkdirSync(folderAbs, { recursive: true });
          } catch (err) {
            return c.json(
              { error: 'meetings folder could not be created', detail: String(err) },
              400,
            );
          }
          const mounted = mounts.mount(folderAbs);
          if (!mounted.ok) {
            return c.json(
              { error: 'meetings folder could not be mounted', mountError: mounted.error },
              400,
            );
          }
          const project = mounts.setMeetings(at.repoKey, { relPath, retention, gitignore });
          const gitignoreResult = applyMeetingGitignore(folderAbs, gitignore);
          return c.json(
            {
              ok: true,
              repoKey: project.repoKey,
              meetings: project.meetings,
              mountId: mounted.mount.mountId,
              gitignoreResult,
            },
            200,
          );
        },
      )
      .get('/api/mounts/meetings', queryOf<{ path: string }>(), (c) => {
        const { path } = c.req.valid('query');
        if (!path) return c.json({ error: 'path is required' }, 400);
        const at = mounts.locate(path);
        if (!at) return c.json({ error: 'not-a-repo', path }, 400);
        return c.json(
          { repoKey: at.repoKey, meetings: mounts.meetingsOf(at.repoKey) ?? null },
          200,
        );
      })

      // An address under the table no route claims, or a method none takes.
      .notFound((c) => c.json({ error: 'method not allowed' }, 405))
      .onError((err) => {
        throw err;
      })
  );
}

/** The mount table's routes, as the typed client reads them. */
export type MountsApi = ReturnType<typeof mountsApi>;
