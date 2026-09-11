/**
 * Who the board says is PRESENT — the roster's `listening` flag and the push
 * that makes it change without a reload.
 *
 * Two halves, and the second is the one worth the runtime. The first pins the
 * pure module: a stamped row, an id that is not on the wire, and the frame
 * shape. The second drives the real thing — an agent attaches, opens the
 * stream its MCP child opens, and the roster says it is listening; the stream
 * closes and the roster says it is not, with a frame arriving on a browser's
 * own stream to say so. That pair is what "connected AND listening" means in
 * code, and the close half is the falsifiable one: nothing is written when a
 * stream dies, so without the push the board would keep drawing a session
 * that has gone.
 *
 * All fixtures are invented — the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_LISTENING_EVENT, agentListeningFrame } from '../src/agent-listening.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseBus } from '../src/sse.ts';
import { waitFor } from './wait-for.ts';

const RIVERBEND = 'agent-riverbend';
const HARBORLIGHT = 'agent-harborlight';
const SALTMARSH = 'agent-saltmarsh';

describe('agentListeningFrame', () => {
  it('carries the answer, not only the news', () => {
    expect(agentListeningFrame('w-1', RIVERBEND, false)).toEqual({
      event: AGENT_LISTENING_EVENT,
      workspaceId: 'w-1',
      agentId: RIVERBEND,
      listening: false,
    });
  });
});

type Frame = { event: string; data?: Record<string, unknown> };

/** Read an SSE response into a growing list of frames.
 *
 *  `stop` takes the AbortController rather than cancelling the reader: a
 *  cancelled reader leaves Bun's connection open, so the server's
 *  `ReadableStream.cancel` — the hook that unregisters the sink — never runs
 *  and the roster keeps reporting a stream nobody is holding. Aborting the
 *  fetch drops the socket, which is what a session exiting actually does. */
