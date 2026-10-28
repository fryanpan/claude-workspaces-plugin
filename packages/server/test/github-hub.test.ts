/**
 * Unit cases for a board's GitHub subscriptions and its push key
 * (`github-hub.ts`, `auth/github-push-key.ts`). The route cases are
 * github-hub-routes.test.ts; the relay between two real servers is
 * github-relay-two-servers.test.ts.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardAgentToken, boardAgentTokenKey } from '../src/auth/board-agent-token.ts';
import {
  githubPushBearerOf,
  githubPushKey,
  githubPushKeyKey,
  mintGithubPushKey,
} from '../src/auth/github-push-key.ts';
import { mintToken, verifyToken } from '../src/auth/signed-token.ts';
import {
  GithubHub,
  githubHubPath,
  parseGithubEventPush,
  parseGithubSubscriptions,
} from '../src/github-hub.ts';

const BASE_KEY = 'b'.repeat(64);
const BOARD = 'w-harbor';
const OTHER = 'w-salt';
const KEY_ID = 'abcdefghijklmnopqr';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function hub(baseKey = BASE_KEY): { hub: GithubHub; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gh-hub-'));
  dirs.push(dir);
  const path = githubHubPath(dir);
  return { hub: new GithubHub(path, () => githubPushKeyKey(baseKey)), path };
}

describe('the gp1 format', () => {
  it('signs under a key of its own: an at2 shaped like it never verifies', () => {
    expect(githubPushKeyKey(BASE_KEY)).not.toBe(boardAgentTokenKey(BASE_KEY));
    const at2 = mintToken(
      boardAgentToken,
      { tokenId: KEY_ID, agentId: 'agent-x', boardId: BOARD, expiresAt: Date.now() + 60_000 },
      boardAgentTokenKey(BASE_KEY),
    );
    expect(verifyToken(githubPushKey, at2, githubPushKeyKey(BASE_KEY)).ok).toBe(false);
    // The same claims signed with the base key itself, not the derived one.
    const undomained = mintGithubPushKey({ boardId: BOARD, keyId: KEY_ID }, BASE_KEY);
    expect(verifyToken(githubPushKey, undomained, githubPushKeyKey(BASE_KEY)).ok).toBe(false);
  });

  it('round-trips its claims and refuses a payload with an extra field', () => {
    const key = githubPushKeyKey(BASE_KEY);
    const v = verifyToken(
      githubPushKey,
      mintGithubPushKey({ boardId: BOARD, keyId: KEY_ID }, key),
      key,
    );
    expect(v).toEqual({ ok: true, claims: { boardId: BOARD, keyId: KEY_ID } });
    expect(githubPushKey.decode(`gp1.${BOARD}.${KEY_ID}.extra`)).toBeNull();
    expect(githubPushKey.decode(`gp1.${BOARD}.short`)).toBeNull();
  });

  it('is read only from a gp1 bearer', () => {
    expect(githubPushBearerOf(new Headers({ authorization: 'Bearer gp1.x.y.z' }))).toBe(
      'gp1.x.y.z',
    );
    expect(githubPushBearerOf(new Headers({ authorization: 'Bearer at2.x.y.z' }))).toBeNull();
    expect(githubPushBearerOf(new Headers())).toBeNull();
  });
});

describe('the board record', () => {
  it('verifies a minted key for its board only, and a re-mint retires the old one', () => {
    const { hub: h } = hub();
    const first = h.mintKey(BOARD).key;
    expect(h.verifyKey(first, BOARD)).toBe(true);
    expect(h.verifyKey(first, OTHER)).toBe(false);
    const second = h.mintKey(BOARD).key;
    expect(h.verifyKey(second, BOARD)).toBe(true);
    expect(h.verifyKey(first, BOARD)).toBe(false);
    expect(h.verifyKey(null, BOARD)).toBe(false);
  });

  it('refuses a key minted by a server holding a different key file', () => {
    const { hub: mine } = hub();
    const { hub: theirs } = hub('c'.repeat(64));
    const key = theirs.mintKey(BOARD).key;
    mine.mintKey(BOARD);
    expect(mine.verifyKey(key, BOARD)).toBe(false);
  });

  it('keeps the subscriptions and key id across a restart, never the key value, mode 600', () => {
    const { hub: h, path } = hub();
    const { key } = h.mintKey(BOARD);
    h.setSubscriptions(BOARD, [{ repo: 'harborlight/app', kinds: ['merge', 'ci'] }]);
    const again = new GithubHub(path, () => githubPushKeyKey(BASE_KEY));
    expect(again.verifyKey(key, BOARD)).toBe(true);
    // Kinds come back in the one canonical order.
    expect(again.subscriptions(BOARD)).toEqual([
      { repo: 'harborlight/app', kinds: ['ci', 'merge'] },
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain(key);
  });

  it('wants an event only for a subscribed repo and kind, repo case aside', () => {
    const { hub: h } = hub();
    h.setSubscriptions(BOARD, [{ repo: 'Harborlight/App', kinds: ['merge'] }]);
    expect(h.wants(BOARD, 'harborlight/app', 'merge')).toBe(true);
    expect(h.wants(BOARD, 'harborlight/app', 'ci')).toBe(false);
    expect(h.wants(BOARD, 'riverbend/app', 'merge')).toBe(false);
    expect(h.wants(OTHER, 'harborlight/app', 'merge')).toBe(false);
  });

  it('sees an event id once per board', () => {
    const { hub: h } = hub();
    expect(h.firstSight(BOARD, 'event-0001')).toBe(true);
    expect(h.firstSight(BOARD, 'event-0001')).toBe(false);
    expect(h.firstSight(OTHER, 'event-0001')).toBe(true);
  });
});

describe('parsing what a caller sends', () => {
  it('takes a subscription list and refuses each hostile shape with a sentence', () => {
    expect(parseGithubSubscriptions([{ repo: 'riverbend/site', kinds: ['deploy'] }])).toEqual([
      { repo: 'riverbend/site', kinds: ['deploy'] },
    ]);
    for (const bad of [
      'nope',
      [{ repo: '../etc/passwd', kinds: ['ci'] }],
      [{ repo: 'a/b/c', kinds: ['ci'] }],
      [{ repo: 'riverbend/site', kinds: [] }],
      [{ repo: 'riverbend/site', kinds: ['push'] }],
      [
        { repo: 'riverbend/site', kinds: ['ci'] },
        { repo: 'Riverbend/Site', kinds: ['merge'] },
      ],
    ]) {
      expect(typeof parseGithubSubscriptions(bad)).toBe('string');
    }
  });

  it('takes one event and refuses a bad id, kind, or text', () => {
    const ok = {
      id: 'event-0001',
      repo: 'riverbend/site',
      kind: 'ci' as const,
      text: '✅ CI **success**\nok',
    };
    expect(parseGithubEventPush(ok)).toEqual(ok);
    for (const over of [
      { id: 'short' },
      { kind: 'push' },
      { repo: 'not a repo' },
      { text: '' },
      { text: 'x'.repeat(2_001) },
      { text: 'reads ‮backwards' },
      { text: 'bell \u0007' },
    ]) {
      expect(typeof parseGithubEventPush({ ...ok, ...over })).toBe('string');
    }
  });
});
