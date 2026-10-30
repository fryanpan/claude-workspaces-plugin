/**
 * The scripts a mock's host page loads over the frame for its owner — the
 * coach's card and the lead chat — and never for a share visitor.
 */
import { describe, expect, it } from 'bun:test';
import { renderMockHost } from '../src/mockup-frame.ts';

describe('the mock host page', () => {
  it("loads the coach's card and the lead chat over the owner's mock, naming its board and doc, and never a visitor's", () => {
    const args = {
      workspaceId: 'w-harbor',
      docId: 'd-mock',
      html: '<html><head><title>Harborlight mock</title></head><body></body></html>',
      url: new URL('http://b.test/workspaces/w-harbor/mockups/d-mock'),
      items: [],
      coachHref: '/app/coach-0123456789abcdef.js',
      leadChatHref: '/app/lead-chat-0123456789abcdef.js',
    };
    const [owner, visitor] = [false, true].map((v) => renderMockHost({ ...args, visitor: v }));
    for (const name of ['coach', 'lead-chat']) {
      expect(owner).toContain(
        `<script type="module" src="/app/${name}-0123456789abcdef.js" data-${name}-page data-workspace-id="w-harbor" data-doc-id="d-mock"></script>`,
      );
      expect(visitor).not.toContain(name);
    }
  });
});
