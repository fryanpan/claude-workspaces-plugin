/**
 * The lead chat's history: a page is handed the latest page of messages and
 * pages back from the oldest one it shows until the first — out of what the
 * server holds while that reaches, off the log once it does not, and through
 * the real route. A page is never handed the queue id the lead answers by.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEAD_CHAT_PAGE,
  type LeadChatCursor,
  type LeadChatHistoryPage,
  type LeadChatMessage,
  type LeadChatRead,
  compareLeadChatEntries,
} from '@claude-workspaces/core/lead-chat';
import { LeadChat } from '../src/lead-chat/lead-chat.ts';
import { LEAD_CHAT_KEEP, LeadChatLog } from '../src/lead-chat/log.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { AgentLine } from '../src/spoken-reply/agent-conversation.ts';

const BRYAN = { id: 'known-bryan', name: 'Bryan' };
const WS = 'w-harbor';
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A board whose log already holds `n` messages, m0 oldest, and a chat
 *  opened over it as a restarted server would. */
function board(n: number, readCap?: number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-chat-history-'));
  dirs.push(dataDir);
  const log = new LeadChatLog(dataDir, readCap);
  for (let i = 0; i < n; i++) {
    log.append(WS, {
      id: `m${i}`,
      role: i % 2 ? 'agent' : 'person',
      author: BRYAN,
      text: `line ${i}`,
      ts: 1000 + i,
      queueId: `q${i}`,
      sentTo: 'riverbend-lead',
    });
  }
  const line: AgentLine = { attached: () => ({ name: 'Riverbend' }), deliver: () => 1 };
  const chat = new LeadChat({
    log,
    line,
    leadOf: () => ({ agentId: 'riverbend-lead', name: 'Riverbend' }),
    broadcast: () => {},
    newId: () => 'unused',
  });
  return { chat, log };
}

const ids = (list: readonly LeadChatMessage[]) => list.map((m) => m.id);
const cursorOf = (m: LeadChatMessage | undefined): LeadChatCursor => ({
  ts: m?.ts ?? 0,
  id: m?.id ?? '',
});

/** Every page from the snapshot back to the first, as a page scrolls. */
async function pageToFirst(chat: LeadChat, limit = LEAD_CHAT_PAGE) {
  const snap = chat.snapshot(WS);
  let shown = snap.messages;
  let more = snap.more === true;
  let pages = 0;
  while (more) {
    const page = await chat.page(WS, cursorOf(shown[0]), limit);
    if (!page) throw new Error('history unreadable');
    shown = [...page.messages, ...shown];
    more = page.more;
    pages++;
  }
  return { shown, pages };
}

describe('LeadChat history', () => {
  it('hands a page the latest page, says older ones exist, and never a queue id', () => {
    const { chat } = board(LEAD_CHAT_PAGE + 5);
    const snap = chat.snapshot(WS);
    expect(snap.messages).toHaveLength(LEAD_CHAT_PAGE);
    expect(snap.messages.at(-1)?.id).toBe(`m${LEAD_CHAT_PAGE + 4}`);
    expect(snap.more).toBe(true);
    for (const m of snap.messages) {
      expect(m).not.toHaveProperty('queueId');
      expect(m).not.toHaveProperty('sentTo');
    }
  });

  it('says there is nothing older for a conversation that fits one page', () => {
    const { chat } = board(3);
    expect(chat.snapshot(WS)).toMatchObject({ more: false });
    expect(ids(chat.snapshot(WS).messages)).toEqual(['m0', 'm1', 'm2']);
  });

  it('pages back out of memory to the first message', async () => {
    const { chat } = board(120);
    const { shown, pages } = await pageToFirst(chat);
    expect(pages).toBe(2);
    expect(ids(shown)).toEqual(Array.from({ length: 120 }, (_, i) => `m${i}`));
  });

  it('pages back past what the server holds, off the log, to the first message', async () => {
    const total = LEAD_CHAT_KEEP + 70;
    const { chat } = board(total);
    const { shown } = await pageToFirst(chat);
    expect(ids(shown)).toEqual(Array.from({ length: total }, (_, i) => `m${i}`));
    for (const m of shown) expect(m).not.toHaveProperty('queueId');
  });

  it('pages back past a tail read too short to hold everything', async () => {
    // Twenty lines of ~150 bytes against a 400-byte tail: the held list is
    // two or three messages, and every other one comes off the log.
    const { chat } = board(20, 400);
    expect(chat.snapshot(WS).messages.length).toBeLessThan(5);
    const { shown } = await pageToFirst(chat, 4);
    expect(ids(shown)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
  });

  it('pages back from a message that shares its millisecond with the one before', async () => {
    const { chat, log } = board(0);
    for (const id of ['b', 'a', 'c']) {
      log.append(WS, { id, role: 'person', author: BRYAN, text: id, ts: 5 });
    }
    const page = await chat.page(WS, { ts: 5, id: 'b' }, 10);
    expect(ids(page?.messages ?? [])).toEqual(['a']);
    expect(page?.more).toBe(false);
  });
});

describe('GET /workspaces/<id>/lead-chat history pages', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-chat-history-http-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Saltmarsh' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    for (let i = 0; i < LEAD_CHAT_PAGE + 10; i++) {
      const res = await post(`/workspaces/${boardId}/lead-chat`, {
        text: `question ${i}`,
        author: { ...BRYAN, kind: 'known' },
      });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers the first read with the latest page, then the page before it', async () => {
    const read = (await (
      await fetch(`${base}/workspaces/${boardId}/lead-chat`)
    ).json()) as LeadChatRead;
    expect(read.messages).toHaveLength(LEAD_CHAT_PAGE);
    expect(read.more).toBe(true);
    const first = read.messages[0];
    const q = `beforeTs=${first?.ts}&beforeId=${encodeURIComponent(first?.id ?? '')}`;
    const res = await fetch(`${base}/workspaces/${boardId}/lead-chat?${q}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as LeadChatHistoryPage;
    expect(page.more).toBe(false);
    // Posted back to back, several share a millisecond and sort by id among
    // themselves, so which message lands either side of the cut is not
    // fixed. What is: the page is the ten before the first one shown, and
    // the two together are every message once.
    expect(page.messages).toHaveLength(10);
    for (const m of page.messages) {
      expect(compareLeadChatEntries(m, cursorOf(first))).toBeLessThan(0);
    }
    const all = [...page.messages, ...read.messages].map((m) => m.text);
    expect(new Set(all).size).toBe(LEAD_CHAT_PAGE + 10);
    expect(all.sort()).toEqual(
      Array.from({ length: LEAD_CHAT_PAGE + 10 }, (_, i) => `question ${i}`).sort(),
    );
  });

  it('refuses a page whose cursor or limit is not one', async () => {
    for (const q of [
      'beforeTs=abc&beforeId=lc-1',
      'beforeTs=10',
      'beforeId=lc-1',
      'beforeTs=10&beforeId=..%2F..%2Fetc',
      'beforeTs=10&beforeId=lc-1&limit=0',
      'beforeTs=10&beforeId=lc-1&limit=1000',
    ]) {
      const res = await fetch(`${base}/workspaces/${boardId}/lead-chat?${q}`);
      expect(res.status, q).toBe(400);
    }
  });
});