function listenFrames(
  res: Response,
  abort: AbortController,
): { frames: Frame[]; stop: () => Promise<void> } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          if (frame.event !== 'message') frames.push(frame);
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: async () => {
      stopped = true;
      abort.abort();
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

describe('the board roster, through the server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** The roster as the board reads it. */
  const roster = async (): Promise<Array<{ agentId: string; listening?: boolean }>> => {
    const res = await fetch(`${base}/workspaces/${workspaceId}/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachments: Array<{ agentId: string; listening?: boolean }>;
    };
    return body.attachments;
  };

  const listeningOf = async (agentId: string): Promise<boolean | undefined> =>
    (await roster()).find((a) => a.agentId === agentId)?.listening;

  /** The stream an agent's MCP child holds for the life of its session. */
  const openAgentStream = async (agentId: string) => {
    const abort = new AbortController();
    const res = await fetch(
      `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(agentId)}`,
      { headers: { accept: 'text/event-stream' }, signal: abort.signal },
    );
    expect(res.status).toBe(200);
    return listenFrames(res, abort);
  };

  /** A browser tab watching the same board: a stream with no agentId on it. */
  const openTabStream = async () => {
    const abort = new AbortController();
    const res = await fetch(`${base}/workspaces/${workspaceId}/events:stream`, {
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    return listenFrames(res, abort);
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-listening-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const { workspace } = (await (await post('/workspaces', { name: 'presence' })).json()) as {
      workspace: { id: string };
    };
    workspaceId = workspace.id;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('an attached agent that never opened a stream is not listening', async () => {
    // The record alone. This is exactly the session that exited: the row, the
    // heartbeat and the last tool call all survive it, and none of them can
    // say whether anybody is there.
    await post(`/workspaces/${workspaceId}/agents`, {
      agentId: RIVERBEND,
      runtime: 'claude-code-local',
    });
    expect(await listeningOf(RIVERBEND)).toBe(false);
  });

  it('opening the agent stream makes it listening, and closing it stops', async () => {
    await post(`/workspaces/${workspaceId}/agents`, {
      agentId: RIVERBEND,
      runtime: 'claude-code-local',
    });
    const stream = await openAgentStream(RIVERBEND);
    await waitFor(async () => (await listeningOf(RIVERBEND)) === true, {
      describe: 'the roster to report the open stream',
    });

    // Take the subscription away — the session's stream is the whole of its
    // listening, and nothing else about the attachment changes.
    await stream.stop();
    await waitFor(async () => (await listeningOf(RIVERBEND)) === false, {
      describe: 'the roster to report the closed stream',
    });
    // …and the row is still there. Not listening is not detached: the
    // roster keeps the session, the strip simply stops drawing it.
    expect((await roster()).map((a) => a.agentId)).toContain(RIVERBEND);
  });

  it('answers per agent — one listening, one attached and gone, on one board', async () => {
    // The roster keeps both. Which of them to DRAW is the surface's call, so
    // the wire says who is here rather than deciding for it — the same list
    // is the lead picker's options and the plugin-drift check's domain.
    for (const agentId of [RIVERBEND, HARBORLIGHT]) {
      await post(`/workspaces/${workspaceId}/agents`, {
        agentId,
        runtime: 'claude-code-local',
      });
    }
    const stream = await openAgentStream(RIVERBEND);
    await waitFor(async () => (await listeningOf(RIVERBEND)) === true, {
      describe: 'the roster to report the open stream',
    });
    expect(await listeningOf(HARBORLIGHT)).toBe(false);
    expect((await roster()).map((a) => a.agentId).sort()).toEqual([HARBORLIGHT, RIVERBEND].sort());
    await stream.stop();
  });

  it('a browser tab never makes an absent agent look present', async () => {
    // A tab's stream carries no agentId, so it can raise the subscriber count
    // without raising anybody's presence. The positive control is the agent
    // stream in the case above: the same roster read says true there.
    await post(`/workspaces/${workspaceId}/agents`, {
      agentId: RIVERBEND,
      runtime: 'claude-code-local',
    });
    const watching = await openTabStream();
    expect(await listeningOf(RIVERBEND)).toBe(false);
    await watching.stop();
  });

  it('tells the open board when a stream closes, so a circle can go without a reload', async () => {
    await post(`/workspaces/${workspaceId}/agents`, {
      agentId: RIVERBEND,
      runtime: 'claude-code-local',
    });
    // The browser, watching the board it has open.
    const board = await openTabStream();

    const stream = await openAgentStream(RIVERBEND);
    const opened = await waitFor(
      () =>
        board.frames.find(
          (f) => f.event === AGENT_LISTENING_EVENT && f.data?.agentId === RIVERBEND,
        ),
      { describe: 'an agent.listening frame for the opened stream' },
    );
    expect(opened.data?.listening).toBe(true);

    await stream.stop();
    const closed = await waitFor(
      () =>
        board.frames.find(
          (f) =>
            f.event === AGENT_LISTENING_EVENT &&
            f.data?.agentId === RIVERBEND &&
            f.data?.listening === false,
        ),
      { describe: 'an agent.listening frame for the closed stream' },
    );
    expect(closed.data?.workspaceId).toBe(workspaceId);
    await board.stop();
  });

  it("keeps the frame off every agent's own stream, per-key and multiplexed", async () => {
    // What was waking the fleet: each arrival and departure reached every
    // attached agent's stream, and its MCP child forwarded it as a channel
    // wake about somebody else's circle. Two bystanders, one on each stream
    // shape an MCP child opens, and a tab as the positive control.
    for (const agentId of [RIVERBEND, HARBORLIGHT, SALTMARSH]) {
      await post(`/workspaces/${workspaceId}/agents`, { agentId, runtime: 'claude-code-local' });
    }
    await post(`/api/agents/${SALTMARSH}/watches`, { add: [`ws:${workspaceId}`], name: 'Salt' });
    const board = await openTabStream();
    const perKey = await openAgentStream(HARBORLIGHT);
    const muxAbort = new AbortController();
    const muxRes = await fetch(`${base}/events/agent/${SALTMARSH}`, {
      headers: { accept: 'text/event-stream' },
      signal: muxAbort.signal,
    });
    expect(muxRes.status).toBe(200);
    const mux = listenFrames(muxRes, muxAbort);
    // Both bystanders are registered as agents — the property the cut
    // relies on — or the roster would not call them listening.
    await waitFor(async () => (await listeningOf(HARBORLIGHT)) && (await listeningOf(SALTMARSH)), {
      describe: 'both bystander streams to register as agent streams',
    });

    const arriving = await openAgentStream(RIVERBEND);
    await arriving.stop();
    const isRiverbend = (listening: boolean) => (f: Frame) =>
      f.event === AGENT_LISTENING_EVENT &&
      f.data?.agentId === RIVERBEND &&
      f.data?.listening === listening;
    await waitFor(() => board.frames.find(isRiverbend(true)), {
      describe: 'the tab to hear the arrival',
    });
    await waitFor(() => board.frames.find(isRiverbend(false)), {
      describe: 'the tab to hear the departure',
    });

    // A board event after the departure. Every stream on the channel is
    // written in order, so once a bystander holds this frame it would already
    // hold any presence frame sent before it — which makes the absence below
    // an observation rather than a race. It is also the half that must NOT
    // go quiet: ordinary board broadcasts still reach agents on both shapes.
    await post(`/workspaces/${workspaceId}/tasks`, {
      title: 'Chart the tide pools',
      body: 'Agent can chart the tide pools so that the survey has a baseline.',
      assignee: 'Riverbend',
      assigneeKind: 'agent',
      author: { id: RIVERBEND, name: 'Riverbend', kind: 'agent' },
    });
    for (const stream of [perKey, mux]) {
      await waitFor(() => stream.frames.find((f) => f.event === 'task.created'), {
        describe: 'the board event to reach a bystander agent',
      });
    }
    const presenceOn = (stream: { frames: Frame[] }) =>
      stream.frames.filter((f) => f.event === AGENT_LISTENING_EVENT).map((f) => f.data?.agentId);
    expect({ perKey: presenceOn(perKey), mux: presenceOn(mux) }).toEqual({ perKey: [], mux: [] });

    for (const stream of [board, perKey, mux]) await stream.stop();
  });
});

describe('SseBus.broadcastTransient skipAgentStreams', () => {
  const sinkOf = (log: string[]) => ({
    write: (event: string) => {
      log.push(event);
    },
    close: () => {},
  });

  it('reaches tabs and skips agents only when asked', () => {
    const bus = new SseBus();
    const tab: string[] = [];
    const agent: string[] = [];
    bus.add('ws~w-1', sinkOf(tab));
    bus.add('ws~w-1', sinkOf(agent), undefined, RIVERBEND);
    const frame = agentListeningFrame('w-1', HARBORLIGHT, true);
    expect(bus.broadcastTransient('ws~w-1', frame, { skipAgentStreams: true })).toBe(1);
    expect(tab).toEqual([AGENT_LISTENING_EVENT]);
    expect(agent).toEqual([]);
    // The default is unchanged — a meeting transcript still reaches everyone.
    expect(bus.broadcastTransient('ws~w-1', frame)).toBe(2);
    expect(agent).toEqual([AGENT_LISTENING_EVENT]);
  });
});
