/**
 * The lead chat on the cross-board review (`/review`, Home's "Start review"):
 * the board page's own chat (`lead-chat/lead-chat-mount.ts`), its agent
 * button in the rail's dock, talking to the lead of the board the card on
 * screen is from. With no card, it talks to the plan board's lead — the one
 * that ranks the whole queue. Bryan, 30 Oct: "Agent button wasn't available
 * when I was in review queue looking at a review item."
 *
 * A mount is one board's conversation, so a card from another board means a
 * new mount. The new board's chat is read first and swapped in only once it
 * has answered: the old button stays until the new one can be drawn in the
 * same frame, so the button does not leave the dock and come back. An open
 * chat stays open across the swap, as it does between a board's pages
 * (`PANE_OPEN_KEY` in `lead-chat-meeting-wiring.ts`).
 *
 * Which boards a reader may talk to is not decided here. Each mount reads
 * and writes `/workspaces/<id>/lead-chat`, whose route answers `canTalk`
 * from the board's own owner check, and the button is drawn only when it
 * says yes.
 */
import { type LeadChatClient, createLeadChatClient } from '../lead-chat/lead-chat-client.ts';
import { type LeadChatMount, mountLeadChat } from '../lead-chat/lead-chat-mount.ts';
import type { VoiceContext } from '../voice-capture.ts';
import { type CrossEntry, crossItemHref } from './cross-walk-model.ts';

/** How long a new board's chat may take to answer before it is swapped in
 *  anyway, its button hidden until it does. */
const SWAP_DEADLINE_MS = 4000;

/** The board whose lead the chat talks to: the card's, else the plan
 *  board's, else none. */
export function leadChatBoard(
  current: Pick<CrossEntry, 'workspaceId'> | null,
  planWorkspaceId: string | null | undefined,
): string | null {
  return current?.workspaceId ?? planWorkspaceId ?? null;
}

/** What a message to the lead says the reader has open: the card's item,
 *  as the board's own context names it, with the item's link on its board. */
export function reviewItemContext(entry: CrossEntry | null): VoiceContext | undefined {
  const t = entry?.item.thread;
  if (!entry || !t) return undefined;
  const href = crossItemHref(entry);
  const link = href ? { link: href } : {};
  const threadId = entry.item.revision?.threadId ?? t.threadId;
  if (t.kind === 'task-review' && t.taskId) {
    return {
      surface: 'task',
      taskId: t.taskId,
      ...(t.reviewItemId ? { reviewItemId: t.reviewItemId } : {}),
      ...link,
    };
  }
  if (t.kind === 'task-thread' && t.taskId) {
    return { surface: 'task', taskId: t.taskId, ...(threadId ? { threadId } : {}), ...link };
  }
  if (t.kind === 'doc-thread' && t.docId) {
    return { surface: 'doc', docId: t.docId, ...(threadId ? { threadId } : {}), ...link };
  }
  return { surface: 'board', ...link };
}

export interface ReviewLeadChatOpts {
  /** The rail's dock; each board's button goes in a slot of its own here. */
  dock: HTMLElement;
  author: { id: string; name: string; kind?: string };
  document?: Document;
  /** Injected by tests. */
  createClient?: (workspaceId: string) => LeadChatClient;
  mount?: typeof mountLeadChat;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

export interface ReviewLeadChat {
  /** Talk about `entry`, the card on screen, to its board's lead — or, with
   *  no card, to the plan board's. */
  aim(entry: CrossEntry | null, planWorkspaceId: string | null): void;
  destroy(): void;
}

export function createReviewLeadChat(opts: ReviewLeadChatOpts): ReviewLeadChat {
  const doc = opts.document ?? document;
  const createClient =
    opts.createClient ?? ((workspaceId: string) => createLeadChatClient({ workspaceId }));
  const mount = opts.mount ?? mountLeadChat;
  const later = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

  let entry: CrossEntry | null = null;
  let shown: { workspaceId: string; host: HTMLElement; chat: LeadChatMount } | null = null;
  let pending: { workspaceId: string; client: LeadChatClient } | null = null;

  const unmount = (): void => {
    shown?.chat.destroy();
    shown?.host.remove();
    shown = null;
  };

  const swapIn = (workspaceId: string, client: LeadChatClient): void => {
    if (pending?.client !== client) return;
    pending = null;
    // The old chat goes first: its teardown resets the page's docked and
    // full-screen state, which the new one then sets for itself.
    unmount();
    const host = doc.createElement('span');
    opts.dock.append(host);
    const chat = mount({
      workspaceId,
      author: opts.author,
      dock: host,
      client,
      document: doc,
      // Only while the card is still this board's: a message never carries an
      // item from a board other than the one it is sent to.
      getContext: () =>
        entry?.workspaceId === workspaceId ? reviewItemContext(entry) : { surface: 'board' },
    });
    shown = { workspaceId, host, chat };
  };

  return {
    aim(next, planWorkspaceId) {
      entry = next;
      const workspaceId = leadChatBoard(next, planWorkspaceId);
      if (workspaceId === (pending?.workspaceId ?? shown?.workspaceId ?? null)) return;
      pending?.client.close();
      pending = null;
      if (workspaceId === null) {
        unmount();
        return;
      }
      if (workspaceId === shown?.workspaceId) return;
      const client = createClient(workspaceId);
      pending = { workspaceId, client };
      if (client.state().loaded) {
        swapIn(workspaceId, client);
        return;
      }
      client.onChange((s) => {
        if (s.loaded) swapIn(workspaceId, client);
      });
      later(() => swapIn(workspaceId, client), SWAP_DEADLINE_MS);
    },
    destroy() {
      pending?.client.close();
      pending = null;
      unmount();
    },
  };
}
