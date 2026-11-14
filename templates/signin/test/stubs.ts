import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Cloudflare's published Turnstile test secrets. They are not credentials:
 * Cloudflare documents them for exactly this use. The stub below answers the
 * way siteverify answers for each, so no request leaves the machine.
 */
export const TURNSTILE_PASS_SECRET = '1x0000000000000000000000000000000AA';
export const TURNSTILE_FAIL_SECRET = '2x0000000000000000000000000000000AA';
/** The token Turnstile's test site keys hand the page. */
export const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

export interface Stubs {
  origin: string;
  /** Registers the profile Google will return for the next callback. */
  issueGoogleCode(profile: GoogleProfile): string;
  turnstileCalls: number;
  close(): Promise<void>;
}

/** One local HTTP server standing in for Google's OAuth endpoints and Turnstile. */
export async function startStubs(): Promise<Stubs> {
  const codes = new Map<string, GoogleProfile>();
  const tokens = new Map<string, GoogleProfile>();
  let next = 0;
  const stubs = {
    origin: '',
    turnstileCalls: 0,
    issueGoogleCode(profile: GoogleProfile) {
      const code = `code-${++next}`;
      codes.set(code, profile);
      return code;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const body = await readBody(req);
    if (url.pathname === '/turnstile/siteverify') {
      stubs.turnstileCalls++;
      const { secret, response } = JSON.parse(body || '{}') as Record<string, string>;
      const ok = secret === TURNSTILE_PASS_SECRET && response === TURNSTILE_DUMMY_TOKEN;
      return json(
        res,
        ok
          ? { success: true, 'error-codes': [] }
          : { success: false, 'error-codes': ['invalid-input-response'] },
      );
    }
    if (url.pathname === '/google/token') {
      const code = new URLSearchParams(body).get('code') ?? '';
      const profile = codes.get(code);
      if (!profile) return json(res, { error: 'invalid_grant' }, 400);
      codes.delete(code);
      const accessToken = `access-${code}`;
      tokens.set(accessToken, profile);
      return json(res, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid email profile',
      });
    }
    if (url.pathname === '/google/userinfo') {
      const profile = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      return profile ? json(res, profile) : json(res, { error: 'invalid_token' }, 401);
    }
    return json(res, { error: 'not_found' }, 404);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  stubs.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stubs;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => done(data));
  });
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
