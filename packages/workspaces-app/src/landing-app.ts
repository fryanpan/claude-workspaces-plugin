/**
 * The landing page's only script. `/` is a server-rendered list of
 * workspaces and stays that way; this entry defines <meeting-banner>, which
 * the shell renders above the list, and wires "This week" and Incoming
 * Messages when the page carries them. When it carries "Your coach" (the
 * owner's alone), the coach's card shows here as on every board and doc. The review bar above the projects
 * needs no script: its groups are links. Its own bundle rather than a share of board.js because
 * the landing page must stay a few KB — the banner is self-styling (shadow
 * DOM) and needs none of the app CSS.
 *
 * The list redraws itself when any board changes (`landing-live.ts`).
 *
 * The owner's list also carries the Workspaces feedback widget the board
 * does (`renderLanding`). It is imported only when the shell rendered it,
 * as its own chunk, so the first chunk carries only the loader.
 *
 * And the board's chat with a lead (`lead-chat/lead-chat-mount.ts`), when
 * the bottom bar carries its dock: the plan board's lead, Bryan's default.
 * Its own chunk too, and the button is drawn only for a reader the board's
 * chat lets talk (`landing-nav.ts` on the server places the dock).
 */
import { mountCoachCard } from './coach-card.ts';
import { startCoach } from './landing-coach.ts';
import { startInbox } from './landing-inbox.ts';
import { startLandingLive } from './landing-live.ts';
import './meeting-banner.ts';
import { startPageLoadReport } from './page-load-report.ts';

// The list is server-rendered, so it is on screen by the time this module
// runs; the report's content stamp is the next frame. One report per load.
startPageLoadReport({ page: 'home', workspaceId: null }).contentShown();

if (document.querySelector('#coach')) mountCoachCard({ page: 'home' });
startCoach();
startInbox();
startLandingLive();
const leadDock = document.querySelector<HTMLElement>(
  '.home-nav > .board-nav-dock[data-lead-board]',
);
const leadBoard = leadDock?.dataset.leadBoard;
if (leadDock && leadBoard) {
  void Promise.all([import('./identity-prompt.ts'), import('./lead-chat/lead-chat-mount.ts')]).then(
    async ([{ ensureUserIdentity }, { mountLeadChat }]) => {
      // Home is not where anybody is asked their name: the signed-in identity,
      // or the one this browser already chose.
      const user = await ensureUserIdentity(
        null,
        { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) },
        { suppressNamePrompt: true },
      );
      const host = document.createElement('span');
      leadDock.append(host);
      mountLeadChat({
        workspaceId: leadBoard,
        author: { id: user.id, name: user.name, kind: user.kind },
        dock: host,
      });
    },
  );
}
if (document.querySelector('claude-feedback-widget')) {
  void import('./board/board-feedback-mic.ts').then((m) => m.mountFeedbackWidget(document));
}
