/**
 * The frame ticket (`src/frame-ticket.ts`): what one opens, what it does
 * not, and the cookie it is traded for. How a server uses it is
 * `frame-host.test.ts`; that a browser keeps the cookie in a frame on another
 * domain is `packages/widget/test/frame-host.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { mintToken } from '../src/auth/signed-token.ts';
import {
  FRAME_COOKIE,
  FRAME_COOKIE_TTL_MS,
  checkFrameCookie,
  checkFrameTicket,
  frameCookieHeader,
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
    const claims = { frameHost: HOST, workspaceId: 'w-harbor', expiresAt: NOW + 60_000 };
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

  it('refuses an expired ticket', () => {
    expect(redeemFrameTicket(KEYS, ticket, HOST, 'w-harbor', NOW + 121_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('the frame cookie', () => {
  it('is partitioned, script-proof, host-only and scoped to the board', () => {
    const header = frameCookieHeader('v.1', 'w-harbor');
    expect(header).toBe(
      `${FRAME_COOKIE}=v.1; Path=/workspaces/w-harbor/; Max-Age=43200; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
  });

  it('reads every value of its name and no other cookie', () => {
    expect(frameCookiesOf('a=1; cw_frame=x.1; cw_framed=2; cw_frame=y.2')).toEqual(['x.1', 'y.2']);
    expect(frameCookiesOf(null)).toEqual([]);
  });
});
