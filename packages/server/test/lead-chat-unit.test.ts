/**
 * The lead chat on its own: what a typed message sends the lead, how its
 * answer comes back (also after a restart), what a spoken turn to the lead
 * writes, and the log's own rules. The line is a fake that records frames;
 * the log is a real file under a temp dir.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeadChatFrame } from '@claude-workspaces/core/lead-chat';
import { LeadChat } from '../src/lead-chat/lead-chat.ts';
import { LeadChatLog, leadChatLogPath } from '../src/lead-chat/log.ts';
import {
  AgentConversation,
  type AgentLine,
  type AgentVoiceFrame,
} from '../src/spoken-reply/agent-conversation.ts';

const BRYAN = { id: 'known-bryan', name: 'Bryan' };
const WS = 'w-harbor';
const dirs: string[] = [];
/** One counter for every instance, as the server's random ids never repeat. */
let idSeq = 0;

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: { lead?: string | null; sent?: number | null; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'cw-lead-chat-'));
  if (!opts.dataDir) dirs.push(dataDir);
  const frames: AgentVoiceFrame[] = [];
  const pages: LeadChatFrame[] = [];
  const line: AgentLine = {
    attached: () => ({ name: 'Riverbend' }),
    deliver: (f) => {
      if (opts.sent === null) return null;
      frames.push(f);
      return opts.sent ?? 1;
    },
  };
  let now = 1000;
  const lead = opts.lead === undefined ? 'riverbend-lead' : opts.lead;
  const chat = new LeadChat({
    log: new LeadChatLog(dataDir),
    line,
    leadOf: () => (lead ? { agentId: lead, name: 'Riverbend' } : null),
    broadcast: (_ws, f) => pages.push(f),
    newId: () => `id-${++idSeq}`,
    now: () => (now += 10),
  });
  return { chat, frames, pages, dataDir, line };
}

