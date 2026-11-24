/**
 * A doc page holds one event stream per channel, however many parts of it
 * listen.
 *
 * Over HTTP/1.1 a browser keeps about six connections per host across all of
 * its tabs, and an SSE stream holds one for as long as the page is open. A doc
 * page has four readers of its board's channel (the lead chat, the star, the
 * plan gate and the task-link chips), and in a set the sidebar reads the set's
 * channel too. Before the plan gate and the chips joined `board-stream.ts`,
 * this page held three streams on the board's channel, each one connection
 * taken from every other tab on the board. This boots the real doc page and
 * counts what it opened.
 *
 * Each case also sends a frame down the one stream and checks every moved
 * reader still acts on it, because a shared handle that dropped a listener
 * would pass the count and leave the page stale.
 *
 * All fixtures synthetic apart from the shell itself.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { type AppBootEnv, bootApp } from '../src/app.ts';
import { _resetLinkTitlesForTest } from '../src/link-titles.ts';
import {
  FakeEventSource,
  type FakeServer,
  fakeLocation,
  fakeSockets,
  fakeStorage,
  installFakeBeacon,
  installFakeServer,
  settle,
} from './boot-harness.ts';

const server: FakeServer = installFakeServer();
installFakeBeacon();

/** Every stream the page opened, and every event name a reader added to it. */
class CountingSource extends FakeEventSource {
  static all: CountingSource[] = [];
  readonly heard = new Set<string>();
  constructor(url: string) {
    super(url);
    CountingSource.all.push(this);
  }
  override addEventListener(
    type: string,
    fn: EventListenerOrEventListenerObject | null,
    opts?: AddEventListenerOptions | boolean,
  ): void {
    this.heard.add(type);
    super.addEventListener(type, fn, opts);
  }
}
(globalThis as { EventSource?: unknown }).EventSource = CountingSource;

/**
 * A board and a set per case. The page's shared streams live for the page,
 * and the lead chat a boot mounts is never torn down (it is once per page), so
 * a second case on the same channel would join the first case's stream and
 * open nothing.
 */
let WS = '';
let SET = '';
let boards = 0;
const channel = (id: string) => `/workspaces/${id}/events:stream`;
const taskUrl = () => `/workspaces/${WS}?task=t-9`;

/** The shipped shell, scripts cut (see app-boot.test.ts). */
const SHELL = (() => {
  const html = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
  const open = html.indexOf('<body');
  const start = html.indexOf('>', open) + 1;
  return html.slice(start, html.indexOf('</body>')).replace(/<script\b[\s\S]*?<\/script>/g, '');
})();

const booted: Array<() => void> = [];

/** Boot the doc page, sync a doc with a task link in it, and return. */
async function boot(docId: string, ymeta: Record<string, string> = {}): Promise<void> {
  const url = `https://docs.test/workspaces/${WS}/docs/${encodeURIComponent(docId)}`;
  document.body.innerHTML = SHELL;
  history.replaceState(null, '', new URL(url).pathname);
  const sockets = fakeSockets();
  const env: AppBootEnv = {
    document,
    location: fakeLocation(url),
    localStorage: fakeStorage({ 'feedback-user-name': 'Ada' }),
    window: new EventTarget(),
    connect: sockets.connect,
  };
  booted.push(await bootApp(env));
  await settle();
  const client = sockets.first();
  for (const [k, v] of Object.entries(ymeta)) client.ydoc.getMap('meta').set(k, v);
  const para = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, 'Tracked in the strip task', { link: { href: taskUrl() } });
  para.insert(0, [text]);
  client.ydoc.getXmlFragment('prose').insert(0, [para]);
  client.sync();
}

/** Until every reader named has added its listener to some stream. */
async function readersWired(events: string[]): Promise<void> {
  await vi.waitFor(
    () => {
      const heard = new Set(CountingSource.all.flatMap((s) => [...s.heard]));
      for (const e of events) expect(heard, e).toContain(e);
    },
    { timeout: 10_000, interval: 5 },
  );
}

/** How many streams the page opened for each board or set channel. The
 *  coach card's stream is a channel of its own, and not counted here. */
function boardStreams(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of CountingSource.all) {
    if (s.url.startsWith('/workspaces/')) out[s.url] = (out[s.url] ?? 0) + 1;
  }
  return out;
}

