/**
 * The two dispatch frames, and which of them an agent is allowed to see.
 *
 * A builder's closing report is the one event of the pair a person acts on, so
 * it renders as a line naming the build, the gate tally and how many done-when
 * lines were met — leading with the failure count when a gate went red. Its
 * twin, the lead's own request for a lane, renders as nothing at all, and
 * neither does a report relayed back to the session that filed it.
 *
 * All fixtures synthetic. Nothing here opens a socket or touches a real
 * server.
 */
import { describe, expect, it } from 'vitest';
import { harness, only } from './channel-harness.ts';

describe('the dispatch pair', () => {
  /** One report, as the server broadcasts it. */
  const reported = (over: Record<string, unknown> = {}) => ({
    workspaceId: 'w-1',
    taskId: 't-7',
    agentName: 'harborlight-builder',
    prNumber: 1104,
    headCommit: '274ebd28002854a3c5ece616526f504e3169a12c',
    checksTotal: 31,
    checksFailed: 0,
    checksHeld: 2,
    doneWhenTotal: 5,
    doneWhenMet: 3,
    actor: { id: 'agent-saltmarsh', name: 'Saltmarsh' },
    ...over,
  });

  it('renders a closing report as one line naming the build and what is left', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('dispatch.reported', reported());
    const f = only(frames);
    expect(f.content).toContain('harborlight-builder');
    expect(f.content).toContain('t-7');
    expect(f.content).toContain('PR #1104');
    // Abbreviated: the frame is one line, the record holds the full sha.
    expect(f.content).toContain('274ebd2');
    expect(f.content).not.toContain('274ebd28002854');
    // A held gate is neither a pass nor a failure and is counted separately —
    // an honest local run has two, and folding them in would read as red.
    expect(f.content).toContain('31 gates passed (2 held)');
    expect(f.content).toContain('3/5 done-when met');
    expect(f.meta).toMatchObject({
      workspace_id: 'w-1',
      task_id: 't-7',
      event: 'dispatch.reported',
    });
  });

  it('leads with the failure when a gate went red', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('dispatch.reported', reported({ checksFailed: 2 }));
    expect(only(frames).content).toContain('2 of 31 gates FAILED');
  });

  it('never relays the lead’s own request for a lane', async () => {
    // The server keeps `dispatch.requested` off the workspace stream; this is
    // the belt to that suspender, so a replayed or older-server frame costs
    // this session no turn.
    const { frames, messages } = harness();
    await messages.emitChannelMessage('dispatch.requested', {
      workspaceId: 'w-1',
      taskId: 't-7',
      outcome: 'registered',
    });
    expect(frames).toHaveLength(0);
  });

  it('never relays a report back to the session that filed it', async () => {
    const { frames, messages } = harness({ authorId: 'agent-saltmarsh' });
    await messages.emitChannelMessage('dispatch.reported', reported());
    expect(frames).toHaveLength(0);
  });
});
