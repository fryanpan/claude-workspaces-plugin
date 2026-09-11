/**
 * A presence circle leaving a board that nobody reloaded.
 *
 * `presence-only-if-listening.test.tsx` pins the gate and the repaint against
 * the chrome region. What it cannot see is the half in front of it: the board
 * only re-reads its roster when a frame it is LISTENING FOR arrives, and an
 * agent's stream closing writes nothing to the store — no task changes, no
 * `agent.detached`, nothing. So if `agent.listening` is not one of the names
 * the boot subscribes to, the circle for a session that has gone sits there
 * until some unrelated change happens along, and every test above it still
 * passes.
 *
 * This boots the real board against the fake server and the fake feed, pushes
 * the frame the server now sends, and reads the strip. `resetBoardServer`
 * gives every other route its standard answer; only the roster is overridden,
 * and it is overridden twice — before the frame and after it — which is
 * exactly what a live server does when an agent's stream drops.
 *
 * Names are invented — the repo is public.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeEventSource } from './boot-harness.ts';
import { WS, bootTestBoard, el, resetBoardServer, server, settle } from './support/board-drive.ts';

const RIVERBEND = 'agent-riverbend';

/** The roster as the server answers it, for one reading of the wire. */
function rosterSays(listening: boolean): void {
  server.on(`/workspaces/${WS}/agents`, {
    workspaceId: WS,
    attachments: [
      {
        agentId: RIVERBEND,
        state: 'active',
        stateLabel: 'active',
        lastToolCallAt: 1,
        listening,
      },
    ],
  });
}

/** The agent circles only. The reader's own circle stays throughout, which is
 *  the control: an empty strip would also satisfy "the agent is gone". */
const agentCircles = () => [
  ...el('board-people').querySelectorAll('.board-presence-circle.board-presence-agent'),
];
const allCircles = () => [...el('board-people').querySelectorAll('.board-presence-circle')];

/** Push one server frame at the feed the boot wired. */
async function feed(event: string, data: unknown): Promise<void> {
  FakeEventSource.last().dispatchEvent(
    Object.assign(new Event(event), { data: JSON.stringify(data) }),
  );
  await settle();
}

beforeEach(() => {
  resetBoardServer();
});

describe('the board learns an agent stopped listening', () => {
  it('drops its circle on a live frame, with no reload', async () => {
    rosterSays(true);
    await bootTestBoard();
    expect(agentCircles().map((c) => c.getAttribute('aria-label'))).toEqual([
      expect.stringContaining(RIVERBEND),
    ]);

    // The subscription goes. The server's only announcement is this frame —
    // nothing is written, so nothing else would have woken the board.
    rosterSays(false);
    await feed('agent.listening', {
      event: 'agent.listening',
      workspaceId: WS,
      agentId: RIVERBEND,
      listening: false,
    });

    expect(agentCircles()).toHaveLength(0);
    // The reader is still here and still drawn: this was the agent leaving,
    // not the strip being wiped.
    expect(allCircles()).toHaveLength(1);
  });

  it('the frame is what does it — the same roster change goes unread without one', async () => {
    // The control. Without this case a subscription to some OTHER event, or a
    // poll on a timer, would pass the case above and the claim "the frame is
    // what carries it" would be untested.
    rosterSays(true);
    await bootTestBoard();
    expect(agentCircles()).toHaveLength(1);

    rosterSays(false);
    await settle();
    expect(agentCircles(), 'the board does not re-read on its own').toHaveLength(1);

    await feed('agent.listening', {
      event: 'agent.listening',
      workspaceId: WS,
      agentId: RIVERBEND,
      listening: false,
    });
    expect(agentCircles()).toHaveLength(0);
  });
});
