/**
 * `CW_SIGNIN` and the door it opens (`middleware/signin-door.ts`), with a
 * fake Better Auth and a fake Access verifier, so each mode's rule is read
 * on its own.
 */
import { describe, expect, it } from 'bun:test';
import type { BoardSignIn, SignedInPerson } from '../src/auth/board-signin.ts';
import type { CfAccessVerifier } from '../src/middleware/cf-access.ts';
import { createSignInDoor, parseSignInMode, signInFromEnv } from '../src/middleware/signin-door.ts';

const HOST = 'workspaces.harborlight.test';
const SUBDOMAIN = 'harborlight-workspaces.harborlight.test';

const fakeSignIn = (person: SignedInPerson | null): BoardSignIn => ({
  origin: `https://${HOST}`,
  host: HOST,
  handle: async (_req, pathname) =>
    pathname === '/auth/sign-in' ? new Response('page', { status: 200 }) : null,
  personOf: async () => person,
  close: async () => {},
});
const alice: SignedInPerson = {
  email: 'alice@harborlight.test',
  emailVerified: true,
  hd: null,
  issuedAt: 1_700_000_000,
};
const stamped: CfAccessVerifier = async (req) =>
  req.headers.has('cf-access-jwt-assertion')
    ? { ok: true, email: 'owner@harborlight.test' }
    : { ok: false, status: 401, error: 'missing_jwt' };
const at = (host: string, headers: Record<string, string> = {}, path = '/') =>
  new Request(`http://127.0.0.1${path}`, { headers: { host, ...headers } });

describe('parseSignInMode', () => {
  it('reads the three modes, defaults to access, and refuses anything else', () => {
    expect(parseSignInMode(undefined)).toBe('access');
    expect(parseSignInMode(' ')).toBe('access');
    expect(parseSignInMode('both')).toBe('both');
    expect(parseSignInMode('Better-Auth')).toBe('better-auth');
    expect(parseSignInMode('google')).toEqual({ error: expect.stringContaining('CW_SIGNIN') });
  });
});

describe('signInFromEnv', () => {
  const full = {
    CW_SIGNIN: 'better-auth',
    CW_SIGNIN_ORIGIN: `https://${HOST}/`,
    CW_GOOGLE_CLIENT_ID: 'shared-client',
    CW_GOOGLE_CLIENT_SECRET: 'stub-secret',
  };

  it('is nothing in access mode, whatever else is set', () => {
    expect(signInFromEnv({ ...full, CW_SIGNIN: 'access' })).toEqual({ setting: null });
    expect(signInFromEnv({})).toEqual({ setting: null });
  });

  it('reads a full setting, origin normalized', () => {
    expect(signInFromEnv(full)).toEqual({
      setting: {
        mode: 'better-auth',
        origin: `https://${HOST}`,
        google: { clientId: 'shared-client', clientSecret: 'stub-secret' },
      },
    });
  });

  it('refuses a mode missing what it needs, rather than falling back to Access', () => {
    for (const env of [
      { ...full, CW_SIGNIN_ORIGIN: '' },
      { ...full, CW_SIGNIN_ORIGIN: `http://${HOST}` },
      { ...full, CW_GOOGLE_CLIENT_SECRET: '' },
      { ...full, CW_SIGNIN: 'sometimes' },
    ]) {
      expect('error' in signInFromEnv(env)).toBe(true);
    }
  });
});

describe('the verifier each mode runs', () => {
  it('access: the Access verifier, untouched, and no sign-in routes', async () => {
    const door = createSignInDoor({ mode: 'access', signIn: fakeSignIn(alice) });
    expect(door.verifier(stamped)).toBe(stamped);
    expect(await door.claim(at(HOST), '/auth/sign-in')).toBeNull();
    expect(door.redirectFor(at(HOST), '/', true)).toBeNull();
  });

  it('better-auth: a session on the sign-in address, and never the stamp', async () => {
    const seen: string[] = [];
    const door = createSignInDoor({
      mode: 'better-auth',
      signIn: fakeSignIn(alice),
      onPerson: (e) => seen.push(e),
    });
    const verify = door.verifier(stamped);
    expect(await verify?.(at(HOST))).toEqual({
      ok: true,
      email: alice.email,
      issuedAt: alice.issuedAt,
    });
    expect(seen).toEqual([alice.email]);
    // The same session forwarded to another host proves nothing.
    expect((await verify?.(at(SUBDOMAIN)))?.ok).toBe(false);
    // An Access stamp alone is not read.
    const none = createSignInDoor({ mode: 'better-auth', signIn: fakeSignIn(null) });
    const stampOnly = await none.verifier(stamped)?.(at(HOST, { 'cf-access-jwt-assertion': 'x' }));
    expect(stampOnly?.ok).toBe(false);
  });

  it('an unverified address is nobody', async () => {
    const door = createSignInDoor({
      mode: 'better-auth',
      signIn: fakeSignIn({ ...alice, emailVerified: false }),
    });
    expect(await door.verifier(null)?.(at(HOST))).toEqual({
      ok: false,
      status: 401,
      error: 'signin_unverified',
    });
  });

  it('both: the stamp first, then a session, and the stamp’s refusal when neither', async () => {
    const withSession = createSignInDoor({ mode: 'both', signIn: fakeSignIn(alice) });
    const stampWins = await withSession.verifier(stamped)?.(
      at(HOST, { 'cf-access-jwt-assertion': 'x' }),
    );
    expect(stampWins).toEqual({ ok: true, email: 'owner@harborlight.test' });
    expect((await withSession.verifier(stamped)?.(at(HOST)))?.ok).toBe(true);
    const neither = createSignInDoor({ mode: 'both', signIn: fakeSignIn(null) });
    expect(await neither.verifier(stamped)?.(at(HOST))).toEqual({
      ok: false,
      status: 401,
      error: 'missing_jwt',
    });
  });
});

