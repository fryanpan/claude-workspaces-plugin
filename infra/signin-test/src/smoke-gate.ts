/**
 * The one way past Turnstile, for the deploy's smoke test alone.
 *
 * A live widget cannot be solved by a script, so a request that carries the
 * Worker's `SMOKE_KEY` in `x-smoke-key` is checked against Cloudflare's
 * published always-pass test secret instead of the widget's own. It is
 * narrow on purpose:
 *
 * - `SMOKE_KEY` exists only while a deploy's smoke runs: deploy.ts sets a
 *   fresh random one, runs the smoke, and deletes it, failure or not.
 * - Only sign-up, password sign-in and magic-link requests qualify, and only
 *   for an address at Resend's test domain, which delivers nowhere.
 * - Everything else is unchanged: the rate limits still count, and the
 *   address still has to be verified before a password signs it in.
 */

export const SMOKE_HEADER = 'x-smoke-key';
/** Cloudflare's documented always-pass Turnstile test secret. Not a credential. */
export const TURNSTILE_TEST_PASS_SECRET = '1x0000000000000000000000000000000AA';
/** The token Turnstile's test keys accept. */
export const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
/** Resend's test inbox domain: mail sent there is accepted and delivered nowhere. */
export const SMOKE_EMAIL_DOMAIN = 'resend.dev';
/** A key shorter than this is ignored, so an empty or truncated secret opens nothing. */
export const MIN_SMOKE_KEY_LENGTH = 32;

const SMOKE_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/sign-up/email',
  '/api/auth/sign-in/email',
  '/api/auth/sign-in/magic-link',
]);

/** Equal strings, compared without stopping at the first difference. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Whether `req` is the smoke test's, under the rules above. Reads a clone of the body. */
export async function isSmokeRequest(req: Request, smokeKey: string | undefined): Promise<boolean> {
  if (!smokeKey || smokeKey.length < MIN_SMOKE_KEY_LENGTH) return false;
  if (req.method !== 'POST') return false;
  if (!SMOKE_PATHS.has(new URL(req.url).pathname)) return false;
  const given = req.headers.get(SMOKE_HEADER);
  if (!given || !sameSecret(given, smokeKey)) return false;
  const body = (await req
    .clone()
    .json()
    .catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const at = email.lastIndexOf('@');
  return at > 0 && email.slice(at + 1) === SMOKE_EMAIL_DOMAIN;
}
