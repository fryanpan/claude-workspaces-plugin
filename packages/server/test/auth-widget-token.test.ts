import { describe, expect, it } from 'bun:test';
import { mintToken } from '../src/auth/signed-token.ts';
import {
  BOARD_WIDGET_TOKEN_TTL_MS,
  boardWidgetToken,
  mintBoardWidgetToken,
  verifyBoardWidgetToken,
  widgetTokenKey,
} from '../src/auth/widget-token.ts';

const KEY = widgetTokenKey('test-cookie-key');
/** The dev-server origin a token is minted for — the only page that may use it. */
const ORIGIN = 'http://127.0.0.1:5173';
const BOARD = 'w-harbor';
const now = 1_700_000_000_000;

describe('widgetTokenKey', () => {
  it('is domain-separated from the raw cookie key', () => {
    expect(widgetTokenKey('k')).not.toBe('k');
    expect(widgetTokenKey('k')).toBe(widgetTokenKey('k'));
    expect(widgetTokenKey('k')).not.toBe(widgetTokenKey('k2'));
  });
});

describe('mintBoardWidgetToken', () => {
  it('from a session: carries the board, the origin and the session, for one day', () => {
    const grant = { identityId: 'user-abc123', workspaceId: BOARD, origin: ORIGIN };
    const token = mintBoardWidgetToken({ ...grant, sessionId: 'sid_1-x' }, KEY, now);
    expect(verifyBoardWidgetToken(token, KEY, now)).toEqual({
      ...grant,
      sessionId: 'sid_1-x',
      issuedAt: now,
      expiresAt: now + BOARD_WIDGET_TOKEN_TTL_MS,
    });
    // The board stays the fifth field, where the widget reads it.
    expect(token.split('.')[4]).toBe(Buffer.from(BOARD).toString('base64url'));
  });

  it('from Access: names no session, in the six-field shape tokens already out there carry', () => {
    const token = mintBoardWidgetToken(
      { identityId: 'user-abc123', workspaceId: BOARD, origin: ORIGIN },
      KEY,
      now,
    );
    expect(token.slice(0, token.lastIndexOf('.')).split('.')).toHaveLength(6);
    expect(verifyBoardWidgetToken(token, KEY, now)?.sessionId).toBeNull();
  });
});

describe('verifyBoardWidgetToken', () => {
  const token = mintBoardWidgetToken(
    { identityId: 'user-abc123', workspaceId: BOARD, origin: ORIGIN, sessionId: 'sid1' },
    KEY,
    now,
  );

  it('carries the recipient origin intact, dots and port included', () => {
    expect(verifyBoardWidgetToken(token, KEY, now)?.origin).toBe(ORIGIN);
    const https = mintBoardWidgetToken(
      { identityId: 'u', workspaceId: BOARD, origin: 'https://app.example.com' },
      KEY,
      now,
    );
    expect(verifyBoardWidgetToken(https, KEY, now)?.origin).toBe('https://app.example.com');
  });

  it('refuses an expired token', () => {
    expect(verifyBoardWidgetToken(token, KEY, now + BOARD_WIDGET_TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(verifyBoardWidgetToken(token, KEY, now + BOARD_WIDGET_TOKEN_TTL_MS)).toBeNull();
  });

  it('refuses a tampered token, and one signed with a different key', () => {
    const swapped = token.replace('user-abc123', 'user-evil99');
    expect(swapped).not.toBe(token);
    expect(verifyBoardWidgetToken(swapped, KEY, now)).toBeNull();
    expect(verifyBoardWidgetToken(token, widgetTokenKey('other-cookie-key'), now)).toBeNull();
  });

  it('refuses a session id that is not one', () => {
    const odd = mintToken(
      boardWidgetToken,
      {
        identityId: 'u',
        workspaceId: BOARD,
        origin: ORIGIN,
        sessionId: 'has space',
        issuedAt: now,
        expiresAt: now + 1000,
      },
      KEY,
    );
    expect(verifyBoardWidgetToken(odd, KEY, now)).toBeNull();
  });

  it('refuses the retired wt1 and a session cookie value — the formats never cross', () => {
    // A genuine wt1 value: the retired payload, signed under the same key.
    const raw = {
      keyDomain: null,
      tags: null,
      encode: (p: string) => p,
      decode: (p: string) => p,
      expiresAt: () => null,
    };
    const wt1 = mintToken(raw, `wt1.user-abc123.sid.1.${now + 1000}.b3JpZ2lu`, KEY);
    expect(verifyBoardWidgetToken(wt1, KEY, now)).toBeNull();
    expect(verifyBoardWidgetToken('v2.user-abc123.sid.123.mac', KEY, now)).toBeNull();
    expect(verifyBoardWidgetToken('', KEY, now)).toBeNull();
    expect(verifyBoardWidgetToken(null, KEY, now)).toBeNull();
  });
});
