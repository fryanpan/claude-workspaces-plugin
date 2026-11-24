import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mail } from '../../../templates/signin/src/mail.ts';
import { type LocalDatabase, localDatabase } from '../../../templates/signin/test/local-d1.ts';
import {
  type Stubs,
  TURNSTILE_FAIL_SECRET,
  startStubs,
} from '../../../templates/signin/test/stubs.ts';
import { type MailReader, googleStartProblem, resendMailReader, runSmoke } from '../smoke.ts';
import { type LiveEnv, createLiveApp } from '../src/live-app.ts';
import { SMOKE_HEADER, TURNSTILE_DUMMY_TOKEN, sameSecret } from '../src/smoke-gate.ts';

// The live app in node against a local workerd D1, with the template's stubs
// for Turnstile. The widget's own secret is the always-FAIL test secret, so a
// request only gets past Turnstile by the smoke gate's substitution.
const BASE = 'http://localhost:8797';
const SITE_KEY = '3x00000000000000000000FF';
const SMOKE_KEY = 'k'.repeat(48);
const CLIENT_ID = 'fixture-client-harborlight';

let db: LocalDatabase;
let stubs: Stubs;
let ipSeq = 0;
const mails: Mail[] = [];

beforeAll(async () => {
  db = await localDatabase({ applyMigrations: true });
  stubs = await startStubs();
}, 60_000);
afterAll(async () => {
  await stubs?.close();
  await db?.dispose();
});

function liveEnv(extra: Partial<LiveEnv> = {}): LiveEnv {
  return {
    DB: db.binding,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: crypto.randomUUID(),
    TURNSTILE_SITE_KEY: SITE_KEY,
    TURNSTILE_SECRET_KEY: TURNSTILE_FAIL_SECRET,
    SMOKE_KEY,
    ...extra,
  };
}

/** The app, one client IP per call site, and the mails it sent. */
function live(extra: Partial<LiveEnv> = {}) {
  const app = createLiveApp({
    mailer: () => ({ send: async (mail) => void mails.push(mail) }),
    turnstileVerifyUrl: `${stubs.origin}/turnstile/siteverify`,
  });
  const env = liveEnv(extra);
  const ip = `198.51.100.${++ipSeq}`;
  const fetchApp = (req: Request) => {
    const r = new Request(req, { headers: new Headers(req.headers) });
    r.headers.set('cf-connecting-ip', ip);
    return app.fetch(r, env);
  };
  return { fetchApp, env };
}

const capturedMail: MailReader = {
  async linkFor(to, subject) {
    return mails.filter((m) => m.to === to && m.subject === subject).at(-1)?.url ?? null;
  },
};

const post = (path: string, body: unknown, headers: Record<string, string>) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, ...headers },
    body: JSON.stringify(body),
  });

const smokeHeaders = (key = SMOKE_KEY) => ({
  [SMOKE_HEADER]: key,
  'x-captcha-response': TURNSTILE_DUMMY_TOKEN,
});

const signUp = (email: string) => ({ email, password: 'correct-horse-battery', name: 'Alice' });

describe('the smoke test, run against the live app', () => {
  it('passes every check end to end', async () => {
    const { fetchApp } = live();
    const result = await runSmoke(
      { origin: BASE, smokeKey: SMOKE_KEY, googleClientId: CLIENT_ID, label: 'harborlight' },
      { fetch: fetchApp, mail: capturedMail, sleep: async () => {}, mailWaitMs: 0 },
    );
    expect(result.lines).toEqual([
      'ok health',
      'ok smoke key accepted',
      'ok sign-in page',
      'ok Turnstile is enforced',
      'ok Google start redirect',
      'ok password sign-up, verification and sign-in',
      'ok magic link',
    ]);
    expect(result.ok).toBe(true);
  });

  // A secret PUT makes a new Worker version, and the edge keeps serving the
  // old one, which has no SMOKE_KEY, for a moment after the PUT returns. Here
  // the new version takes over once the smoke has waited twice.
  it('waits for the Worker to honour a SMOKE_KEY put a moment before', async () => {
    const before = live({ SMOKE_KEY: undefined });
    const after = live();
    let waits = 0;
    const result = await runSmoke(
      { origin: BASE, smokeKey: SMOKE_KEY, googleClientId: CLIENT_ID, label: 'saltmarsh-lag' },
      {
        fetch: (req) => (waits >= 2 ? after : before).fetchApp(req),
        mail: capturedMail,
        sleep: async () => void waits++,
        mailWaitMs: 0,
      },
    );
    expect(result.lines).toEqual([
      'ok health',
      'ok smoke key accepted',
      'ok sign-in page',
      'ok Turnstile is enforced',
      'ok Google start redirect',
      'ok password sign-up, verification and sign-in',
      'ok magic link',
    ]);
    expect(waits).toBe(2);
  });

  it('fails, naming the check, when its key is not the Worker’s', async () => {
    const { fetchApp } = live();
    const result = await runSmoke(
      { origin: BASE, smokeKey: 'w'.repeat(48), googleClientId: CLIENT_ID, label: 'riverbend' },
      { fetch: fetchApp, mail: capturedMail, sleep: async () => {}, mailWaitMs: 0 },
    );
    expect(result.ok).toBe(false);
    expect(result.lines).toContain(
      'FAIL smoke key accepted: Turnstile still refused the smoke key after 9 waits',
    );
    expect(result.lines).toContain(
      'FAIL password sign-up, verification and sign-in: sign-up: HTTP 403, wanted 200',
    );
    expect(result.lines.join('\n')).not.toContain('w'.repeat(48));
  });

  it('fails the Google check on a client id that is not the configured one', async () => {
    const { fetchApp } = live();
    const result = await runSmoke(
      { origin: BASE, smokeKey: SMOKE_KEY, googleClientId: 'another-client', label: 'saltmarsh' },
      { fetch: fetchApp, mail: capturedMail, sleep: async () => {}, mailWaitMs: 0 },
    );
    expect(result.lines).toContain(
      'FAIL Google start redirect: the client id is not the configured one',
    );
  });
});

