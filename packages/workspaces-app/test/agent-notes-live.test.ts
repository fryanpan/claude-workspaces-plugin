/**
 * Home's "Not on a task" list catching up with no reload, at the wiring.
 *
 * An unplaced note writes nothing to the board, so no task changes and no
 * ydoc tick arrives. The server's only announcement is a wordless
 * `agent.noted` frame. If the boot does not listen for that name, the list
 * stays as it was when the page loaded, and every model and island test still
 * passes. This boots the real board on Home against the fake server, changes
 * the route's answer, pushes the frame, and reads the pane. The same path
 * end to end, a real server and a real browser, is
 * `agent-notes-live-browser.test.ts`.
 *
 * Names are invented — the repo is public.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeEventSource, settle } from './boot-harness.ts';
import { WS, bootTestBoard, resetBoardServer, server } from './support/board-drive.ts';

const agentsShown = () =>
  [...document.querySelectorAll<HTMLElement>('.acti-agent-group')].map((g) => g.dataset.agent);

const riverbend = (at: number) => ({
  workspaceId: WS,
  since: 0,
  agents: [
    {
      agent: 'Riverbend',
      placement: 'unattachable',
      latestAt: at,
      notes: [{ at, kind: 'turn', text: 'Parked on the retention call.' }],
      more: 0,
    },
  ],
});

const push = () =>
  FakeEventSource.last().dispatchEvent(
    Object.assign(new Event('agent.noted'), {
      data: JSON.stringify({ event: 'agent.noted', workspaceId: WS }),
    }),
  );

beforeEach(() => {
  resetBoardServer();
});

describe('the Not on a task list on a live board', () => {
  it('re-reads the list when the server says a note went unplaced', async () => {
    server.on(`/workspaces/${WS}/agent-notes`, { workspaceId: WS, since: 0, agents: [] });
    await bootTestBoard({ url: `https://board.test/workspaces/${WS}/home` });
    expect(agentsShown()).toEqual([]);

    server.on(`/workspaces/${WS}/agent-notes`, riverbend(Date.now()));
    push();
    await settle();

    expect(agentsShown()).toEqual(['Riverbend']);
  });

  it('reads it on Home’s first load', async () => {
    server.on(`/workspaces/${WS}/agent-notes`, riverbend(Date.now()));
    await bootTestBoard({ url: `https://board.test/workspaces/${WS}/home` });
    expect(agentsShown()).toEqual(['Riverbend']);
  });
});
