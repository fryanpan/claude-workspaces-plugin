/**
 * The tab title of a mock's host page: the board's name first, then the
 * doc's title or else the mock's own, so several boards open at once can be
 * told apart in the tab strip.
 */
import { describe, expect, it } from 'bun:test';
import { renderMockHost } from '../src/mockup-frame.ts';

describe('the mock host page title', () => {
  it("titles the tab with the board's name, then the doc's title or else the mock's", () => {
    const args = {
      workspaceId: 'w-stand',
      docId: 'd-mock',
      html: '<title>Moorings</title>',
      url: new URL('http://b.test/workspaces/w-stand/mockups/d-mock'),
      items: [],
      visitor: false,
      leadChatHref: '/app/lead-chat.js',
    };
    const named = renderMockHost({ ...args, workspaceName: 'Harborlight', docTitle: 'Tides "<b>' });
    expect(named).toContain('<title>Harborlight · Tides "&lt;b> · Workspaces</title>');
    // The page's script keeps it current, starting from the same name.
    expect(named).toContain('data-doc-title="Tides &quot;&lt;b&gt;"');
    expect(renderMockHost({ ...args, workspaceName: 'Harborlight' })).toContain(
      '<title>Harborlight · Moorings · Workspaces</title>',
    );
  });
});
