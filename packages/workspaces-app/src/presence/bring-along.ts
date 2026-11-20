/**
 * A tab opened by somebody other people are following offers to bring them
 * along (M10).
 *
 * A follow goes to the newest of the followed person's tabs that leads
 * (`LEADS_FIELD`, `follow-model.ts`). Without this, opening a second tab to
 * look something up would drag every follower there. So a page starts with
 * `leads: false`, and once its room has synced it decides:
 *
 *   - none of its person's other tabs is open, or nobody follows them: it
 *     leads, and nothing is shown;
 *   - otherwise it offers, naming who follows. "Bring them here" makes it
 *     lead, and the followers come to it; "Not now" leaves them with the
 *     other tab.
 *
 * Which tabs are this person's: the server writes `user` over what a page
 * announces, so a page cannot read its own name off the room. The tabs of
 * one browser share `localStorage`, so each page lists its awareness client
 * id there, and a listed id still in the room is another tab of this
 * person's. Followers are the states whose `FOLLOWING_FIELD` names that
 * tab's participant key, the key every page's strip uses.
 */
import { FOLLOWING_FIELD } from '@claude-workspaces/core/workspace-presence';
import { presenceIdentity } from '../board/board-presence-model.ts';
import { peopleFromStates } from './follow-model.ts';
import type { FollowRoom } from './follower.ts';

export interface BringAlongStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BringAlongDeps {
  room: FollowRoom;
  workspaceId: string;
  /** Shared by this browser's tabs: `localStorage` on a page. */
  storage: BringAlongStorage;
  /** Announce whether this tab takes its person's followers. */
  setLeads: (leads: boolean) => void;
  /** Show the offer naming who follows, or take it down with null. */
  onOffer: (names: string[] | null) => void;
}

export interface BringAlong {
  /** The room has synced: decide. Called once, by the page. */
  ready(): void;
  /** Bring the followers to this tab. */
  accept(): void;
  /** Leave them where they are. */
  dismiss(): void;
  /** The page is going: take this tab off the list. */
  close(): void;
}

/** The tabs a browser keeps listed per board, newest last. */
const MAX_TABS = 24;
export const tabsStorageKey = (workspaceId: string): string => `cw-tabs:${workspaceId}`;

function readTabs(storage: BringAlongStorage, key: string): number[] {
  try {
    const v = JSON.parse(storage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((n): n is number => Number.isSafeInteger(n)) : [];
  } catch {
    return [];
  }
}

/** The names of the people following the person whose other tabs are
 *  `mine`, one per person. */
export function followersOf(
  states: Map<number, unknown>,
  selfClientId: number,
  mine: ReadonlySet<number>,
): string[] {
  const people = peopleFromStates(states, selfClientId);
  const keys = new Set(
    people.filter((p) => mine.has(p.clientId)).map((p) => `p-${presenceIdentity(p)}`),
  );
  const names = new Map<string, string>();
  for (const p of people) {
    if (p.self || mine.has(p.clientId)) continue;
    const following = (states.get(p.clientId) as Record<string, unknown> | undefined)?.[
      FOLLOWING_FIELD
    ];
    if (typeof following !== 'string' || !keys.has(following)) continue;
    if (keys.has(`p-${presenceIdentity(p)}`)) continue;
    names.set(presenceIdentity(p), p.name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

/** The offer's line: who is following. */
export function offerText(names: readonly string[]): string {
  const [first = '', second = ''] = names;
  if (names.length <= 1) return `${first} is following you`;
  if (names.length === 2) return `${first} and ${second} are following you`;
  return `${first} and ${names.length - 1} others are following you`;
}

export function createBringAlong(deps: BringAlongDeps): BringAlong {
  const key = tabsStorageKey(deps.workspaceId);
  const self = deps.room.clientID;
  deps.storage.setItem(
    key,
    JSON.stringify(
      [...readTabs(deps.storage, key).filter((id) => id !== self), self].slice(-MAX_TABS),
    ),
  );
  let phase: 'waiting' | 'offered' | 'leading' | 'declined' = 'waiting';
  let shown = '';

  const show = (names: string[] | null): void => {
    const sig = names ? names.join('\n') : '';
    if (sig === shown) return;
    shown = sig;
    deps.onOffer(names);
  };
  const lead = (): void => {
    phase = 'leading';
    show(null);
    deps.setLeads(true);
  };
  const decide = (): void => {
    if (phase !== 'waiting' && phase !== 'offered') return;
    const states = deps.room.getStates();
    const mine = new Set(readTabs(deps.storage, key).filter((id) => id !== self && states.has(id)));
    const names = mine.size ? followersOf(states, self, mine) : [];
    // Nobody would come along, or nobody is left to leave behind.
    if (!names.length) {
      lead();
      return;
    }
    phase = 'offered';
    show(names);
  };
  deps.room.on('change', () => {
    if (phase === 'offered') decide();
  });

  return {
    ready() {
      if (phase === 'waiting') decide();
    },
    accept() {
      if (phase === 'offered' || phase === 'declined') lead();
    },
    dismiss() {
      if (phase !== 'offered') return;
      phase = 'declined';
      show(null);
    },
    close() {
      deps.storage.setItem(
        key,
        JSON.stringify(readTabs(deps.storage, key).filter((id) => id !== self)),
      );
    },
  };
}

/**
 * The offer, as a steady bar where the Following bar sits, so it moves
 * nothing on the page. Returns the function that shows or removes it.
 */
export function mountBringAlongOffer(
  doc: Document,
  actions: { accept: () => void; dismiss: () => void },
): (names: string[] | null) => void {
  let bar: HTMLElement | null = null;
  return (names) => {
    if (!names) {
      bar?.remove();
      bar = null;
      return;
    }
    if (!bar) {
      bar = doc.createElement('section');
      bar.className = 'board-follow-bar board-bring-along';
      bar.setAttribute('role', 'status');
      const text = doc.createElement('span');
      text.className = 'board-follow-text';
      text.append(doc.createElement('b'), doc.createElement('small'));
      (text.lastChild as HTMLElement).textContent = 'Bring them to this tab?';
      const button = (label: string, act: () => void, cls: string): HTMLButtonElement => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = label;
        b.addEventListener('click', act);
        return b;
      };
      bar.append(
        text,
        button('Bring them here', actions.accept, 'board-presence-act board-bring-along-yes'),
        button('Not now', actions.dismiss, 'board-presence-act board-bring-along-no'),
      );
      doc.body.append(bar);
    }
    const head = bar.querySelector('b');
    if (head) head.textContent = offerText(names);
  };
}
