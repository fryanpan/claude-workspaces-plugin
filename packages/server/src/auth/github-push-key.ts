/**
 * The board's GitHub push key: `Authorization: Bearer gp1.<boardId>.<keyId>.<mac>`.
 *
 * The Mac's GitHub relay (`github-relay/`) holds one per remote board. It
 * opens exactly two routes on that board (`routes/github-hub.ts`): reading
 * the board's GitHub subscriptions, and posting one event the board asked
 * for. It opens nothing else — no other route reads this bearer, and the
 * board-agent door and request admission never see it, because the two
 * routes answer above admission.
 *
 * Signed through `signed-token.ts` under its own key domain, so no other
 * protocol's value verifies as one and this one verifies as nothing else.
 *
 * One live key per board. The MAC proves this server minted the value; the
 * board's record (`github-hub.ts`) names the one key id that still stands,
 * so minting again replaces the key and the old value stops verifying. It
 * carries no expiry: its only holder is a process on the Mac that reads it
 * from the Keychain at start, and a re-mint is the rotation.
 */
import { type TokenFormat, mintToken, tokenClaims, tokenKey } from './signed-token.ts';

const VERSION = 'gp1';
/** A board id. No dot, so the payload splits. */
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_ID = /^[A-Za-z0-9_-]{16,64}$/;

export interface GithubPushKeyClaims {
  /** The one board this key pushes to. */
  boardId: string;
  /** The board record's current key id must equal this. */
  keyId: string;
}

/** `gp1.<boardId>.<keyId>`. */
export const githubPushKey: TokenFormat<GithubPushKeyClaims> = {
  keyDomain: 'cw-github-push-key-v1',
  tags: [VERSION],
  encode: (c) => [VERSION, c.boardId, c.keyId].join('.'),
  decode(payload) {
    const [version, boardId, keyId, ...rest] = payload.split('.');
    if (version !== VERSION || rest.length > 0) return null;
    if (!boardId || !BOARD_ID.test(boardId)) return null;
    if (!keyId || !KEY_ID.test(keyId)) return null;
    return { boardId, keyId };
  },
  expiresAt: () => null,
};

/** This format's key, derived from the one key file under its own domain. */
export function githubPushKeyKey(cookieKey: string): string {
  return tokenKey(cookieKey, githubPushKey);
}

export function mintGithubPushKey(claims: GithubPushKeyClaims, key: string): string {
  return mintToken(githubPushKey, claims, key);
}

/** The claims a value attests to, or null for anything that is not one. */
export function githubPushKeyClaims(value: string | null, key: string): GithubPushKeyClaims | null {
  return tokenClaims(githubPushKey, value, key);
}

/** The `gp1` bearer this request carries, or null. Shape-matched, so a
 *  bearer for another protocol is never offered to this verifier. */
export function githubPushBearerOf(headers: Headers): string | null {
  const raw = headers.get('authorization');
  const m = raw?.match(/^Bearer\s+(gp1\.[^\s]+)$/i);
  return m?.[1] ?? null;
}

export function isValidGithubPushKeyId(id: unknown): id is string {
  return typeof id === 'string' && KEY_ID.test(id);
}
