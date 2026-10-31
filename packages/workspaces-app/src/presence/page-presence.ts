/**
 * A doc or whiteboard page in the workspace's presence room: it says where
 * its person is, draws who else is here with the board's own chips, and
 * follows whoever the reader long-presses.
 *
 * The page joins the BOARD's room on a presence-only socket
 * (`/workspaces/<ws>/y?presence=1`): the board's awareness, none of its
 * content. So a board page, a doc page and a whiteboard page all hear each
 * other within one awareness round trip.
 */
import type { FeedbackClient } from '@claude-workspaces/core';
import { PERSON_SPOT_FIELD, type PresenceSpot } from '@claude-workspaces/core/workspace-presence';
import { mountPresenceIsland, presenceData } from '../board/presence-island.tsx';
import { boardSocketUrl } from '../doc-path.ts';
import { roomChips } from './follow-model.ts';
import { type FollowStorage, type Follower, createFollower, stopOnOwnInput } from './follower.ts';

export interface PagePresenceDeps {
  workspaceId: string;
  user: { id: string; name: string; color?: string };
  /** Where the page opened. */
  here: PresenceSpot;
  connect: (url: string) => FeedbackClient;
  origin: { protocol: string; host: string };
  /** The element the chips render into (it gets the board's strip classes). */
  host: HTMLElement;
  address: () => string;
  go: (href: string) => void;
  show: (spot: PresenceSpot) => void;
  storage: FollowStorage;
  /** Where the reader's own input is heard; the window on a page. */
  inputTarget: Pick<EventTarget, 'addEventListener'>;
  /** A short notice — the board's toast says the same words. */
  notify?: (text: string) => void;
}

export interface PagePresence {
  client: FeedbackClient;
  follower: Follower;
  /** The person's spot moved on this page, or the page changed. */
  moveTo(spot: PresenceSpot): void;
  close(): void;
}

/** Room presence is a socket's worth of state, so a spot is sent at most this often. */
const SPOT_MS = 150;

export function joinPagePresence(deps: PagePresenceDeps): PagePresence {
  const client = deps.connect(`${boardSocketUrl(deps.origin, deps.workspaceId)}&presence=1`);
  const { awareness } = client;
  let here = deps.here;
  const announce = (): void => {
    awareness.setLocalState({
      user: { id: deps.user.id, name: deps.user.name, color: deps.user.color },
      surface: here.surface,
      ...(here.docId ? { docId: here.docId } : {}),
      [PERSON_SPOT_FIELD]: here,
      lastActive: Date.now(),
    });
  };
  announce();

  const follower = createFollower({
    room: awareness,
    workspaceId: deps.workspaceId,
    here: () => here,
    address: deps.address,
    go: deps.go,
    show: deps.show,
    storage: deps.storage,
    onChange: () => paint(),
  });
  const paint = (): void => {
    presenceData.value = {
      chips: roomChips(awareness.getStates(), awareness.clientID),
      followedKey: follower.key(),
    };
  };
  deps.host.classList.add('board-presence', 'board-people');
  const unmount = mountPresenceIsland(
    deps.host,
    {
      // A tap goes there once; a long-press keeps going there.
      onTap: (chip) => follower.jump(chip.key),
      onLongPress: (chip) => {
        const next = follower.key() === chip.key ? null : chip.key;
        follower.follow(next);
        deps.notify?.(
          next ? `Following ${chip.label} — long-press again to stop` : 'Stopped following',
        );
      },
      onOverflow: (hidden) => deps.notify?.(`Also here: ${hidden.map((c) => c.label).join(', ')}`),
    },
    { compact: true },
  );
  awareness.on('change', paint);
  paint();
  stopOnOwnInput(deps.inputTarget, follower, (el) =>
    el instanceof Element ? deps.host.contains(el) : false,
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    client,
    follower,
    moveTo(spot) {
      const pageChanged = spot.surface !== here.surface || spot.docId !== here.docId;
      here = spot;
      if (pageChanged) {
        announce();
        follower.refresh();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        announce();
      }, SPOT_MS);
    },
    close() {
      if (timer) clearTimeout(timer);
      unmount();
      client.close();
    },
  };
}
