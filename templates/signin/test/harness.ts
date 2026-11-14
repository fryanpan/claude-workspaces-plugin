import { createApp } from '../src/app.ts';
import type { Env } from '../src/env.ts';
import type { Mail, MailKind } from '../src/mail.ts';
import { type LocalDatabase, localDatabase } from './local-d1.ts';
import { type Stubs, TURNSTILE_DUMMY_TOKEN, TURNSTILE_PASS_SECRET, startStubs } from './stubs.ts';

export const BASE = 'http://localhost:8797';
export const PASSWORD = 'correct-horse-battery';

export interface Harness {
  app: ReturnType<typeof createApp>;
  env: Env;
  stubs: Stubs;
  mails: Mail[];
  clock: { now: number; advance(ms: number): void };
  client(opts?: { ip?: string }): Client;
  /** The newest mail of `kind` sent to `to`; throws if none. */
  mailTo(kind: MailKind, to: string): Mail;
  dispose(): Promise<void>;
}

let ipSeq = 0;

export async function startHarness(opts: { turnstileSecret?: string } = {}): Promise<Harness> {
  const db: LocalDatabase = await localDatabase({ applyMigrations: true });
  const stubs = await startStubs();
  const mails: Mail[] = [];
  const clock = {
    now: Date.UTC(2026, 10, 13, 9, 0, 0),
    advance(ms: number) {
      clock.now += ms;
    },
  };
  const env: Env = {
    DB: db.binding,
    BETTER_AUTH_URL: BASE,
    // Generated per run; nothing secret is written down.
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    GOOGLE_CLIENT_ID: 'local-stub-client',
    GOOGLE_CLIENT_SECRET: crypto.randomUUID(),
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: opts.turnstileSecret ?? TURNSTILE_PASS_SECRET,
  };
  const app = createApp({
    mailer: () => ({ send: async (mail) => void mails.push(mail) }),
    now: () => clock.now,
    googleEndpoints: {
      authorizationUrl: `${stubs.origin}/google/authorize`,
      tokenUrl: `${stubs.origin}/google/token`,
      userInfoUrl: `${stubs.origin}/google/userinfo`,
    },
    turnstileVerifyUrl: `${stubs.origin}/turnstile/siteverify`,
  });
  const fetchApp = (req: Request) => app.fetch(req, env) as Promise<Response>;
  return {
    app,
    env,
    stubs,
    mails,
    clock,
    client: (o = {}) => new Client(fetchApp, o.ip ?? `203.0.113.${++ipSeq % 250}`),
    mailTo(kind, to) {
      const mail = mails.filter((m) => m.kind === kind && m.to === to).at(-1);
      if (!mail) throw new Error(`no ${kind} mail to ${to}`);
      return mail;
    },
    async dispose() {
      await stubs.close();
      await db.dispose();
    },
  };
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send the Turnstile token header (default true). */
  turnstile?: boolean;
}

/** A browser stand-in: one cookie jar, one client IP. */
export class Client {
  readonly cookies = new Map<string, string>();

  constructor(
    private readonly fetchApp: (req: Request) => Promise<Response>,
    readonly ip: string,
  ) {}

  async call(path: string, opts: CallOptions = {}): Promise<Response> {
    const headers = new Headers(opts.headers);
    headers.set('origin', BASE);
    headers.set('cf-connecting-ip', this.ip);
    if (opts.turnstile !== false) headers.set('x-captcha-response', TURNSTILE_DUMMY_TOKEN);
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(opts.body);
    }
    const method = opts.method ?? (body === undefined ? 'GET' : 'POST');
    const res = await this.fetchApp(
      new Request(new URL(path, BASE), { method, headers, body, redirect: 'manual' }),
    );
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  post(path: string, body: unknown, opts: Omit<CallOptions, 'body'> = {}): Promise<Response> {
    return this.call(path, { ...opts, body, method: 'POST' });
  }

  /** The signed-in user's id, or null. */
  async userId(): Promise<string | null> {
    const res = await this.call('/api/auth/get-session');
    const session = (await res.json()) as { user?: { id: string } } | null;
    return session?.user?.id ?? null;
  }
}

/** Signs up by password and follows the verification link, leaving no session. */
export async function signUpVerified(h: Harness, email: string, name: string): Promise<string> {
  const c = h.client();
  const res = await c.post('/api/auth/sign-up/email', { email, password: PASSWORD, name });
  if (res.status !== 200) throw new Error(`sign-up ${res.status}: ${await res.text()}`);
  const verify = await c.call(h.mailTo('verify-email', email).url);
  if (verify.status >= 400) throw new Error(`verify ${verify.status}`);
  const { user } = (await res.clone().json()) as { user: { id: string } };
  return user.id;
}

/** A client signed in by password. */
export async function signedIn(h: Harness, email: string): Promise<Client> {
  const c = h.client();
  const res = await c.post('/api/auth/sign-in/email', { email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`sign-in ${res.status}: ${await res.text()}`);
  return c;
}