describe('the sign-in routes and redirects', () => {
  const door = createSignInDoor({ mode: 'better-auth', signIn: fakeSignIn(null) });

  it('claims sign-in paths on the sign-in address only', async () => {
    expect((await door.claim(at(HOST), '/auth/sign-in'))?.status).toBe(200);
    expect(await door.claim(at(SUBDOMAIN), '/auth/sign-in')).toBeNull();
  });

  it('sends a page to the sign-in page, keeping where it was going', () => {
    const res = door.redirectFor(at(HOST, {}, '/workspaces/w1?x=1'), '/workspaces/w1', true);
    expect(res?.status).toBe(302);
    expect(res?.headers.get('location')).toBe(
      `/auth/sign-in?next=${encodeURIComponent('/workspaces/w1?x=1')}`,
    );
  });

  it("sends the Mac's subdomain to the one address", () => {
    const res = door.redirectFor(at(SUBDOMAIN, {}, '/workspaces/w1'), '/workspaces/w1', true);
    expect(res?.status).toBe(308);
    expect(res?.headers.get('location')).toBe(`https://${HOST}/workspaces/w1`);
  });

  it('leaves a script with its refusal, and the subdomain alone in both', () => {
    expect(door.redirectFor(at(HOST), '/api/x', false)).toBeNull();
    const both = createSignInDoor({ mode: 'both', signIn: fakeSignIn(null) });
    expect(both.redirectFor(at(SUBDOMAIN), '/', true)).toBeNull();
  });
});

describe('the lock-out guard', () => {
  it('runs better-auth as both until the owner has signed in, then switches', async () => {
    let recorded = false;
    const door = createSignInDoor({
      mode: 'better-auth',
      signIn: fakeSignIn(null),
      ownerSignedIn: () => recorded,
    });
    const verify = door.verifier(stamped);
    const withStamp = at(HOST, { 'cf-access-jwt-assertion': 'x' });
    expect(door.effectiveMode()).toBe('both');
    expect((await verify?.(withStamp))?.ok).toBe(true);
    expect(door.redirectFor(at(SUBDOMAIN), '/', true)).toBeNull();
    recorded = true;
    expect(door.effectiveMode()).toBe('better-auth');
    expect((await verify?.(withStamp))?.ok).toBe(false);
    expect(door.redirectFor(at(SUBDOMAIN), '/', true)?.status).toBe(308);
  });

  it('leaves both and access as they are', () => {
    for (const mode of ['both', 'access'] as const) {
      const door = createSignInDoor({ mode, signIn: fakeSignIn(null), ownerSignedIn: () => false });
      expect(door.effectiveMode()).toBe(mode);
    }
  });
});

describe('"Sign in again" through the door', () => {
  const again = '/auth/sign-in?next=%2Fworkspaces&again=1';
  const signInWith = (person: SignedInPerson | null): BoardSignIn => ({
    ...fakeSignIn(person),
    signInAgainPath: async (_req, next) =>
      person ? `/auth/sign-in?next=${encodeURIComponent(next)}&again=1` : null,
  });

  it('better-auth: a session on the sign-in address goes through the sign-in again', async () => {
    const door = createSignInDoor({ mode: 'better-auth', signIn: signInWith(alice) });
    expect(await door.signInAgainPath(at(HOST), '/workspaces', stamped)).toBe(again);
    // Not on the sign-in address: the cookie cannot be there.
    expect(await door.signInAgainPath(at(SUBDOMAIN), '/workspaces', stamped)).toBeNull();
    const none = createSignInDoor({ mode: 'better-auth', signIn: signInWith(null) });
    expect(await none.signInAgainPath(at(HOST), '/workspaces', stamped)).toBeNull();
  });

  // In both, the stamp proves the person first, so renewing the session
  // would leave the proof as old as it was.
  it('both: the stamp, when it proves the person, is what has to be renewed', async () => {
    const door = createSignInDoor({ mode: 'both', signIn: signInWith(alice) });
    const withStamp = at(HOST, { 'cf-access-jwt-assertion': 'x' });
    expect(await door.signInAgainPath(withStamp, '/workspaces', stamped)).toBeNull();
    expect(await door.signInAgainPath(at(HOST), '/workspaces', stamped)).toBe(again);
  });

  it('access: never', async () => {
    const door = createSignInDoor({ mode: 'access', signIn: signInWith(alice) });
    expect(await door.signInAgainPath(at(HOST), '/workspaces', stamped)).toBeNull();
  });
});
