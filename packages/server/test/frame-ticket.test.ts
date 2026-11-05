/**
 * The frame ticket (`src/frame-ticket.ts`): what one opens, what it does
 * not, and the cookie it is traded for. How a server uses it is
 * `frame-host.test.ts`; that a browser keeps the cookie in a frame on another
 * domain is `packages/widget/test/frame-host.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { mintToken } from '../src/auth/signed-token.ts';
import {
  FRAME_COOKIE_TTL_MS,
  LEGACY_FRAME_COOKIE,
  checkFrameCookie,
  checkFrameTicket,
  frameCookieHeader,
  frameCookieName,
  frameCookiesOf,
  frameKeys,
  frameTicket,
  mintFrameTicket,
  redeemFrameTicket,
} from '../src/frame-ticket.ts';

const KEYS = frameKeys('harborlight-test-cookie-key');
const KEY = KEYS.ticket;
const HOST = 'harborlight.frames.test';
const NOW = 1_800_000_000_000;

describe('a frame ticket', () => {
  const ticket = mintFrameTicket(KEY, HOST, 'w-harbor', NOW);

  it('opens one board on one frame hostname until it expires', () => {
    expect(checkFrameTicket(KEY, ticket, HOST, 'w-harbor', NOW + 119_000)).toEqual({
      ok: true,
      expiresAt: NOW + 120_000,
      appVoice: false,
    });
    expect(checkFrameTicket(KEY, ticket, HOST, 'w-harbor', NOW + 121_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it("opens nothing on another project's frame hostname or for another board", () => {
    expect(checkFrameTicket(KEY, ticket, 'riverbend.frames.test', 'w-harbor', NOW)).toEqual({
      ok: false,
      reason: 'other_frame_host',
    });
    expect(checkFrameTicket(KEY, ticket, HOST, 'w-riverbend', NOW)).toEqual({
      ok: false,
      reason: 'other_board',
    });
  });

  it("is refused under another server's key, and when altered", () => {
    const other = frameKeys('riverbend-test-cookie-key').ticket;
    expect(checkFrameTicket(other, ticket, HOST, 'w-harbor', NOW).ok).toBe(false);
    const altered = `${ticket.slice(0, -1)}${ticket.endsWith('A') ? 'B' : 'A'}`;
    expect(checkFrameTicket(KEY, altered, HOST, 'w-harbor', NOW).ok).toBe(false);
    expect(checkFrameTicket(KEY, null, HOST, 'w-harbor', NOW)).toEqual({
      ok: false,
      reason: 'absent',
    });
  });

  it('is not signed with the base key, so no other protocol mints one', () => {
    const claims = {
      frameHost: HOST,
      workspaceId: 'w-harbor',
      expiresAt: NOW + 60_000,
      appVoice: true,
    };
    const underBase = mintToken(frameTicket, claims, 'harborlight-test-cookie-key');
    expect(checkFrameTicket(KEY, underBase, HOST, 'w-harbor', NOW).ok).toBe(false);
  });
});

describe('redeeming a ticket', () => {
  const ticket = mintFrameTicket(KEY, HOST, 'w-harbor', NOW);

  it('gives a cookie that opens the board, and is not itself a ticket', () => {
    const r = redeemFrameTicket(KEYS, ticket, HOST, 'w-harbor', NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(checkFrameCookie(KEYS.cookie, r.cookie, HOST, 'w-harbor', NOW).ok).toBe(true);
    // A cookie value sent back as a ticket buys nothing.
    expect(checkFrameTicket(KEY, r.cookie, HOST, 'w-harbor', NOW).ok).toBe(false);
    expect(redeemFrameTicket(KEYS, r.cookie, HOST, 'w-harbor', NOW).ok).toBe(false);
    // Nor is a ticket a cookie.
    expect(checkFrameCookie(KEYS.cookie, ticket, HOST, 'w-harbor', NOW).ok).toBe(false);
  });

  it('ends twelve hours after the ticket was minted, however late it is redeemed', () => {
    const late = NOW + 110_000;
    const r = redeemFrameTicket(KEYS, ticket, HOST, 'w-harbor', late);
    if (!r.ok) throw new Error(r.reason);
    expect(r.maxAgeMs).toBe(FRAME_COOKIE_TTL_MS - 110_000);
    const end = NOW + FRAME_COOKIE_TTL_MS;
    expect(checkFrameCookie(KEYS.cookie, r.cookie, HOST, 'w-harbor', end - 1_000).ok).toBe(true);
    expect(checkFrameCookie(KEYS.cookie, r.cookie, HOST, 'w-harbor', end + 1_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('carries the app voice grant into the cookie exactly when the ticket had it', () => {
    for (const appVoice of [true, false]) {
      const t = mintFrameTicket(KEY, HOST, 'w-harbor', NOW, appVoice);
      expect(checkFrameTicket(KEY, t, HOST, 'w-harbor', NOW)).toMatchObject({ ok: true, appVoice });
      const r = redeemFrameTicket(KEYS, t, HOST, 'w-harbor', NOW);
      if (!r.ok) throw new Error(r.reason);
      expect(checkFrameCookie(KEYS.cookie, r.cookie, HOST, 'w-harbor', NOW)).toMatchObject({
        ok: true,
        appVoice,
      });
    }
  });

  it('refuses a grant added to a ticket that did not carry one', () => {
    // The field sits inside the signed payload: appending it breaks the
    // signature, so a reader cannot promote their own ticket.
    const plain = mintFrameTicket(KEY, HOST, 'w-harbor', NOW);
    const dot = plain.lastIndexOf('.');
    const promoted = `${plain.slice(0, dot)}.v${plain.slice(dot)}`;
    expect(checkFrameTicket(KEY, promoted, HOST, 'w-harbor', NOW).ok).toBe(false);
  });

  it("carries a board member's address into the cookie, and never app voice with it", () => {
    const t = mintFrameTicket(KEY, HOST, 'w-harbor', NOW, true, 'reviewer@partner.example');
    expect(checkFrameTicket(KEY, t, HOST, 'w-harbor', NOW)).toEqual({
      ok: true,
      expiresAt: NOW + 120_000,
      appVoice: false,
      member: 'reviewer@partner.example',
    });
    const r = redeemFrameTicket(KEYS, t, HOST, 'w-harbor', NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(checkFrameCookie(KEYS.cookie, r.cookie, HOST, 'w-harbor', NOW)).toMatchObject({
      ok: true,
      appVoice: false,
      member: 'reviewer@partner.example',
    });
    // The owner's ticket names nobody, so it is checked as it always was.
    const owner = checkFrameTicket(
      KEY,
      mintFrameTicket(KEY, HOST, 'w-harbor', NOW),
      HOST,
      'w-harbor',
      NOW,
    );
    expect(owner.ok && 'member' in owner).toBe(false);
  });

  it('refuses a member address added to, or removed from, a signed ticket', () => {
    const plain = mintFrameTicket(KEY, HOST, 'w-harbor', NOW);
    const dot = plain.lastIndexOf('.');
    const named = `${plain.slice(0, dot)}.m${Buffer.from('a@b.example').toString('base64url')}${plain.slice(dot)}`;
    expect(checkFrameTicket(KEY, named, HOST, 'w-harbor', NOW).ok).toBe(false);
    const member = mintFrameTicket(KEY, HOST, 'w-harbor', NOW, false, 'a@b.example');
    const parts = member.split('.');
    const stripped = [...parts.slice(0, 4), ...parts.slice(5)].join('.');
    expect(checkFrameTicket(KEY, stripped, HOST, 'w-harbor', NOW).ok).toBe(false);
  });

  it('refuses an expired ticket', () => {
    expect(redeemFrameTicket(KEYS, ticket, HOST, 'w-harbor', NOW + 121_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('the frame cookie', () => {
  it('is a __Host- cookie of its board: partitioned, script-proof, host-only, Path=/', () => {
    const header = frameCookieHeader('v.1', 'w-harbor');
    expect(header).toBe(
      '__Host-cw_frame-w-harbor=v.1; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=None; Partitioned',
    );
  });

  it('names one cookie per board, so two boards on one frame hostname keep both', () => {
    expect(frameCookieName('w-harbor')).toBe('__Host-cw_frame-w-harbor');
    expect(frameCookieName('w-river')).not.toBe(frameCookieName('w-harbor'));
    // A character a cookie name cannot hold is replaced, never passed through.
    expect(frameCookieName('w;x=y')).toBe('__Host-cw_frame-w_x_y');
  });

  it('reads every value of its own board’s name and no other cookie', () => {
    const header =
      'a=1; __Host-cw_frame-w-harbor=x.1; __Host-cw_frame-w-river=r.1; __Host-cw_frame-w-harbor=y.2';
    expect(frameCookiesOf(header, 'w-harbor')).toEqual(['x.1', 'y.2']);
    expect(frameCookiesOf(null, 'w-harbor')).toEqual([]);
  });

  it('still reads the old cw_frame name for one release, so an open frame keeps working', () => {
    expect(LEGACY_FRAME_COOKIE).toBe('cw_frame');
    expect(frameCookiesOf('cw_frame=old.1; cw_framed=2', 'w-harbor')).toEqual(['old.1']);
  });
});
