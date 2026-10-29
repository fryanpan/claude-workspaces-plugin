/**
 * The two requests the owner's hostname still takes while sharing is off,
 * and the page one of them serves. The admission half, on a real server, is
 * the "owner's notice" block of `sharing-switch.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { renderSharingOffPage } from '../src/routes/sharing-off-page.ts';
import { sharingOffCardPath, sharingOffDoorAllows } from '../src/sharing-off-door.ts';

const CARD = { workspaceId: 'w-harbor', taskId: 't-1', itemId: 'r-2' };
const DOOR = '/workspaces/w-harbor/tasks/t-1/review-items/r-2/access';

describe('sharingOffDoorAllows', () => {
  it("lets through the page and the open card's door, and nothing else", () => {
    expect(sharingOffCardPath(CARD)).toBe(DOOR);
    expect(sharingOffDoorAllows('GET', '/sharing-off', CARD)).toBe(true);
    expect(sharingOffDoorAllows('POST', DOOR, CARD)).toBe(true);
  });

  it('refuses another card, another method, another route, and any door with no open card', () => {
    expect(sharingOffDoorAllows('POST', DOOR.replace('r-2', 'r-3'), CARD)).toBe(false);
    expect(sharingOffDoorAllows('GET', DOOR, CARD)).toBe(false);
    expect(sharingOffDoorAllows('POST', '/sharing-off', CARD)).toBe(false);
    expect(sharingOffDoorAllows('GET', '/workspaces/w-harbor', CARD)).toBe(false);
    expect(sharingOffDoorAllows('POST', DOOR, undefined)).toBe(false);
  });
});

describe('the sharing-off page', () => {
  it("shows the card's words escaped and posts its Approve to the door", () => {
    const { html, headers } = renderSharingOffPage({
      enabled: false,
      card: {
        path: DOOR,
        change: { op: 'sharing-on', workspaceId: 'w-harbor' },
        headline: 'Turns sharing back on',
        detail: 'Bob said <b>"hi"</b>.\n\n- **A mistake:** Approve.',
      },
    });
    expect(html).toContain(`data-path="${DOOR}"`);
    expect(html).toContain('Bob said &#60;b&#62;&#34;hi&#34;&#60;/b&#62;.');
    expect(html).toContain('<li><b>A mistake:</b> Approve.</li>');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("script-src 'nonce-");
  });

  it('offers no button when sharing is on or no card is open', () => {
    expect(renderSharingOffPage({ enabled: true }).html).not.toContain('id="on"');
    expect(renderSharingOffPage({ enabled: false }).html).toContain('Turn it on from this machine');
  });
});
