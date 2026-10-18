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
 */
import { mountCoachCard } from './coach-card.ts';
import { startCoach } from './landing-coach.ts';
import { startInbox } from './landing-inbox.ts';
import { startLandingLive } from './landing-live.ts';
import './meeting-banner.ts';

if (document.querySelector('#coach')) mountCoachCard({ page: 'home' });
startCoach();
startInbox();
startLandingLive();
if (document.querySelector('claude-feedback-widget')) {
  void import('./board/board-feedback-mic.ts').then((m) => m.mountFeedbackWidget(document));
}