describe('LeadChat', () => {
  it('sends a typed message to the lead alone, with the page it was typed on', () => {
    const { chat, frames, pages } = setup();
    const res = chat.post(WS, BRYAN, 'what is left on the intake form?', {
      surface: 'doc',
      docId: 'd-plan',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message).toMatchObject({ role: 'person', state: 'sent', via: 'chat' });
    expect(Object.keys(res.message)).not.toContain('queueId');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      event: 'voice.request',
      to: 'riverbend-lead',
      transcript: 'what is left on the intake form?',
      context: { surface: 'doc', docId: 'd-plan' },
      actor: { id: BRYAN.id, name: 'Bryan' },
    });
    expect(pages.map((p) => p.message.id)).toEqual([res.message.id]);
  });

  it('records the lead’s answer once, and refuses one from another agent', () => {
    const { chat, frames, pages } = setup();
    const res = chat.post(WS, BRYAN, 'status?', undefined);
    const queueId = frames[0]?.queueId ?? '';
    expect(chat.answer(WS, queueId, 'Two fields left.', 'saltmarsh-helper')).toBe(false);
    expect(chat.answer('w-other', queueId, 'Two fields left.', 'riverbend-lead')).toBe(false);
    expect(chat.answer(WS, queueId, 'Two fields left.', 'riverbend-lead')).toBe(true);
    expect(chat.answer(WS, queueId, 'Again.', 'riverbend-lead')).toBe(false);
    const snap = chat.snapshot(WS);
    expect(snap.messages.map((m) => [m.role, m.text, m.state])).toEqual([
      ['person', 'status?', 'answered'],
      ['agent', 'Two fields left.', undefined],
    ]);
    expect(snap.messages[1]?.replyTo).toBe(res.ok ? res.message.id : '');
    expect(pages.at(-1)?.message.text).toBe('Two fields left.');
  });

  it('hands the lead the conversation so far with each message', () => {
    const { chat, frames } = setup();
    chat.post(WS, BRYAN, 'first', undefined);
    chat.answer(WS, frames[0]?.queueId ?? '', 'one', 'riverbend-lead');
    chat.post(WS, BRYAN, 'second', undefined);
    expect(frames[1]?.conversation).toEqual([
      { from: 'owner', text: 'first' },
      { from: 'agent', text: 'one' },
    ]);
  });

  it('says queued when the lead holds no stream, and no-lead when the seat is empty', () => {
    const away = setup({ sent: 0 }).chat.post(WS, BRYAN, 'hello', undefined);
    expect(away.ok && away.message.state).toBe('queued');
    const none = setup({ lead: null });
    const res = none.chat.post(WS, BRYAN, 'hello', undefined);
    expect(res.ok && res.message.state).toBe('no-lead');
    expect(none.frames).toHaveLength(0);
  });

  it('keeps the history and an open question across a restart', () => {
    const first = setup();
    first.chat.post(WS, BRYAN, 'still there?', undefined);
    const queueId = first.frames[0]?.queueId ?? '';
    const again = setup({ dataDir: first.dataDir });
    expect(again.chat.snapshot(WS).messages.map((m) => m.text)).toEqual(['still there?']);
    expect(again.chat.answer(WS, queueId, 'Yes.', 'riverbend-lead')).toBe(true);
    const third = setup({ dataDir: first.dataDir });
    expect(third.chat.snapshot(WS).messages.map((m) => [m.text, m.state])).toEqual([
      ['still there?', 'answered'],
      ['Yes.', undefined],
    ]);
  });

  it('writes a spoken turn to the lead, and its answer, into the same chat', () => {
    const { chat, line } = setup();
    let n = 0;
    const talk = new AgentConversation(line, WS, () => `vt-${++n}`, Date.now, {
      turn: (...a) => chat.voiceTurn(...a),
      replied: (...a) => chat.voiceReply(...a),
    });
    talk.address('riverbend-lead');
    const turn = talk.turn('read me the first one', { ...BRYAN, kind: 'known' });
    if (turn.kind !== 'sent') throw new Error(turn.kind);
    talk.replied(turn.queueId, 'Item one: the default country.');
    expect(chat.snapshot(WS).messages.map((m) => [m.role, m.via, m.text, m.state])).toEqual([
      ['person', 'voice', 'read me the first one', 'answered'],
      ['agent', undefined, 'Item one: the default country.', undefined],
    ]);
  });

  it('does not write a spoken talk with an agent other than the lead', () => {
    const { chat } = setup();
    chat.voiceTurn(WS, 'saltmarsh-helper', BRYAN, 'hi', 'vt-1', false);
    chat.voiceReply(WS, 'vt-1', 'hello');
    expect(chat.snapshot(WS).messages).toEqual([]);
  });
});

describe('LeadChatLog', () => {
  it('reads the latest line per id and skips a torn tail', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-chat-log-'));
    dirs.push(dataDir);
    const log = new LeadChatLog(dataDir);
    const m = { id: 'a', role: 'person' as const, author: BRYAN, text: 'hi', ts: 1 };
    log.append(WS, { ...m, state: 'sent' });
    log.append(WS, { ...m, state: 'answered' });
    appendFileSync(leadChatLogPath(dataDir, WS) ?? '', '{"id":"b","role":');
    expect(log.load(WS).map((x) => [x.id, x.state])).toEqual([['a', 'answered']]);
  });

  it('names no file for an id that is not a board id', () => {
    expect(leadChatLogPath('/data', '../etc')).toBeNull();
    expect(
      new LeadChatLog('/data').append('../etc', {
        id: 'a',
        role: 'person',
        author: BRYAN,
        text: 'x',
        ts: 1,
      }),
    ).toBe(false);
  });

  it('reads only the tail of a long log', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-chat-tail-'));
    dirs.push(dataDir);
    const log = new LeadChatLog(dataDir, 400);
    for (let i = 0; i < 20; i++) {
      log.append(WS, { id: `m${i}`, role: 'person', author: BRYAN, text: `line ${i}`, ts: i });
    }
    const ids = log.load(WS).map((x) => x.id);
    expect(ids.at(-1)).toBe('m19');
    expect(ids).not.toContain('m0');
  });
});
