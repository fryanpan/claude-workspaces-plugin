/**
 * The presence room on a page outside the board: the review queue or the
 * workspaces list, for the length of a follow (`carried-follow.ts`). It draws
 * no chips and shows nothing in place, so the next move the followed agent or
 * person makes opens that page.
 */
import { connect } from '@claude-workspaces/core';
import { ensureUserIdentity } from '../identity-prompt.ts';
import { joinPagePresence } from './page-presence.ts';

export async function joinOffBoard(
  workspaceId: string,
  address: string,
  win: Window,
): Promise<void> {
  const { localStorage: local, sessionStorage, location } = win;
  // Not where anybody is asked their name.
  const user = await ensureUserIdentity(
    null,
    { get: (k) => local.getItem(k), set: (k, v) => local.setItem(k, v) },
    { suppressNamePrompt: true },
  );
  joinPagePresence({
    workspaceId,
    user,
    here: { surface: 'board', path: address },
    connect,
    origin: location,
    host: null,
    // The address the follow arrived at, whatever the page made of it since.
    address: () => address,
    go: (href) => location.assign(href),
    show: () => {},
    storage: sessionStorage,
    inputTarget: win,
  });
}
