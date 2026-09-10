/**
 * WHICH Sentry projects this deployment raises into, by slug — the one thing
 * neither `sentry.ts` nor `browser-sentry.ts` can answer.
 *
 * An alarm reaching Sentry is only half of it. Whether a human is ever told
 * depends on a session holding a `sentry_watch_project` subscription, and
 * that subscription is keyed on the claude-hive stable id —
 * `sha256(<the session's LAUNCH path>)` truncated to 12 hex. A session
 * launched from a path nobody has ever subscribed under holds nothing, so it
 * raises `SlowLoadAlarm` into Sentry and tells no one. That is the exact
 * failure the alarm was built to end, and it opens silently: the attach
 * succeeds, the board looks ordinary, and the gap is only visible to
 * somebody who thinks to run `sentry_list_my_watches`.
 *
 * So the server says the slugs out loud, on `attach_agent` — the one call
 * every session already makes at session start. Nobody has to remember.
 *
 * WHY NAMED CONFIGURATION AND NOT DERIVED. A DSN carries the numeric project
 * id and nothing else (`sentryProjectOf`, sentry.ts, returns something like
 * `4512052292157440`). Turning an id into a slug needs the Sentry API and a
 * token this process does not have and should not want. So the slugs are
 * written down. They are not secret — they are the same strings that appear
 * in a Sentry URL — which is why they live in the repo rather than in prod's
 * launchd plist: a default that only works after somebody edits a plist is a
 * default that does not work.
 *
 * `CW_SENTRY_PROJECTS` overrides them for a deployment that raises somewhere
 * else. It is read leniently on purpose: this value rides a response that
 * matters for other reasons, and a typo in an override must not be able to
 * take an attach down. A malformed override degrades to the committed
 * default, which is the answer that is right for every box we run.
 */

/** Which half of the product raises into a project. The browser and the
 *  server process report to separate projects — Sentry's own convention, and
 *  the reason there are two slugs rather than one. */
export type SentryProjectSide = 'server' | 'browser';

export interface SentryProjectRef {
  /** The project's slug as Sentry spells it — what `sentry_watch_project` takes. */
  slug: string;
  raises: SentryProjectSide;
}

export interface SentryWatchPlan {
  projects: SentryProjectRef[];
  /** What the reader is supposed to DO about the list, in words, because a
   *  bare array of slugs has been read as trivia before. Names the call and
   *  the check, so acting on it needs nothing else. */
  remedy: string;
}

/**
 * The projects this board raises into. Both slugs are also written down in
 * `.claude/rules/workspaces-local.md`; this is the copy the running server
 * hands out.
 */
export const DEFAULT_SENTRY_PROJECTS: readonly SentryProjectRef[] = [
  { slug: 'workspaces-server', raises: 'server' },
  { slug: 'claude-workspaces', raises: 'browser' },
];

const REMEDY =
  'Alarms raised into these projects reach a session only if that session holds the ' +
  'subscription, and it is keyed on your launch path — a session started somewhere new ' +
  'holds nothing and is told nothing. Call sentry_watch_project on each slug now; it is ' +
  'idempotent, so it costs nothing when you already hold it. Check with ' +
  'sentry_list_my_watches.';

/** A slug is one Sentry project path segment. Anything else is somebody's
 *  typo, a URL pasted whole, or a value from a shape we do not understand. */
const SLUG_SHAPE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

function parseEntry(raw: string): SentryProjectRef | null {
  // `slug` or `slug:side`. A bare slug is the common case and must stay
  // writable without knowing the vocabulary; the side is what lets a
  // reader tell a browser project from a server one.
  // codex review: `slug:side` and nothing further. Destructuring the split
  // dropped a third segment on the floor, so `project:browser:typo` parsed
  // clean — an unreadable override that took effect instead of falling back,
  // which is the one thing the all-or-nothing rule below exists to prevent.
  const parts = raw.split(':');
  if (parts.length > 2) return null;
  const [slugPart, sidePart] = parts;
  const slug = slugPart?.trim() ?? '';
  if (!SLUG_SHAPE.test(slug)) return null;
  const side = sidePart?.trim().toLowerCase();
  if (side !== undefined && side !== '' && side !== 'server' && side !== 'browser') return null;
  return { slug, raises: side === 'browser' ? 'browser' : 'server' };
}

/**
 * Resolve the plan. `env` is a parameter rather than a read of `process.env`
 * so a test can drive both branches without mutating the process it runs in.
 */
export function sentryWatchPlan(
  env: Record<string, string | undefined> = process.env,
): SentryWatchPlan {
  const raw = env.CW_SENTRY_PROJECTS?.trim();
  if (raw === undefined || raw === '') {
    return { projects: [...DEFAULT_SENTRY_PROJECTS], remedy: REMEDY };
  }
  const parsed = raw
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .map(parseEntry);
  // All-or-nothing: a list where one entry is unreadable is a list whose
  // author's intent is unknown, and silently subscribing to the half that
  // parsed is worse than subscribing to the default. Falling back keeps the
  // response useful either way.
  if (parsed.length === 0 || parsed.some((p) => p === null)) {
    return { projects: [...DEFAULT_SENTRY_PROJECTS], remedy: REMEDY };
  }
  return { projects: parsed as SentryProjectRef[], remedy: REMEDY };
}
