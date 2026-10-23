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
  checkFrameTicket,
  frameCookieHeader,
  frameCookiesOf,
  frameTicket,
  frameTicketKey,
  mintFrameTicket,
} from '../src/frame-ticket.ts';

const KEY = frameTicketKey('harborlight-test-cookie-key');
const HOST = 'harborlight.frames.test';
const NOW = 1_800_000_000_000;

describe('a frame ticket', () => {
  const ticket = mintFrameTicket(KEY, HOST, 'w-harbor', 120_000, NOW);

  it('opens one board on one frame hostname until it expires', () => {
    expect(checkFrameTicket(KEY, ticket, HOST, 'w-harbor', NOW + 119_000)).toEqual({ ok: true });
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
    const other = frameTicketKey('riverbend-test-cookie-key');
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
