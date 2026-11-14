import type { D1Database } from '@cloudflare/workers-types';

export interface RateRule {
  name: string;
  max: number;
  windowMs: number;
}

/** 3 attempts per email address per route per 15 minutes. */
export const EMAIL_RULE: RateRule = { name: 'email', max: 3, windowMs: 15 * 60_000 };
/** 20 auth requests per client IP per minute. */
export const IP_RULE: RateRule = { name: 'ip', max: 20, windowMs: 60_000 };

/** Rows older than the longest window can never count again. */
const LONGEST_WINDOW_MS = Math.max(EMAIL_RULE.windowMs, IP_RULE.windowMs);

export interface RateVerdict {
  allowed: boolean;
  /** Seconds until the oldest counted attempt leaves the window. */
  retryAfterSeconds: number;
}

/**
 * Records one attempt against `rule` for `subject`, unless the subject has
 * already used its allowance inside the sliding window.
 *
 * D1 has no interactive transaction, so the check and the write cannot be a
 * read followed by an insert: two requests could both read "2" and both
 * insert. Instead the insert carries its own condition, which SQLite
 * evaluates inside the single statement, and the batch (which D1 runs as one
 * transaction) sweeps expired rows in the same round trip. A refused attempt
 * writes nothing, so hammering a locked key does not extend the lockout.
 */
export async function takeRateSlot(
  db: D1Database,
  rule: RateRule,
  subject: string,
  now: number,
): Promise<RateVerdict> {
  const key = `${rule.name}:${subject}`;
  const since = now - rule.windowMs;
  const [, inserted, oldest] = await db.batch([
    db.prepare('DELETE FROM rate_limit_hit WHERE at <= ?1').bind(now - LONGEST_WINDOW_MS),
    db
      .prepare(
        `INSERT INTO rate_limit_hit (key, at)
         SELECT ?1, ?2
         WHERE (SELECT COUNT(*) FROM rate_limit_hit WHERE key = ?1 AND at > ?3) < ?4`,
      )
      .bind(key, now, since, rule.max),
    db
      .prepare('SELECT MIN(at) AS at FROM rate_limit_hit WHERE key = ?1 AND at > ?2')
      .bind(key, since),
  ]);
  const allowed = (inserted?.meta.changes ?? 0) === 1;
  const oldestAt = (oldest?.results[0] as { at: number | null } | undefined)?.at ?? now;
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(1, Math.ceil((oldestAt + rule.windowMs - now) / 1000));
  return { allowed, retryAfterSeconds };
}

/** Routes whose body names an email address that the email rule counts. */
export const EMAIL_LIMITED_PATHS: ReadonlySet<string> = new Set([
  '/sign-up/email',
  '/sign-in/email',
  '/sign-in/magic-link',
  '/request-password-reset',
]);

export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= 254 ? email : null;
}
