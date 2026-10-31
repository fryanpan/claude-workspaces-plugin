/**
 * Fakes for the lead chat's meeting: the meeting socket, the microphone, a
 * clock that only moves when told, and a chat client that records each
 * meeting verb and answers the way the server does. No network, no device.
 */
import type { LeadChatMeeting, LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import type { LeadChatClient, LeadChatState } from '../src/lead-chat/lead-chat-client.ts';
import type { MeetingSocket } from '../src/meeting-link.ts';

export class FakeSocket implements MeetingSocket {
  sent: Array<string | ArrayBufferView> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  say(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

export function fakeSockets() {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    openSocket: (url: string): MeetingSocket => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    last: (): FakeSocket => {
      const s = sockets.at(-1);
      if (!s) throw new Error('no socket opened');
      return s;
    },
  };
}

/** The microphone: `contextState` is what a resumed page's context reads;
 *  `emit` delivers a frame as the graph would. */
export function fakeMic(contextState: 'running' | 'suspended' = 'running') {
  const mic = {
    contextState: contextState as string,
    opened: 0,
    stopped: 0,
    resumed: 0,
    contexts: [] as Array<AudioContext | undefined>,
    emit: (_pcm: Int16Array): void => {},
    startCapture: async (o: { onFrame: (pcm: Int16Array) => void; context?: AudioContext }) => {
      mic.opened++;
      mic.contexts.push(o.context);
      mic.emit = o.onFrame;
      return {
        ok: true as const,
        capture: {
          stop: () => {
            mic.stopped++;
          },
          setEchoCancellation: async () => {},
          reopen: async () => ({ ok: true as const }),
          health: () => ({ blocks: 0, contextState: mic.contextState, sampleRate: 16_000 }),
          resumeAudio: async () => {
            mic.resumed++;
            mic.contextState = 'running';
          },
        },
      };
    },
  };
  return mic;
}

export function fakeClock() {
  let t = 0;
  const waits: Array<{ fn: () => void; at: number }> = [];
  return {
    now: () => t,
    schedule: (fn: () => void, ms: number) => {
      const w = { fn, at: t + ms };
      waits.push(w);
      return () => {
        const i = waits.indexOf(w);
        if (i >= 0) waits.splice(i, 1);
      };
    },
    advance(ms: number): void {
      t += ms;
      for (const w of [...waits].sort((a, b) => a.at - b.at)) {
        if (w.at > t) continue;
        waits.splice(waits.indexOf(w), 1);
        w.fn();
      }
    },
  };
}

export const ALICE = { id: 'known-alice', name: 'Alice Riverbend', kind: 'known' };

export function meetingFixture(over: Partial<LeadChatMeeting> = {}): LeadChatMeeting {
  return {
    id: 'lcm-1',
    startedAt: 1,
    by: { id: ALICE.id, name: ALICE.name },
    docId: 'd-saltmarsh',
    docTitle: 'Saltmarsh notes',
    notes: 'existing',
    source: 'mic',
    speakers: 'conversation',
    recorder: 'rec-here',
    people: [{ id: ALICE.id, name: ALICE.name }],
    lines: [],
    ...over,
  };
}

/** A chat client whose meeting verbs land in `calls` and answer as the
 *  server would; `setMeeting` is a frame from another page. */
export function fakeMeetingClient(meeting: LeadChatMeeting | null = null) {
  let state: LeadChatState = {
    lead: { agentId: 'harborlight-lead', name: 'Harborlight Lead' },
    messages: [],
    canTalk: true,
    loaded: true,
    meeting,
    more: false,
    loadingOlder: false,
  };
  const fns: Array<(s: LeadChatState) => void> = [];
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  /** What the server says of a line's ask, as it does to a caller it cannot prove. */
  const lineAnswer: { lead?: 'sign-in' } = {};
  const changed = () => {
    for (const fn of fns) fn(state);
  };
  const client: LeadChatClient = {
    state: () => state,
    onChange: (fn) => {
      fns.push(fn);
    },
    loadOlder: async () => {},
    async send(text, author, _context, via) {
      const m: LeadChatMessage = {
        id: `m${calls.length}`,
        role: 'person',
        author: { id: author.id, name: author.name },
        text,
        ts: 1,
        via,
        state: 'sent',
      };
      return { ok: true, message: m };
    },
    async meeting(action, author, body) {
      calls.push({ action, body });
      const m = state.meeting;
      if (action === 'start') {
        const made = meetingFixture({
          docId: String(body.docId),
          docTitle: String(body.docTitle),
          notes: body.notes as LeadChatMeeting['notes'],
          source: body.source as LeadChatMeeting['source'],
          speakers: body.speakers as LeadChatMeeting['speakers'],
          recorder: String(body.recorder),
          by: { id: author.id, name: author.name },
          people: [{ id: author.id, name: author.name }],
        });
        state = { ...state, meeting: made };
        changed();
        return { ok: true, meeting: made };
      }
      if (!m) return { ok: false, error: 'no-meeting' };
      if (action === 'end') {
        state = { ...state, meeting: null };
        changed();
        return { ok: true };
      }
      if (action === 'line') {
        const line = {
          turn: Number(body.turn),
          who: String(body.who),
          text: String(body.text),
          ts: 1,
        };
        state = {
          ...state,
          meeting: { ...m, lines: [...m.lines.filter((l) => l.turn !== line.turn), line] },
        };
        changed();
        return { ok: true, ...lineAnswer };
      }
      if (action === 'join') {
        state = {
          ...state,
          meeting: { ...m, people: [...m.people, { id: author.id, name: author.name }] },
        };
        changed();
        return { ok: true, meeting: state.meeting ?? undefined };
      }
      if (action === 'recording') {
        state = {
          ...state,
          meeting: { ...m, meetingId: String(body.meetingId), recorder: String(body.recorder) },
        };
        changed();
        return { ok: true, meeting: state.meeting ?? undefined };
      }
      return { ok: false, error: 'unknown action' };
    },
    close() {},
  };
  return {
    client,
    calls,
    lineAnswer,
    actions: () => calls.map((c) => c.action),
    setMeeting(next: LeadChatMeeting | null) {
      state = { ...state, meeting: next };
      changed();
    },
  };
}

/** Let every pending promise settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
