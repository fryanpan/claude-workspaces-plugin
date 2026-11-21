/**
 * One Sentry event from a script, without the SDK: the store check runs once
 * a day under launchd and raises at most a few warnings, so it posts a
 * single envelope per event to the DSN's project.
 *
 * The DSN's public key goes in the auth header and nowhere else; nothing
 * here prints it.
 */
import { randomUUID } from 'node:crypto';

export interface SentryEvent {
  level: 'warning' | 'error';
  message: string;
  /** Grouping: one issue per fingerprint. */
  fingerprint: string[];
  tags: Record<string, string>;
  extra?: Record<string, number | string>;
}

export function parseDsn(dsn: string): { envelopeUrl: string; publicKey: string } {
  const u = new URL(dsn);
  const project = u.pathname.replace(/^\//, '').replace(/\/$/, '');
  if (!u.username || !/^\d+$/.test(project)) throw new Error('the Sentry DSN is not well-formed');
  return {
    envelopeUrl: `${u.protocol}//${u.host}/api/${project}/envelope/`,
    publicKey: u.username,
  };
}

/** Posts one event; resolves to the HTTP status. */
export async function raiseToSentry(
  dsn: string,
  event: SentryEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const { envelopeUrl, publicKey } = parseDsn(dsn);
  const eventId = randomUUID().replaceAll('-', '');
  const body = [
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify({
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: 'javascript',
      logger: 'store-check',
      level: event.level,
      message: { formatted: event.message },
      fingerprint: event.fingerprint,
      tags: event.tags,
      extra: event.extra ?? {},
    }),
  ].join('\n');
  const res = await fetchImpl(envelopeUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-sentry-envelope',
      'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=cw-store-check/1`,
    },
    body,
  });
  return res.status;
}
