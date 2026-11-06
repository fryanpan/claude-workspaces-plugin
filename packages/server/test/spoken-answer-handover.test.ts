/**
 * A spoken question whose page changed before the lead answered, through the
 * REAL server.
 *
 * Following somebody, or tapping a link, loads another page of the board,
 * and the page that asked closes its voice socket. The next socket the same
 * person opens on the board takes the wait over: an answer given before it
 * opens is held and said when it does, and one given after is said on it.
 * Another person's socket takes nothing. Fake engines; nothing reaches a
 * vendor.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { SpokenAnswer } from '../src/spoken-reply/answer.ts';
import {
  LEAD_ANSWER_ROUTE,
  LEAD_ANSWER_WINDOW_MS,
  LeadAnswers,
} from '../src/spoken-reply/lead-answer.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';
import { agentStream } from './agent-voice-stream.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('a wait belongs to the person, for the whole window', () => {
  const said = () => {
    const words: string[] = [];
    return { words, say: (a: SpokenAnswer) => void words.push(a.spoken) };
  };
  const clocked = () => {
    const clock = { at: 0 };
    return { clock, leads: new LeadAnswers(() => clock.at) };
  };

  it('an answer given minutes after the socket closed is said on the next one', () => {
    const { clock, leads } = clocked();
    const page = {};
    const { words, say } = said();
    leads.wait('w1', 'q1', page, say);
    leads.orphan(page, 'first-person');
    clock.at = 20 * 60_000;
    expect(leads.answer('w1', 'q1', 'It runs at noon.')).toBe(true);
    expect(words).toEqual([]);
    clock.at = 25 * 60_000;
    leads.adopt('w1', 'first-person', {}, () => {});
    expect(words).toEqual(['It runs at noon.']);
  });

  it('a socket that opens minutes later takes the wait, and the answer reaches it', () => {
    const { clock, leads } = clocked();
    const page = {};
    const { words, say } = said();
    leads.wait('w1', 'q1', page, say);
    leads.orphan(page, 'first-person');
    clock.at = 10 * 60_000;
    leads.adopt('w1', 'first-person', {}, () => {});
    clock.at = 15 * 60_000;
    expect(leads.answer('w1', 'q1', 'At six.')).toBe(true);
    expect(words).toEqual(['At six.']);
  });

  it('lapses with the window, and never reaches another person or board', () => {
    const { clock, leads } = clocked();
    const page = {};
    const { words, say } = said();
    leads.wait('w1', 'q1', page, say);
    leads.orphan(page, 'first-person');
    leads.adopt('w1', 'second-person', {}, () => {});
    leads.adopt('w2', 'first-person', {}, () => {});
    clock.at = LEAD_ANSWER_WINDOW_MS + 1;
    expect(leads.answer('w1', 'q1', 'Too late.')).toBe(false);
    leads.adopt('w1', 'first-person', {}, () => {});
    expect(words).toEqual([]);
  });
});

describe('a spoken answer across a page change', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  let lead: Awaited<ReturnType<typeof agentStream>>;
  const said: string[] = [];
  const BRYAN = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

  const listener: TranscriptionEngine = {
    name: 'fake',
    async open() {
      return { send: () => {}, close: async () => {} };
    },
  };
  const voice: SpokenVoice = {
    name: 'fake',
    async speak(text, onAudio) {
      said.push(text);
      onAudio(new Uint8Array(480));
    },
  };

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-answer-handover-'));
    handle = createServer({
      port: 0,
      dataDir,
      spokenReply: { listener, voices: { 1: voice, 2: null }, gemini: null },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    handle.tasks.attachAgent(boardId, {
      agentId: 'house-lead',
      agentName: 'Harborlight Lead',
      runtime: 'claude-code-local',
    });
    handle.tasks.setLeadAgent(boardId, 'house-lead', { actor: BRYAN });
    lead = await agentStream(base, boardId, 'house-lead');
  });

  afterAll(async () => {
    lead.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const open = async (author: unknown = BRYAN) => {
    const url = `ws://127.0.0.1:${handle.port}/workspaces/${boardId}/voice/converse`;
    const sock = new WebSocket(url);
    const frames: Frame[] = [];
    sock.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') frames.push(JSON.parse(ev.data) as Frame);
    });
    await new Promise<void>((resolve, reject) => {
      sock.addEventListener('open', () => resolve());
      sock.addEventListener('error', () => reject(new Error('converse socket refused')));
    });
    await waitFor(() => frames.some((f) => f.type === 'ready'), { describe: 'ready' });
    return { sock, frames, author };
  };
  const ask = async (page: Awaited<ReturnType<typeof open>>, question: string) => {
    page.sock.send(
      JSON.stringify({
        type: 'start',
        setup: 1,
        mode: 'hold',
        agent: 'house-lead',
        author: page.author,
        context: { surface: 'board' },
      }),
    );
    page.sock.send(JSON.stringify({ type: 'say', text: question }));
    await waitFor(() => lead.voice.some((v) => v.transcript === question), {
      describe: 'the lead got the spoken turn',
    });
    return lead.voice.find((v) => v.transcript === question)?.queueId ?? '';
  };
  const answer = async (queueId: string, text: string) =>
    (await (
      await post(`/workspaces/${boardId}/voice-queue/${queueId}/answer`, {
        agentId: 'house-lead',
        text,
      })
    ).json()) as { delivered?: boolean };
  const heard = (page: Awaited<ReturnType<typeof open>>, text: string) =>
    page.frames.some((f) => f.route === LEAD_ANSWER_ROUTE && f.spoken === text);
  const closed = (page: Awaited<ReturnType<typeof open>>) =>
    new Promise<void>((resolve) => {
      page.sock.addEventListener('close', () => resolve());
      page.sock.close();
    });

  it('says an answer given while no page was open on the next page', async () => {
    const first = await open();
    const queueId = await ask(first, 'is the Riverbend ferry running');
    await closed(first);
    expect(await answer(queueId, 'It runs at noon.')).toMatchObject({ delivered: true });
    const next = await open();
    await waitFor(() => heard(next, 'It runs at noon.'), { describe: 'said on the next page' });
    await waitFor(() => said.includes('It runs at noon.'), { describe: 'the voice said it' });
    next.sock.close();
  });

  it('says an answer given after the next page opened on that page', async () => {
    const first = await open();
    const queueId = await ask(first, 'when is high water at Saltmarsh');
    await closed(first);
    const next = await open();
    expect(await answer(queueId, 'At six.')).toMatchObject({ delivered: true });
    await waitFor(() => heard(next, 'At six.'), { describe: 'said on the next page' });
    expect(heard(first, 'At six.')).toBe(false);
    next.sock.close();
  });

  it('says the answer on the next page when it opened before the last one closed', async () => {
    const first = await open();
    const queueId = await ask(first, 'is the Saltmarsh road open');
    const next = await open();
    await closed(first);
    expect(await answer(queueId, 'Until dusk.')).toMatchObject({ delivered: true });
    await waitFor(() => heard(next, 'Until dusk.'), { describe: 'said on the next page' });
    next.sock.close();
  });

  it('does not hand a wait to an older tab of the same person', async () => {
    const older = await open();
    const first = await open();
    const queueId = await ask(first, 'is the Harborlight bridge up');
    await closed(first);
    expect(await answer(queueId, 'Not yet.')).toMatchObject({ delivered: true });
    expect(heard(older, 'Not yet.')).toBe(false);
    const next = await open();
    await waitFor(() => heard(next, 'Not yet.'), { describe: 'said on the next page' });
    older.sock.close();
    next.sock.close();
  });

  it('keeps going across two page changes', async () => {
    const first = await open();
    const queueId = await ask(first, 'who has the Harborlight keys');
    await closed(first);
    const second = await open();
    await closed(second);
    const third = await open();
    expect(await answer(queueId, 'Alice does.')).toMatchObject({ delivered: true });
    await waitFor(() => heard(third, 'Alice does.'), { describe: 'said on the third page' });
    third.sock.close();
  });

  it('a socket that stays open is unchanged, and a second answer to one wait is refused', async () => {
    const page = await open();
    const queueId = await ask(page, 'is the quay open');
    expect(await answer(queueId, 'Yes.')).toMatchObject({ delivered: true });
    await waitFor(() => heard(page, 'Yes.'), { describe: 'said on the page' });
    expect(await answer(queueId, 'Still yes.')).toMatchObject({ delivered: false });
    page.sock.close();
  });
});
