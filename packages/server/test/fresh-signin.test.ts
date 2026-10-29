/**
 * The pieces of `src/fresh-signin.ts` that the route suite
 * (`fresh-signin-routes.test.ts`) cannot reach cheaply: the window's edges,
 * an agent's token, a link lengthened or shortened, and the session cookie's
 * sign-in time surviving a refresh.
 */
import { describe, expect, it } from 'bun:test';
import {
  mintSession,
  refreshedSession,
  sessionKey,
  signSession,
  verifySession,
} from '../src/auth/session.ts';
import {
  type CountedActionContext,
  FRESH_SIGNIN_WINDOW_SECONDS,
  countedActionOf,
  isFreshSignIn,
  personProofOf,
  refuseStaleSignIn,
} from '../src/fresh-signin.ts';
import type { IdentityRecord } from '../src/identities.ts';
import { sameOriginPath } from '../src/routes/auth-share.ts';
import type { Shares } from '../src/share/shares.ts';

const NOW = 1_800_000_000_000;
const person = { id: 'user-riverbend' } as IdentityRecord;

describe('isFreshSignIn', () => {
  it('is fresh inside the window and stale one second past it', () => {
    const edge = NOW - FRESH_SIGNIN_WINDOW_SECONDS * 1000;
    expect(isFreshSignIn(edge, NOW)).toBe(true);
    expect(isFreshSignIn(edge - 1000, NOW)).toBe(false);
  });

  it('is never fresh with no sign-in time, or one well ahead of the clock', () => {
    expect(isFreshSignIn(null, NOW)).toBe(false);
    expect(isFreshSignIn(NOW + 30_000, NOW)).toBe(true);
    expect(isFreshSignIn(NOW + 3_600_000, NOW)).toBe(false);
  });
});

describe('personProofOf', () => {
  const none = { accessEmail: null, accessIssuedAt: null, boardAgent: null };

  it('reads the Access iat first, in milliseconds', () => {
    const proof = personProofOf(
      { accessEmail: 'alice@example.test', accessIssuedAt: 1_700_000_000, boardAgent: null },
      person,
      5,
    );
    expect(proof).toEqual({ signedInAtMs: 1_700_000_000_000 });
  });

  it('falls back to the session cookie, and is null with no proof at all', () => {
    expect(personProofOf(none, person, NOW)).toEqual({ signedInAtMs: NOW });
    expect(personProofOf(none, person, null)).toEqual({ signedInAtMs: null });
    expect(personProofOf(none, null, null)).toBeNull();
  });

  it('reads a widget popup token as a person whose sign-in is never fresh', () => {
    expect(personProofOf(none, null, null, person)).toEqual({ signedInAtMs: null });
    expect(personProofOf(none, person, NOW, person)).toEqual({ signedInAtMs: NOW });
  });

  it('is null for a board agent token, whatever else the request carries', () => {
    const agent = { accessEmail: 'alice@example.test', accessIssuedAt: 1, boardAgent: {} };
    expect(personProofOf(agent, person, null)).toBeNull();
  });
});

const ACCESS_CARD = '/workspaces/w-1/tasks/t-1/review-items/r-1/access';

