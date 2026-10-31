/**
 * The conversation with one named agent, on its own: what each turn carries,
 * when a talk starts over, and who may hold one at all. The clock and the ids
 * are injected; the line is a fake that records what it was handed.
 */
import { describe, expect, it } from 'bun:test';
import {
  AgentConversation,
  type AgentLine,
  type AgentVoiceFrame,
  CONVERSATION_KEEP,
  agentLine,
} from '../src/spoken-reply/agent-conversation.ts';
import { SpokenReplyRelay, type SpokenWs } from '../src/spoken-reply/relay.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

function fakeLine(opts: { attached?: string[]; sent?: number | null } = {}) {
  const frames: AgentVoiceFrame[] = [];
  const line: AgentLine = {
    attached: (_ws, agentId) =>
      (opts.attached ?? ['harborlight']).includes(agentId)
        ? { name: `${agentId} agent` }
        : undefined,
    deliver: (frame) => {
      if (opts.sent === null) return null;
      frames.push(frame);
      return opts.sent ?? 1;
    },
  };
  return { line, frames };
}

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

describe('AgentConversation', () => {
  it('each turn carries the turns before it, under one id, until the agent changes', () => {
    const { line, frames } = fakeLine({ attached: ['harborlight', 'riverbend'] });
    let now = 1000;
    const c = new AgentConversation(line, 'w-1', ids(), () => now);
    c.address('harborlight');
    const first = c.turn('where is the ferry', ALICE);
    expect(first).toEqual({
      kind: 'sent',
      name: 'harborlight agent',
      queueId: 'id-2',
      agentId: 'harborlight',
    });
    c.replied('id-2', 'At the north dock.');
    // An answer to a row this talk never sent changes nothing.
    c.replied('id-99', 'Not ours.');
    now = 2000;
    c.address('harborlight');
    c.turn('and when does it leave', ALICE);
    expect(frames.map((f) => [f.conversationId, f.ts, f.to])).toEqual([
      ['id-1', 1000, 'harborlight'],
      ['id-1', 2000, 'harborlight'],
    ]);
    expect(frames[1]?.conversation).toEqual([
      { from: 'owner', text: 'where is the ferry' },
      { from: 'agent', text: 'At the north dock.' },
    ]);

    c.address('riverbend');
    c.turn('hello', ALICE);
    expect(frames[2]?.conversationId).not.toBe('id-1');
    expect(frames[2]?.conversation).toEqual([]);
    expect(frames[2]?.to).toBe('riverbend');
  });

  it('keeps the newest turns only', () => {
    const { line, frames } = fakeLine();
    const c = new AgentConversation(line, 'w-1', ids());
    c.address('harborlight');
    for (let i = 0; i <= CONVERSATION_KEEP; i++) c.turn(`turn ${i}`, ALICE);
    c.turn('last', ALICE);
    const history = frames.at(-1)?.conversation ?? [];
    expect(history).toHaveLength(CONVERSATION_KEEP);
    expect(history.at(-1)?.text).toBe(`turn ${CONVERSATION_KEEP}`);
    expect(history[0]?.text).toBe('turn 1');
  });

  it('an agent that is not attached, or a row that could not be written, keeps nothing', () => {
    const { line, frames } = fakeLine({ attached: [] });
    const c = new AgentConversation(line, 'w-1', ids());
    c.address('saltmarsh');
    expect(c.turn('hello', ALICE)).toEqual({ kind: 'not-attached' });
    expect(frames).toHaveLength(0);

    const failing = fakeLine({ sent: null });
    const d = new AgentConversation(failing.line, 'w-1', ids());
    d.address('harborlight');
    expect(d.turn('hello', ALICE)).toEqual({ kind: 'failed' });
    const working = fakeLine({ sent: 0 });
    const e = new AgentConversation(working.line, 'w-1', ids());
    e.address('harborlight');
    expect(e.turn('hello', ALICE).kind).toBe('queued');
  });
});

