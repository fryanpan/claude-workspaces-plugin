/**
 * A mock's or an app's host page in the workspace's presence room, so a
 * follow does not end where one opens.
 *
 * The host page (`mockup-frame.ts` on the server) holds the mock in a
 * sandboxed frame it cannot reach into. So it says where its person is — on
 * this mock — and follows like a doc page does, but shows a followed spot
 * through the frame: a phrase or a scroll fraction is posted to the mock's
 * bridge (`packages/widget/src/mock-bridge.ts`, the `at` message), which
 * finds the words or scrolls there. A thread on the mock is opened the way
 * a link to it is, by loading the page at `?thread=`.
 *
 * The other way, the bridge reports what its person does inside the frame
 * (the `here` message): how far down, the section heading on screen, the
 * thread open. That is this person's spot, and a voice message's context.
 *
 * It draws no chips: the host page's bar has no room for them, and the
 * board's presence strip is where a follow is armed.
 */
import type { FeedbackClient } from '@claude-workspaces/core';
import type { PresenceSpot } from '@claude-workspaces/core/workspace-presence';
import { spotHref } from './follow-model.ts';
import { type PagePresence, joinPagePresence } from './page-presence.ts';

/** What the frame's bridge reads. Ids and words only; no secret. */
export interface MockAt {
  cw: 'at';
  quote?: string;
  scroll?: number;
}

export interface MockPresenceDeps {
  workspaceId: string;
  docId: string;
  user: { id: string; name: string; color?: string };
  connect: (url: string) => FeedbackClient;
  win: Pick<Window, 'location' | 'sessionStorage' | 'addEventListener'>;
  /** The mock's frame, or null before the host page drew it. */
  frame: () => HTMLIFrameElement | null;
  /** An app's page, which the doc's id alone does not name. */
  path?: string;
}

/** What the bridge says about its page. Anything the frame wrote is checked. */
interface MockHere {
  scroll?: number;
  heading?: string;
  threadId?: string;
}

function parseMockHere(raw: unknown): MockHere | null {
  const m = raw as { cw?: unknown; scroll?: unknown; heading?: unknown; thread?: unknown } | null;
  if (m?.cw !== 'here') return null;
  const scroll = typeof m.scroll === 'number' && m.scroll >= 0 && m.scroll <= 1 ? m.scroll : null;
  return {
    ...(scroll === null ? {} : { scroll }),
    ...(typeof m.heading === 'string' && m.heading ? { heading: m.heading.slice(0, 200) } : {}),
    ...(typeof m.thread === 'string' && /^[A-Za-z0-9:_.~-]{1,200}$/.test(m.thread)
      ? { threadId: m.thread }
      : {}),
  };
}

/** The message a spot on this mock posts to its frame, or null for none. */
export function mockAtMessage(spot: PresenceSpot): MockAt | null {
  if (spot.quote) return { cw: 'at', quote: spot.quote };
  if (spot.scroll !== undefined) return { cw: 'at', scroll: spot.scroll };
  return null;
}

/** The section and thread the person on a host page is at, as the frame last
 *  said. Read by the lead chat when a message is sent from this page. */
let inFrame: MockHere = {};
export const mockHere = (): Readonly<MockHere> => inFrame;

export function joinMockPresence(deps: MockPresenceDeps): PagePresence {
  const { location } = deps.win;
  const base: PresenceSpot = {
    surface: 'mock',
    docId: deps.docId,
    ...(deps.path ? { path: deps.path } : {}),
  };
  // The thread this page opened at; another one is a load.
  let shownThread = new URLSearchParams(location.search).get('thread');
  // The last spot shown, posted again when the frame (re)loads: a follow
  // that brought this page here applies before the mock has drawn.
  let pending: MockAt | null = null;
  const post = (): void => {
    const target = deps.frame()?.contentWindow;
    // The frame's origin is opaque, or the frame hostname's (mock-host.ts).
    if (pending && target) target.postMessage(pending, '*');
  };
  const frame = deps.frame();
  frame?.addEventListener('load', post);
  const presence = joinPagePresence({
    workspaceId: deps.workspaceId,
    user: deps.user,
    here: base,
    connect: deps.connect,
    origin: location,
    host: null,
    address: () => location.pathname + location.search,
    go: (href) => location.assign(href),
    show: (spot) => {
      if (spot.docId !== deps.docId) return;
      if (spot.threadId && spot.threadId !== shownThread) {
        shownThread = spot.threadId;
        location.assign(spotHref(deps.workspaceId, spot));
        return;
      }
      pending = mockAtMessage(spot);
      post();
    },
    storage: deps.win.sessionStorage,
    inputTarget: deps.win,
  });
  deps.win.addEventListener('message', (ev) => {
    if (ev.source !== deps.frame()?.contentWindow) return;
    const here = parseMockHere(ev.data);
    if (!here) return;
    inFrame = here;
    const { heading: _, ...place } = here;
    presence.moveTo({ ...base, ...place });
  });
  return presence;
}