/** The one stream on a channel, after the count has said there is one. */
function stream(url: string): CountingSource {
  const s = CountingSource.all.find((x) => x.url === url);
  if (!s) throw new Error(`nothing opened ${url}`);
  return s;
}

const count = (pred: (c: { url: string; method: string }) => boolean): number =>
  server.calls.filter(pred).length;
const linkLookups = () => count((c) => c.method === 'POST' && c.url.includes('links:titles'));
const recordReads = () => count((c) => c.method === 'GET' && c.url.includes('format=json'));

/** Each reader the move touched, by an event only it listens for. */
const PLAN_GATE = 'task.created';
const CHIPS = 'review_item.added';
const SET_SIDEBAR = 'attachments.changed';
const STAR = 'library.changed';
const LEAD_CHAT = 'lead-chat.changed';

beforeAll(async () => {
  await import('../src/doc/markdown-mount.ts');
}, 60_000);

beforeEach(() => {
  CountingSource.all = [];
  _resetLinkTitlesForTest();
  server.reset();
  server.on('/api/auth/session', { authenticated: false, canWrite: true });
  WS = `w-${++boards}`;
  SET = `rev-${boards}`;
  server.on(`/workspaces/${WS}/links:titles`, {
    titles: { [taskUrl()]: 'The strip task' },
    statuses: { [taskUrl()]: 'todo' },
  });
});

afterEach(() => {
  for (const stop of booted.splice(0)) stop();
  document.body.innerHTML = '';
  document.body.className = '';
  history.replaceState(null, '', '/');
});

describe('a doc page', () => {
  it(
    'opens one stream for its board, and every reader still hears it',
    { timeout: 30_000 },
    async () => {
      server.on(`/workspaces/${WS}/docs/`, {
        meta: { type: 'markdown', relPath: 'notes.md', planState: 'pending' },
        // The board the doc sits on, which is what the chips follow.
        backTo: { workspaceId: WS, name: 'Harborlight' },
        tasks: [{ planHeld: true, workspaceId: WS }],
      });
      await boot('d-notes');
      await readersWired([PLAN_GATE, CHIPS, STAR, LEAD_CHAT]);
      expect(boardStreams()).toEqual({ [channel(WS)]: 1 });

      // A change made elsewhere: a task moves, and a review item is filed.
      const board = stream(channel(WS));
      await vi.waitFor(() => expect(linkLookups()).toBeGreaterThan(0));
      const reads = recordReads();
      const lookups = linkLookups();
      board.dispatchEvent(new MessageEvent('task.transitioned', { data: '{}' }));
      board.dispatchEvent(new MessageEvent(CHIPS, { data: '{}' }));
      // The plan gate re-reads the doc's record; the chips re-ask their links.
      await vi.waitFor(() => expect(recordReads()).toBeGreaterThan(reads));
      await vi.waitFor(() => expect(linkLookups()).toBeGreaterThan(lookups));
    },
  );
});

describe('a doc page inside a set', () => {
  it(
    "opens one stream for the board and one for the set, and the sidebar hears the set's",
    { timeout: 30_000 },
    async () => {
      server.on(`/workspaces/${WS}/docs/`, {
        meta: { type: 'markdown', relPath: 'notes.md', workspaceId: SET, planState: 'pending' },
        // The board the doc sits on, which is what the chips follow.
        backTo: { workspaceId: WS, name: 'Harborlight' },
        tasks: [{ planHeld: true, workspaceId: WS }],
      });
      server.on(`/workspaces/${WS}/attachments/${SET}/grouped`, { groups: [] });
      server.on(`/workspaces/${WS}/attachments/${SET}/files`, {
        files: [{ docId: `${SET}:notes.md`, relPath: 'notes.md', status: 'modified' }],
      });
      await boot(`${SET}:notes.md`, { workspaceId: SET });
      await readersWired([PLAN_GATE, CHIPS, SET_SIDEBAR, STAR, LEAD_CHAT]);
      expect(boardStreams()).toEqual({ [channel(WS)]: 1, [channel(SET)]: 1 });

      // A file joins the set elsewhere: the sidebar re-reads its list.
      const asked = () => count((c) => c.url.includes(`/attachments/${SET}/`));
      await vi.waitFor(() => expect(asked()).toBeGreaterThan(0));
      const before = asked();
      stream(channel(SET)).dispatchEvent(new MessageEvent(SET_SIDEBAR, { data: '{}' }));
      await vi.waitFor(() => expect(asked()).toBeGreaterThan(before));
    },
  );
});