describe('the smoke gate', () => {
  it('lets the smoke key past Turnstile for a Resend test address', async () => {
    const { fetchApp } = live();
    const res = await fetchApp(
      post('/api/auth/sign-up/email', signUp('delivered+a@resend.dev'), smokeHeaders()),
    );
    expect(res.status).toBe(200);
  });

  it('refuses a wrong key, another address, a missing or a short Worker key', async () => {
    const cases: [Partial<LiveEnv>, string, Record<string, string>][] = [
      [{}, 'delivered+b@resend.dev', smokeHeaders(`${SMOKE_KEY.slice(1)}x`)],
      [{}, 'alice@example.com', smokeHeaders()],
      [{}, 'delivered@resend.dev.example.com', smokeHeaders()],
      [{ SMOKE_KEY: undefined }, 'delivered+c@resend.dev', smokeHeaders()],
      [{ SMOKE_KEY: 'short' }, 'delivered+d@resend.dev', smokeHeaders('short')],
    ];
    for (const [extra, email, headers] of cases) {
      const { fetchApp } = live(extra);
      const res = await fetchApp(post('/api/auth/sign-up/email', signUp(email), headers));
      expect({ email, status: res.status }).toEqual({ email, status: 403 });
    }
  });

  it('does not open routes outside the three', async () => {
    const { fetchApp } = live();
    const res = await fetchApp(
      post('/api/auth/request-password-reset', { email: 'delivered+e@resend.dev' }, smokeHeaders()),
    );
    expect(res.status).toBe(403);
  });

  it('compares keys whole', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
  });
});

describe('the sign-in page', () => {
  it('carries the site key, escaped, and a content security policy', async () => {
    const { fetchApp } = live({ TURNSTILE_SITE_KEY: 'key"><script>' });
    const res = await fetchApp(new Request(`${BASE}/`));
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toContain(
      'frame-src https://challenges.cloudflare.com',
    );
    const html = await res.text();
    expect(html).toContain('data-sitekey="key&#34;&#62;&#60;script&#62;"');
    expect(html).not.toContain('key"><script>');
  });
});

describe('the Google start check', () => {
  const good = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(`${BASE}/api/auth/callback/google`)}`;
  it('accepts the right host, client and redirect URI', () => {
    expect(googleStartProblem(good, BASE, CLIENT_ID)).toBeNull();
  });
  it('names each wrong part', () => {
    expect(
      googleStartProblem(good.replace('accounts.google.com', 'example.com'), BASE, CLIENT_ID),
    ).toBe('the start URL goes to example.com, not accounts.google.com');
    expect(googleStartProblem(good.replace('callback', 'elsewhere'), BASE, CLIENT_ID)).toBe(
      `the redirect URI is not ${BASE}/api/auth/callback/google`,
    );
    expect(googleStartProblem('not a url', BASE, CLIENT_ID)).toBe('the start URL does not parse');
  });
});

describe("Resend's mail reader", () => {
  it('reads the link from the newest matching mail', async () => {
    const asked: string[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push(`${String(url)} ${new Headers(init?.headers).get('authorization')}`);
      const path = new URL(String(url)).pathname;
      if (path === '/emails') {
        return Response.json({
          data: [
            {
              id: 'old',
              to: ['bob@resend.dev'],
              subject: 'Verify your email',
              created_at: '2026-11-15 10:00:00',
            },
            {
              id: 'new',
              to: ['bob@resend.dev'],
              subject: 'Verify your email',
              created_at: '2026-11-15 10:05:00',
            },
            {
              id: 'other',
              to: ['alice@resend.dev'],
              subject: 'Verify your email',
              created_at: '2026-11-15 10:09:00',
            },
          ],
        });
      }
      if (path === '/emails/new')
        return Response.json({ text: 'Verify your email: https://app.test/v?t=2', html: null });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const reader = resendMailReader('re_fixture_riverbend', fetcher);
    expect(await reader.linkFor('bob@resend.dev', 'Verify your email')).toBe(
      'https://app.test/v?t=2',
    );
    expect(await reader.linkFor('saltmarsh@resend.dev', 'Verify your email')).toBeNull();
    expect(asked[0]).toBe('https://api.resend.com/emails?limit=100 Bearer re_fixture_riverbend');
  });
});
