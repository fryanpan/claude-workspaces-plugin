/**
 * The lead chat on a page that holds a frame it cannot draw into: a mock, an
 * HTML attachment or a dev server, shown sandboxed inside the host page
 * (`mockup-frame.ts` on the server). The host loads this with the board and
 * doc it is showing, and never for a share visitor; the chat draws its button
 * only for the board's owner.
 *
 * Its own entry, like `coach-page.ts`: the host page carries no app bundle.
 * It also joins the board's presence room, so a follow that leads here keeps
 * going, and a message sent here names the section and thread open in the
 * frame.
 */
import { connect } from '@claude-workspaces/core';
import { ensureUserIdentity } from './identity-prompt.ts';
import { mountLeadChat } from './lead-chat/lead-chat-mount.ts';
import { followMockTabTitle } from './mock-tab-title.ts';
import { joinMockPresence, mockHere } from './presence/mock-presence.ts';

const tag = document.querySelector<HTMLScriptElement>('script[data-lead-chat-page]');
const workspaceId = tag?.dataset.workspaceId;
const docId = tag?.dataset.docId;
if (workspaceId) {
  // The tab's title follows a rename of the board or the doc; same pages.
  if (docId) void followMockTabTitle({ workspaceId, docId, docTitle: tag?.dataset.docTitle ?? '' });
  const storage = {
    get: (k: string) => localStorage.getItem(k),
    set: (k: string, v: string) => localStorage.setItem(k, v),
  };
  // The host page is not where anybody is asked their name: the signed-in
  // identity, or the one this browser already chose.
  void ensureUserIdentity(null, storage, { suppressNamePrompt: true }).then((user) => {
    // The button sits in the nav's dock, never over the frame: floated, it
    // covered the frame's comment Cancel at 1100px and under.
    const dock = document.querySelector('.cw-host-nav > .board-nav-dock');
    const host = dock ? document.createElement('span') : null;
    if (host) dock?.append(host);
    mountLeadChat({
      ...(host ? { dock: host } : {}),
      workspaceId,
      author: { id: user.id, name: user.name, kind: user.kind },
      getContext: () => {
        if (!docId) return undefined;
        const { heading, threadId } = mockHere();
        return {
          surface: 'doc',
          docId,
          ...(heading ? { visibleHeading: heading } : {}),
          ...(threadId ? { threadId } : {}),
        };
      },
      openThread: () => mockHere().threadId ?? null,
    });
    // A mock's or an app's page is in the board's presence room, so a follow
    // carries on here (`presence/mock-presence.ts`).
    if (docId) {
      joinMockPresence({
        workspaceId,
        docId,
        user,
        connect,
        win: window,
        frame: () => document.querySelector<HTMLIFrameElement>('iframe[data-cw-mock-frame]'),
        ...(location.pathname.includes('/apps/') ? { path: location.pathname } : {}),
      });
    }
  });
}
