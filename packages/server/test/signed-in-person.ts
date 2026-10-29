/**
 * A person signed in on the board's own page, for tests that answer a review
 * item as that person.
 *
 * Since `review-items/answer-proof.ts`, a person's answer is recorded only
 * when the request proves the person: here, the signed session cookie the
 * server's own sign-in would have set, sent same-origin as the board page
 * sends it. A body that only names a person is refused, which is the point.
 *
 * The cookie is signed with the data dir's own cookie key, so nothing here
 * bypasses the server's check; it skips only the emailed code.
 */
import type { User } from '@claude-workspaces/core';
import { SESSION_COOKIE, mintSession, sessionKey, signSession } from '../src/auth/session.ts';
import { userForIdentity } from '../src/identities.ts';
import type { ServerHandle } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';

export interface SignedInPerson {
  /** The author the server will record: the identity's own id and name. */
  user: User;
  /** The cookie and the same-origin marks the board page sends. */
  headers: Record<string, string>;
}

/**
 * Sign `email` in on the server at `base` whose data dir is `dataDir`.
 * `base` is the page's URL, or the bare `host:port` the test's requests send
 * as their Host header (the origin a page on that host would send).
 * `name` becomes the identity's display name, so a test that asserts the
 * answerer's name keeps asserting it.
 */
export function signedInPerson(
  handle: ServerHandle,
  dataDir: string,
  base: string,
  opts: { email?: string; name?: string } = {},
): SignedInPerson {
  const rec = handle.identities.upsertByEmail(opts.email ?? 'alice@harborlight.example', {
    ...(opts.name !== undefined ? { displayName: opts.name } : {}),
  });
  const value = signSession(mintSession(rec.id), sessionKey(loadCookieKey(dataDir)));
  return {
    user: userForIdentity(rec),
    headers: {
      cookie: `${SESSION_COOKIE}=${value}`,
      origin: new URL(base.includes('://') ? base : `http://${base}`).origin,
      'sec-fetch-site': 'same-origin',
    },
  };
}
