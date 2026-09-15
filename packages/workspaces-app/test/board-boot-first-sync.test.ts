/**
 * The board doc opens first, and nothing on the way to the task list waits on
 * a question the list does not need answered.
 *
 * Measured through a 120ms-RTT proxy, the list appeared after eight round
 * trips of preamble and one of payload: the session was asked twice in
 * series, the workspace record after that, and only then the socket. These
 * drive the real boot with a session route that does not answer until the
 * test says so, which is a slow link without a clock.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootBoard } from '../src/board/board-app.ts';
import type { BoardTask } from '../src/board/board-model.ts';
import { WRITE_ACCESS_LOOKUP_MS } from '../src/signin/write-gate.ts';
import {
  type FakeServer,
  type FakeSockets,
  fakeHistory,
  fakeLocation,
  fakeSockets,
  fakeStorage,
  installFakeBeacon,
  installFakeEventSource,
  installFakeServer,
  settle,
} from './boot-harness.ts';

const server: FakeServer = installFakeServer();
installFakeEventSource();
installFakeBeacon();

const WS = 'w-harbor';
const NOW = 1_700_000_000_000;

function row(id: string, title: string): BoardTask {
  return {
    id,
    title,
    status: 'todo',
    assignee: 'Kiln',
    goal: 'g-1',
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function seed(sockets: FakeSockets): void {
  const client = sockets.first();
  client.ydoc.transact(() => {
    const ws = client.ydoc.getMap('workspace');
    ws.set('id', WS);
    ws.set('name', 'Harborlight');
    ws.set('createdAt', NOW);
    ws.set('goals', [{ id: 'g-1', title: 'Open the Saltmarsh pier' }]);
    client.ydoc.getMap('tasks').set('t-1', row('t-1', 'Survey the pilings'));
  });
}

function start(sockets: FakeSockets): Promise<void> {
  document.body.innerHTML = '<div id="board-root"></div>';
  return bootBoard({
    document,
    location: fakeLocation(`https://board.test/workspaces/${WS}/tasks`),
    history: fakeHistory(),
    localStorage: fakeStorage({ 'feedback-user-name': 'Kiln' }),
    window: new EventTarget(),
    connect: sockets.connect,
  });
}

const asked = (path: string): number => server.calls.filter((c) => c.url.startsWith(path)).length;

beforeEach(() => {
  server.reset();
  server.on('/api/auth/session', { authenticated: false, canWrite: true });
  server.on(`/workspaces/${WS}`, {
    workspace: { id: WS, name: 'Harborlight', goals: [], createdAt: NOW },
  });
  server.on(`/workspaces/${WS}/agents`, { agents: [] });
  server.on(`/workspaces/${WS}/review-items`, { items: [] });
  server.on(`/workspaces/${WS}/settings`, {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the board doc does not wait on the session', () => {
  it('opens the socket while the session answer is still out, and still raises the bar it brings', async () => {
    server.on('/api/auth/session', { authenticated: false, canWrite: false });
    const release = server.hold('/api/auth/session');
    const sockets = fakeSockets();
    const running = start(sockets);
    await settle();
    expect(asked('/api/auth/session')).toBe(1);
    expect(sockets.opened).toHaveLength(1);
    expect(sockets.opened[0]?.url).toContain(WS);
    // The sync can land before the page has painted anything.
    seed(sockets);
    sockets.first().sync();
    release();
    await running;
    await settle();
    // A refusal that arrives after the socket is still told: the socket was
    // never the gate, and the bar is what a signed-out person reads.
    expect(document.querySelector('.signin-bar')).not.toBeNull();
    // And the synced list is drawn, though it landed before the first paint.
    expect(document.getElementById('board')?.textContent).toContain('Survey the pilings');
  });

  it('asks the session route once for both the write answer and the identity', async () => {
    const sockets = fakeSockets();
    const running = start(sockets);
    await settle();
    seed(sockets);
    sockets.first().sync();
    await running;
    await settle();
    expect(asked('/api/auth/session')).toBe(1);
  });

  it('adopts a signed-in identity from that one read', async () => {
    server.on('/api/auth/session', {
      authenticated: true,
      canWrite: true,
      user: { id: 'user-riverbend', name: 'Riverbend Reviewer' },
    });
    const storage = fakeStorage({});
    const sockets = fakeSockets();
    document.body.innerHTML = '<div id="board-root"></div>';
    const running = bootBoard({
      document,
      location: fakeLocation(`https://board.test/workspaces/${WS}/tasks`),
      history: fakeHistory(),
      localStorage: storage,
      window: new EventTarget(),
      connect: sockets.connect,
    });
    await settle();
    seed(sockets);
    sockets.first().sync();
    await settle();
    // No name prompt, and the verified name is what storage now holds. Read
    // before awaiting the boot: a boot that missed the identity sits on the
    // prompt, and the assertion is what should say so.
    expect(document.querySelector('.identity-prompt')).toBeNull();
    expect(storage.values.get('feedback-user-name')).toBe('Riverbend Reviewer');
    await running;
  });

  it('paints after one lookup timeout when the session route never answers', async () => {
    // Held for good: the route hangs. The write gate and the identity lookup
    // each bound their wait, and sharing the read must not stack the bounds.
    vi.useFakeTimers();
    server.hold('/api/auth/session');
    const sockets = fakeSockets();
    void start(sockets);
    await vi.advanceTimersByTimeAsync(WRITE_ACCESS_LOOKUP_MS + 100);
    expect(document.getElementById('board')).not.toBeNull();
  });

  it('reads the workspace record while the session answer is still out', async () => {
    const release = server.hold('/api/auth/session');
    const sockets = fakeSockets();
    const running = start(sockets);
    await settle();
    expect(server.calls.some((c) => c.url.startsWith(`/workspaces/${WS}?format=json`))).toBe(true);
    release();
    seed(sockets);
    sockets.first().sync();
    await running;
  });
});

describe('the load report times the list on screen', () => {
  it('never stamps the first projection before the first paint, even when the sync beat it', async () => {
    // A clock that only moves forward one tick per read, so "before" and
    // "after" are distinguishable without depending on how fast this runs.
    let tick = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => ++tick);
    const release = server.hold('/api/auth/session');
    const sockets = fakeSockets();
    const running = start(sockets);
    await settle();
    seed(sockets);
    sockets.first().sync();
    release();
    await running;
    await settle();
    const report = server.calls.find((c) => c.url.includes('/load-reports'))?.body as
      | { msToBoot: number; msToFirstProjection?: number }
      | undefined;
    expect(report?.msToFirstProjection).toBeTypeOf('number');
    expect(report?.msToFirstProjection).toBeGreaterThan(
      report?.msToBoot ?? Number.POSITIVE_INFINITY,
    );
  });
});