describe('countedActionOf', () => {
  const ctx: CountedActionContext = { shares: null, now: NOW };
  const req = (method: string, path: string, body?: unknown) =>
    new Request(`http://localhost${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const action = (method: string, path: string, body?: unknown, c = ctx) =>
    countedActionOf(req(method, path, body), path, c);

  it('names each counted route', async () => {
    expect(await action('DELETE', '/workspaces/w-1')).toBe('delete-workspace');
    expect(await action('DELETE', '/workspaces/w-1/docs/d-1')).toBe('delete-doc');
    expect(await action('DELETE', '/workspaces/w-1/attachments/s-1')).toBe('delete-attachment-set');
    expect(await action('POST', '/workspaces/w-1/docs/d-1/archive')).toBe('archive-doc');
    expect(await action('POST', '/workspaces/w-1/attachments/s-1/archive')).toBe(
      'archive-attachment-set',
    );
    expect(await action('PUT', '/workspaces/w-1/retired', { retired: true })).toBe(
      'retire-workspace',
    );
    expect(await action('POST', '/workspaces/w-1/members/a%40b.test/role', { role: 'owner' })).toBe(
      'raise-role',
    );
    expect(await action('POST', '/api/share/workspace', {})).toBe('share-workspace');
    expect(await action('POST', '/api/share/link', {})).toBe('share-link');
    expect(await action('POST', '/api/share/enabled', { enabled: true })).toBe('sharing-on');
    expect(await action('POST', '/api/share/lock', { locked: false })).toBe('unlock-board');
    expect(await action('POST', '/workspaces/w-1/audience', { add: ['@riverbend.test'] })).toBe(
      'add-member',
    );
    expect(await action('POST', ACCESS_CARD, { decision: 'approve' })).toBe('approve-access');
  });

  it('counts a path the router reads the same way with trailing slashes', async () => {
    expect(await action('DELETE', '/workspaces/w-1/docs/d-1/')).toBe('delete-doc');
    expect(await action('DELETE', '/workspaces/w-1//')).toBe('delete-workspace');
    expect(await action('POST', '/workspaces/w-1/docs/d-1/archive/')).toBe('archive-doc');
    expect(await action('POST', '/api/share/link/')).toBe('share-link');
    expect(await action('POST', '/workspaces/w-1/audience/', { add: ['a@b.test'] })).toBe(
      'add-member',
    );
  });

  it('counts a body it cannot read rather than waving it through', async () => {
    expect(await action('PUT', '/workspaces/w-1/retired')).toBe('retire-workspace');
    expect(await action('POST', '/api/share/enabled')).toBe('sharing-on');
    expect(await action('POST', '/workspaces/w-1/audience')).toBe('add-member');
    expect(await action('POST', ACCESS_CARD)).toBe('approve-access');
  });

  it('leaves every narrowing and every task, goal and unarchive verb instant', async () => {
    expect(await action('PUT', '/workspaces/w-1/retired', { retired: false })).toBeNull();
    expect(await action('POST', '/workspaces/w-1/members/a/role', { role: 'member' })).toBeNull();
    expect(await action('DELETE', '/workspaces/w-1/members/a')).toBeNull();
    expect(await action('POST', '/api/share/enabled', { enabled: false })).toBeNull();
    expect(await action('POST', '/api/share/lock', { locked: true })).toBeNull();
    expect(
      await action('POST', '/workspaces/w-1/audience', { remove: ['@riverbend.test'] }),
    ).toBeNull();
    expect(await action('POST', '/workspaces/w-1/audience', { add: [], remove: ['a'] })).toBeNull();
    expect(await action('POST', ACCESS_CARD, { decision: 'reject' })).toBeNull();
    expect(await action('POST', '/workspaces/w-1/tasks/t-1/archive')).toBeNull();
    expect(await action('POST', '/workspaces/w-1/goals/g-1/archive')).toBeNull();
    expect(await action('POST', '/workspaces/w-1/docs/d-1/unarchive')).toBeNull();
    expect(await action('POST', '/workspaces/w-1/attachments/s-1/unarchive')).toBeNull();
    expect(await action('GET', '/workspaces/w-1')).toBeNull();
  });

  it('counts a link lengthened and not one shortened', async () => {
    const expiresAt = NOW + 3600 * 1000;
    const shares = {
      findLive: (id: string) => (id === 'sh-1' ? { expiresAt } : null),
      defaultLinkTtlSeconds: 3600,
      maxTtlSeconds: undefined,
    } as unknown as Shares;
    const c = { shares, now: NOW };
    expect(await action('POST', '/api/share/sh-1/ttl', { ttlSeconds: 7200 }, c)).toBe(
      'lengthen-share',
    );
    expect(await action('POST', '/api/share/sh-1/ttl', { ttl: '15m' }, c)).toBeNull();
    expect(await action('POST', '/api/share/sh-2/ttl', { ttlSeconds: 7200 }, c)).toBeNull();
  });
});

describe('refuseStaleSignIn', () => {
  const del = () => new Request('http://localhost/workspaces/w-1', { method: 'DELETE' });
  const ctx = { shares: null, now: NOW };

  it('answers 403 confirm-required for a stale proof, and nothing for a fresh one or none', async () => {
    const stale = await refuseStaleSignIn(del(), '/workspaces/w-1', { signedInAtMs: 0 }, ctx);
    expect(stale?.status).toBe(403);
    expect(await stale?.json()).toMatchObject({ error: 'confirm-required', window: 600 });
    expect(
      await refuseStaleSignIn(del(), '/workspaces/w-1', { signedInAtMs: NOW }, ctx),
    ).toBeNull();
    expect(await refuseStaleSignIn(del(), '/workspaces/w-1', null, ctx)).toBeNull();
  });
});

describe("the session cookie's sign-in time", () => {
  const key = sessionKey('test-cookie-key');

  it('is set at login, survives the round trip, and a refresh does not move it', () => {
    const minted = mintSession('user-riverbend', NOW);
    expect(minted.signedInAt).toBe(NOW);
    const read = verifySession(signSession(minted, key), key);
    expect(read?.signedInAt).toBe(NOW);
    const refreshed = refreshedSession(read ?? minted, NOW + 86_400_000);
    expect(refreshed.issuedAt).toBe(NOW + 86_400_000);
    expect(verifySession(signSession(refreshed, key), key)?.signedInAt).toBe(NOW);
  });

  it('is absent on a cookie minted before it existed', () => {
    const v2 = signSession({ ...mintSession('user-riverbend', NOW), signedInAt: null }, key);
    expect(v2.startsWith('v2.')).toBe(true);
    expect(verifySession(v2, key)?.signedInAt ?? null).toBeNull();
  });
});

describe('sameOriginPath', () => {
  it('keeps a same-origin path and turns anything else into the root', () => {
    expect(sameOriginPath('/workspaces/w-1/docs/d-1?x=1')).toBe('/workspaces/w-1/docs/d-1?x=1');
    for (const bad of [
      null,
      '',
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/ /evil.example',
      '/x\u0000',
    ]) {
      expect(sameOriginPath(bad)).toBe('/');
    }
  });
});