describe('agentLine', () => {
  it('writes the addressed row first, sends to that agent alone, and marks it only when sent', () => {
    const calls: string[] = [];
    const line = agentLine({
      listAttachments: () => [{ agentId: 'harborlight' }],
      displayName: () => 'Harborlight Lead',
      queueComment: (_ws, item) => {
        calls.push(`queue ${item.agentId} ${item.event} ${item.text}`);
        return 'cq-1';
      },
      markCommentEmitted: (_ws, id) => {
        calls.push(`emitted ${id}`);
        return true;
      },
      sendToAgent: (_ws, agentId, frame) => {
        calls.push(`send ${agentId} ${frame.commentQueueId} ${frame.queueId}`);
        return agentId === 'harborlight' ? 1 : 0;
      },
    });
    expect(line.attached('w-1', 'harborlight')).toEqual({ name: 'Harborlight Lead' });
    expect(line.attached('w-1', 'riverbend')).toBeUndefined();
    const frame: AgentVoiceFrame = {
      event: 'voice.request',
      workspaceId: 'w-1',
      route: 'agent',
      to: 'harborlight',
      transcript: 'hello',
      ack: 'Sent to Harborlight Lead.',
      queueId: 'vt-1',
      conversationId: 'vt-0',
      conversation: [],
      actor: ALICE,
      ts: 1,
    };
    expect(line.deliver(frame)).toBe(1);
    expect(line.deliver({ ...frame, to: 'riverbend' })).toBe(0);
    expect(calls).toEqual([
      'queue harborlight voice.request hello',
      'send harborlight cq-1 vt-1',
      'emitted cq-1',
      'queue riverbend voice.request hello',
      'send riverbend cq-1 vt-1',
    ]);
  });
});

describe('who may talk to an agent by name', () => {
  const listener: TranscriptionEngine = {
    name: 'fake',
    async open() {
      return { send: () => {}, close: async () => {} };
    },
  };
  const voice: SpokenVoice = {
    name: 'fake',
    async speak(_text, onAudio) {
      onAudio(new Uint8Array(48));
    },
  };

  function relayWith(line: AgentLine) {
    return new SpokenReplyRelay({
      engines: { listener, voices: { 1: voice, 2: null }, gemini: null },
      board: {
        handle: async () => ({ ok: true, route: 'fast-path', ack: 'The board answered.' }),
        goalStatus: () => undefined,
        goals: () => [],
      },
      timings: new SpokenTimings(undefined, () => {}),
      parseContext: () => undefined,
      agentLine: line,
      newId: ids(),
    });
  }

  async function sayTo(data: SpokenWs['data']) {
    const { line, frames } = fakeLine();
    const r = relayWith(line);
    const sent: Array<Record<string, unknown>> = [];
    const ws: SpokenWs = {
      data: { workspaceId: 'w-1', ...data },
      send: (p) => {
        if (typeof p === 'string') sent.push(JSON.parse(p) as Record<string, unknown>);
      },
    };
    r.onOpen(ws);
    r.onText(ws, JSON.stringify({ type: 'start', setup: 1, mode: 'hold', agent: 'harborlight' }));
    r.onText(ws, JSON.stringify({ type: 'say', text: 'hello there' }));
    await waitFor(() => sent.some((m) => m.type === 'reply'), { describe: 'reply' });
    return { spoken: sent.find((m) => m.type === 'reply')?.spoken, frames };
  }

  it('the owner, proven, reaches the agent', async () => {
    const r = await sayTo({ ownerProven: true, author: { id: 'owner', name: 'Bryan' } });
    // Reached, and nothing said for it: the agent's answer is the reply.
    expect(r.spoken).toBe('');
    expect(r.frames.map((f) => f.transcript)).toEqual(['hello there']);
  });

  it('a local page that proved nobody reaches the agent, as it reaches the board', async () => {
    const r = await sayTo({});
    expect(r.frames).toHaveLength(1);
  });

  it('a signed-in person who is not the owner is refused, and nothing is sent', async () => {
    const r = await sayTo({ author: { id: 'known-bob', name: 'Bob' } });
    expect(r.spoken).toBe('Only the owner can talk to an agent here.');
    expect(r.frames).toHaveLength(0);
  });
});
