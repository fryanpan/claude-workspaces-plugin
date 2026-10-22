/**
 * Where the durable record lives — the `.ydoc` corpus, `activity.jsonl`,
 * `deploy-log.json`, `server-starts.json`, and the sidecars beside them.
 *
 * ## Why this is not simply `join(repoRoot, 'data')`
 *
 * It was, and only that, until 2026-09-01. The default put the one thing this
 * project promises never to destroy INSIDE the checkout that the deploy
 * fast-forwards: `runDeploy` runs `git merge --ff-only` in the same directory
 * that holds every doc anyone has ever written. `data/` is gitignored, so the
 * two coexisted — but the coupling meant re-cloning prod, or moving it, moved
 * the corpus by hand or lost it, and nothing in the launcher could say
 * otherwise because `scripts/serve.ts` never passed `--data-dir` at all.
 *
 * ## Why there is no default now
 *
 * After that the default was `<repoRoot>/data`, and a start that named no
 * data dir served whatever was there. So a wrong start (a missing plist key,
 * a supervisor started from the wrong checkout) served the wrong corpus and
 * wrote into it, and nothing said so. Every start now names its data dir —
 * prod's plist sets `CW_DATA_DIR`, `scripts/staging.ts` and `bun run dev`
 * pass `--data-dir` — and a start that names none refuses to run.
 *
 * ## Precedence
 *
 * An explicit `--data-dir` on the command line beats `CW_DATA_DIR` — that is
 * `bin.ts`'s own `arg()` fallback chain, and `scripts/staging.ts` depends on it
 * to keep a throwaway data dir off prod's.
 */

/** The env var prod sets to move the corpus off the checkout. */
export const DATA_DIR_ENV = 'CW_DATA_DIR';

/** What a start that names no data dir prints before it exits. */
export const MISSING_DATA_DIR =
  `no data dir: pass --data-dir <path> or set ${DATA_DIR_ENV}. ` +
  'The server has no default, so that a wrong start cannot serve the wrong data.';

/**
 * The data dir `CW_DATA_DIR` names, or `null` when it names none.
 *
 * Blank and whitespace-only are treated as unset rather than as a request for
 * the filesystem root: a plist key someone emptied out must refuse the start,
 * not resolve to `/`.
 */
export function resolveDataDir(env: Record<string, string | undefined>): string | null {
  return env[DATA_DIR_ENV]?.trim() || null;
}

/**
 * The data dir a server started with `argv` will use: `--data-dir` beats the
 * resolver, and `null` means neither named one. One copy, because `bin.ts`
 * needs it before the rest of the config resolves — to record its own start
 * first — and a second spelling of this precedence is how two readers end up
 * in different directories.
 */
export function dataDirFromArgs(
  env: Record<string, string | undefined>,
  arg: (name: string) => string | undefined,
): string | null {
  return arg('data-dir')?.trim() || resolveDataDir(env);
}
