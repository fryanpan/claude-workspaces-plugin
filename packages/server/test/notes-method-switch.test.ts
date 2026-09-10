/**
 * CHANGING WHICH NOTE-TAKER A DOC USES — the two ways it can be asked for and
 * the one record both of them write.
 *
 * At rest it is a `PUT` on the doc; while the room is talking it is a frame on
 * the audio socket, because the change has to reach the live session: the next
 * tick composes with it, and the doc gets its one trace line saying who
 * changed it and when. Nothing already written is rewritten either way — the
 * owner's rule is that a switch changes what comes next.
 *
 * A LIVE MEETING REFUSES THE HTTP HALF (409). Written behind the session's
 * back the record would move while that session kept composing with what it
 * had, and the doc would carry no line saying anything had changed.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_NOTES_METHOD,
  type NotesMethod,
  notesMethodLabel,
  notesMethodTraceLine,
  parseMeetingClientMessage,
  type prose,
} from '@claude-workspaces/core';
import {
  type MeetingNotesSession,
  type NotesUpdate,
  beginNotesSession,
} from '../src/meeting-notes.ts';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { MeetingStore } from '../src/meetings.ts';
import {
  MAX_KEPT_CHANGES,
  readNotesMethod,
  readNotesMethodRecord,
  writeNotesMethod,
} from '../src/notes-method-store.ts';
import {
  type MeetingCalendarRoutesContext,
  handleMeetingCalendarRoutes,
} from '../src/routes/meetings-calendar.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { TranscriptionEngine, TranscriptionSession } from '../src/transcribe.ts';
import { ManualScheduler } from './notes-tick-harness.ts';
import { seedBoard } from './workspace-seed.ts';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** An engine that opens and hears nothing — enough for a meeting to be live. */
function silentEngine(): TranscriptionEngine {
  const session: TranscriptionSession = { send: () => {}, close: () => Promise.resolve() };
  return { name: 'silent', open: () => Promise.resolve(session) };
}

describe('the frame that changes the note-taker mid-meeting', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-notes-method-frame-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  interface Change {
    docId: string;
    meetingId?: string;
    method: NotesMethod;
    by?: string;
  }

  /** One live meeting, and every change the relay recorded on it. */
  async function live(
    docId: string,
    /** What the record's own write answers. `false` is a data dir that could
     *  not be written — full, read-only, gone. */
    recorded = true,
  ): Promise<{
    send: (frame: unknown) => void;
    changes: Change[];
    writes: NotesUpdate[];
    sent: unknown[];
    stop: () => Promise<void>;
  }> {
    const changes: Change[] = [];
    const writes: NotesUpdate[] = [];
    const relay = new MeetingRelay({
      store: new MeetingStore(dataDir),
      engines: [silentEngine()],
      // A real notes session, so the trace line the switch writes is
      // observable rather than inferred: `onNotes` is the only place a line
      // reaches the doc from.
      notes: {
        composer: { name: 'never', compose: () => Promise.resolve([]) },
        schedule: new ManualScheduler(),
        now: () => new Date(2026, 8, 9, 10, 38).getTime(),
        readOutline: () => [],
        notesHeadingId: () => 'h-mine',
        onNotes: (u: NotesUpdate) => {
          writes.push(u);
          return true;
        },
      },
      broadcast: () => {},
      setNotesMethod: (c) => {
        changes.push(c);
        return recorded;
      },
    });
    const sent: unknown[] = [];
    const ws: MeetingClient = {
      data: { docId },
      send: (frame: string) => {
        sent.push(JSON.parse(frame));
      },
    };
    relay.onOpen(ws);
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' }));
    await settle();
    return {
      send: (frame) => relay.onText(ws, JSON.stringify(frame)),
      changes,
      writes,
      sent,
      stop: async () => {
        relay.onText(ws, JSON.stringify({ type: 'stop' }));
        await settle();
      },
    };
  }

  /**
   * A READ-ONLY SOCKET IS NOT A WRITER, AND THIS FRAME IS A DURABLE WRITE.
   *
   * `CW_REQUIRE_SIGNIN_TO_WRITE` marks the socket read-only at upgrade, and
   * `start` already refuses on it. This frame writes the doc's note-taker
   * preference without needing a meeting at all, so without the same check it
   * was a way around the REST route's visitor refusal: open the socket, send
   * one frame, change somebody's doc.
   */
  it('refuses a read-only socket, and the doc keeps the note-taker it had', () => {
    const changes: Change[] = [];
    const relay = new MeetingRelay({
      store: new MeetingStore(dataDir),
      engines: [silentEngine()],
      notes: null,
      broadcast: () => {},
      // The real write, so "unchanged" is read off disk rather than off a spy.
      setNotesMethod: (c) => {
        changes.push(c);
        writeNotesMethod(dataDir, c.docId, { method: c.method, at: 1 });
        return true;
      },
    });
    const sent: unknown[] = [];
    const ws: MeetingClient = {
      data: { docId: 'd-ro', readOnly: true },
      send: (frame: string) => sent.push(JSON.parse(frame)),
    };
    relay.onOpen(ws);
    relay.onText(ws, JSON.stringify({ type: 'set_notes_method', method: 'ledger-opus' }));
    expect(changes).toEqual([]);
    expect(readNotesMethod(dataDir, 'd-ro')).toBe(DEFAULT_NOTES_METHOD);
    // Refused out loud, both ways: the row rolls back rather than sitting on
    // a switch that did not happen, and the strip can say why.
    expect(sent).toContainEqual({
      type: 'notes_method',
      method: 'ledger-opus',
      recorded: false,
    });
    expect(sent.some((f) => (f as { type?: string }).type === 'error')).toBe(true);
  });

  it('records the method, who asked, and the meeting it was asked during', async () => {
    const m = await live('d-frame');
    m.send({ type: 'set_notes_method', method: 'ledger-opus', by: 'Maya' });
    await settle();
    expect(m.changes).toHaveLength(1);
    expect(m.changes[0]?.method).toBe('ledger-opus');
    expect(m.changes[0]?.by).toBe('Maya');
    // The meeting id is what separates "changed the doc's default" from
    // "changed it while the room was talking".
    expect(m.changes[0]?.meetingId).toBeTruthy();
    await m.stop();
  });

  it('writes no trace line when the record could not be written', async () => {
    // A data dir that is full, read-only or gone. The write is swallowed on
    // purpose — a preference must never fail a tick — but the doc must not
    // then claim a switch that the next tick will not honour.
    const m = await live('d-nowrite', false);
    m.send({ type: 'set_notes_method', method: 'ledger-opus', by: 'Maya' });
    await settle();
    await m.stop();
    expect(m.writes.flatMap((w) => w.edits)).toEqual([]);
  });

  it('MUTATION CONTROL: the same frame on a dir that CAN be written writes the line', async () => {
    const m = await live('d-wrote', true);
    m.send({ type: 'set_notes_method', method: 'ledger-opus', by: 'Maya' });
    await settle();
    await m.stop();
    const edit = m.writes.flatMap((w) => w.edits)[0];
    expect(edit && 'markdown' in edit ? edit.markdown : '').toBe(
      '- 10:38 Note-taker Ledger · Opus — Maya',
    );
  });

  it('answers the frame, so the chooser is not left guessing', async () => {
    const m = await live('d-ack', true);
    m.send({ type: 'set_notes_method', method: 'ledger-opus', by: 'Maya' });
    await settle();
    await m.stop();
    expect(m.sent).toContainEqual({
      type: 'notes_method',
      method: 'ledger-opus',
      recorded: true,
    });
  });

  it('MUTATION CONTROL: a record that could not be written answers recorded false', async () => {
    const m = await live('d-ack-no', false);
    m.send({ type: 'set_notes_method', method: 'ledger-opus', by: 'Maya' });
    await settle();
    await m.stop();
    expect(m.sent).toContainEqual({
      type: 'notes_method',
      method: 'ledger-opus',
      recorded: false,
    });
  });

  it('MUTATION CONTROL: a method this server does not know changes nothing', async () => {
    const m = await live('d-frame-bad');
    m.send({ type: 'set_notes_method', method: 'ledger-sonnet-9', by: 'Maya' });
    await settle();
    // Dropped by the parser, not defaulted: a client one version ahead must
    // not silently reset this doc to the original note-taker.
    expect(m.changes).toEqual([]);
    await m.stop();
  });

  it('the frame parses to the method alone when nobody is named', () => {
    const parsed = parseMeetingClientMessage(
      JSON.stringify({ type: 'set_notes_method', method: 'ledger-haiku' }),
    );
    expect(parsed).toEqual({ type: 'set_notes_method', method: 'ledger-haiku' });
    expect(
      parseMeetingClientMessage(JSON.stringify({ type: 'set_notes_method', method: 'nonsense' })),
    ).toBeNull();
  });
});

describe('the trace line a change writes into the notes', () => {
  it('names the time, the note-taker and who asked', () => {
    const at = new Date(2026, 8, 9, 10, 38).getTime();
    expect(notesMethodTraceLine(notesMethodLabel('ledger-opus'), 'Maya', at)).toBe(
      '10:38 Note-taker Ledger · Opus — Maya',
    );
  });

  it('drops the dash rather than guessing a name', () => {
    const at = new Date(2026, 8, 9, 9, 5).getTime();
    expect(notesMethodTraceLine(notesMethodLabel('original'), undefined, at)).toBe(
      '09:05 Note-taker Original',
    );
  });
});

describe('the at-rest route', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws = '';

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-notes-method-route-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    ws = await seedBoard(base);
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const url = (docId: string) => `/workspaces/${ws}/docs/${docId}/notes-method`;

  /** A doc this board holds — the scope middleware answers 404 for one it
   *  does not, whatever the route below would have said. */
  const createDoc = async (docId: string): Promise<void> => {
    const path = join(dataDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nNotes go here.\n`);
    const r = await call(`/workspaces/${ws}/docs`, {
      method: 'POST',
      body: JSON.stringify({ docId, sourceUrl: path, title: docId }),
    });
    expect(r.status, await r.clone().text()).toBe(200);
  };

  it('answers the original for a doc nobody has chosen for', async () => {
    await createDoc('d-rest-a');
    const r = await call(url('d-rest-a'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { method: string; changes: unknown[] };
    expect(body.method).toBe(DEFAULT_NOTES_METHOD);
    expect(body.changes).toEqual([]);
  });

  it('a PUT is what the next meeting on that doc composes with, and it survives', async () => {
    await createDoc('d-rest-b');
    const r = await call(url('d-rest-b'), {
      method: 'PUT',
      body: JSON.stringify({ method: 'ledger-haiku', by: 'Devin' }),
    });
    expect(r.status, await r.clone().text()).toBe(200);
    // The record is filed under the doc's OWN id, not the alias the caller
    // typed — the same canonicalization the meetings routes do, so a doc
    // reached by either name has one answer.
    const { docId } = (await r.json()) as { docId: string };
    // Read off DISK, not out of the response: the record is the deliverable,
    // and a reload is what the owner's rule asks it to survive.
    expect(readNotesMethod(dataDir, docId)).toBe('ledger-haiku');
    const held = readNotesMethodRecord(dataDir, docId);
    expect(held?.changes.at(-1)?.by).toBe('Devin');
    // At rest, so no meeting is named — that is the difference the record
    // keeps between the two ways of asking.
    expect(held?.changes.at(-1)?.meetingId).toBeUndefined();
  });

  it('refuses a note-taker it does not have rather than falling back', async () => {
    await createDoc('d-rest-c');
    const r = await call(url('d-rest-c'), {
      method: 'PUT',
      body: JSON.stringify({ method: 'ledger-sonnet-9' }),
    });
    expect(r.status).toBe(400);
    const held = await call(url('d-rest-c'));
    expect(((await held.json()) as { method: string }).method).toBe(DEFAULT_NOTES_METHOD);
  });
});

describe('a live meeting keeps the at-rest route out', () => {
  // The route is driven directly, with only the collaborators it reads: the
  // refusal is a decision this handler makes, and building a whole server
  // with a real audio socket to reach it would test the socket instead.
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-notes-method-live-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** What the route asks the bot relay, and what it told it. */
  interface BotStub {
    live: boolean;
    said: { docId: string; label: string; by?: string }[];
  }

  function ctxWith(meetingStore: MeetingStore, bot?: BotStub): MeetingCalendarRoutesContext {
    return {
      docStore: { get: () => undefined },
      meetingStore,
      dataDir,
      recallRelay: {
        hasLiveNotes: () => bot?.live ?? false,
        noteMethodChange: (docId: string, label: string, by?: string) => {
          bot?.said.push({ docId, label, ...(by ? { by } : {}) });
          return bot?.live ?? false;
        },
      },
      j: (status: number, body: unknown) => Response.json(body, { status }),
      isValidDocId: () => true,
    } as unknown as MeetingCalendarRoutesContext;
  }

  async function put(
    meetingStore: MeetingStore,
    docId: string,
    bot?: BotStub,
  ): Promise<Response | undefined> {
    const rest = `docs/${docId}/notes-method`;
    return handleMeetingCalendarRoutes(ctxWith(meetingStore, bot), {
      scope: { workspaceId: 'w-1', rest, board: {} } as never,
      req: new Request(`http://localhost/workspaces/w-1/${rest}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'ledger-opus', by: 'Maya' }),
      }),
      url: new URL(`http://localhost/workspaces/w-1/${rest}`),
      pathname: `/workspaces/w-1/${rest}`,
      visitor: null,
    });
  }

  it('refuses with 409 and leaves the record where it was', async () => {
    const store = new MeetingStore(dataDir);
    expect(
      store.start({ docId: 'd-live', engine: 'mock', sampleRate: 16_000, mode: 'solo' }),
    ).not.toBeNull();
    const r = await put(store, 'd-live');
    expect(r?.status).toBe(409);
    expect(readNotesMethod(dataDir, 'd-live')).toBe(DEFAULT_NOTES_METHOD);
  });

  it('MUTATION CONTROL: the same call on a quiet doc writes', async () => {
    const store = new MeetingStore(dataDir);
    const r = await put(store, 'd-quiet');
    expect(r?.status).toBe(200);
    expect(readNotesMethod(dataDir, 'd-quiet')).toBe('ledger-opus');
  });

  /**
   * A BOT MEETING IS LIVE WITH NO SOCKET TO SEND IT OVER.
   *
   * The refusal above is addressed to a meeting whose audio websocket exists;
   * a vendor bot meeting has none, because nobody in the room is listening.
   * Refusing it here made the mid-meeting switch impossible for exactly the
   * meetings a person watches from the doc rather than from the recording
   * device.
   */
  it('takes the change for a LIVE BOT meeting, and the bot’s notes get the one line', async () => {
    const store = new MeetingStore(dataDir);
    expect(
      store.start({ docId: 'd-bot', engine: 'bot', sampleRate: 16_000, mode: 'conversation' }),
    ).not.toBeNull();
    const bot: BotStub = { live: true, said: [] };
    const r = await put(store, 'd-bot', bot);
    expect(r?.status, await r?.clone().text()).toBe(200);
    expect(readNotesMethod(dataDir, 'd-bot')).toBe('ledger-opus');
    // The line is a report of the write, so it names the method that landed
    // and the person who asked — the same two the socket path writes.
    expect(bot.said).toEqual([
      { docId: 'd-bot', label: notesMethodLabel('ledger-opus'), by: 'Maya' },
    ]);
  });

  it('names the meeting it was made in, so the history is not read as at-rest', async () => {
    const store = new MeetingStore(dataDir);
    const started = store.start({
      docId: 'd-botid',
      engine: 'bot',
      sampleRate: 16_000,
      mode: 'conversation',
    });
    expect(started).not.toBeNull();
    const bot: BotStub = { live: true, said: [] };
    expect((await put(store, 'd-botid', bot))?.status).toBe(200);
    const held = readNotesMethodRecord(dataDir, 'd-botid');
    expect(held?.changes.at(-1)?.meetingId).toBe(started?.meetingId);
  });

  /**
   * PICKING THE METHOD THAT IS ALREADY ON, during a bot meeting.
   *
   * Without the meeting's id the store reads it as a no-op repeat and keeps
   * it out of the history — while the trace line went into the notes anyway,
   * claiming a switch the record does not carry. Named with the meeting, it
   * is a re-affirmation made inside a recording, which is exactly what the
   * trace line is written from.
   */
  it('records picking the current method again during a bot meeting, and writes its line', async () => {
    const store = new MeetingStore(dataDir);
    // Already on the method the PUT asks for.
    writeNotesMethod(dataDir, 'd-bsame', { method: 'ledger-opus', at: 1 });
    expect(
      store.start({ docId: 'd-bsame', engine: 'bot', sampleRate: 16_000, mode: 'conversation' }),
    ).not.toBeNull();
    const bot: BotStub = { live: true, said: [] };
    expect((await put(store, 'd-bsame', bot))?.status).toBe(200);
    const held = readNotesMethodRecord(dataDir, 'd-bsame');
    expect(held?.changes).toHaveLength(2);
    expect(held?.changes.at(-1)?.by).toBe('Maya');
    expect(bot.said).toHaveLength(1);
  });

  it('MUTATION CONTROL: the same repeat at rest is neither recorded nor announced', async () => {
    const store = new MeetingStore(dataDir);
    writeNotesMethod(dataDir, 'd-qsame', { method: 'ledger-opus', at: 1 });
    const bot: BotStub = { live: false, said: [] };
    expect((await put(store, 'd-qsame', bot))?.status).toBe(200);
    expect(readNotesMethodRecord(dataDir, 'd-qsame')?.changes).toHaveLength(1);
    expect(bot.said).toEqual([]);
  });

  /**
   * AT THE CAP, AN APPEND DOES NOT MAKE THE HISTORY LONGER.
   *
   * `MAX_KEPT_CHANGES` entries in, every further change drops the oldest, so
   * a caller reading "did it record?" off the length of `changes` reads false
   * for a change that was written — and from the fifty-first switch on, a
   * live bot meeting would stop writing its trace line for good.
   */
  it('writes the line for a change made on a doc whose history is already full', async () => {
    const store = new MeetingStore(dataDir);
    for (let i = 0; i < MAX_KEPT_CHANGES; i++) {
      writeNotesMethod(dataDir, 'd-full', {
        method: i % 2 === 0 ? 'ledger-haiku' : 'original',
        at: i + 1,
        meetingId: `m-${i}`,
      });
    }
    expect(readNotesMethodRecord(dataDir, 'd-full')?.changes).toHaveLength(MAX_KEPT_CHANGES);
    expect(
      store.start({ docId: 'd-full', engine: 'bot', sampleRate: 16_000, mode: 'conversation' }),
    ).not.toBeNull();
    const bot: BotStub = { live: true, said: [] };
    expect((await put(store, 'd-full', bot))?.status).toBe(200);
    // The change landed — the newest entry is this one — and the length is
    // exactly where it was, which is the whole trap.
    const held = readNotesMethodRecord(dataDir, 'd-full');
    expect(held?.changes).toHaveLength(MAX_KEPT_CHANGES);
    expect(held?.changes.at(-1)?.by).toBe('Maya');
    expect(bot.said).toHaveLength(1);
  });

  it('still refuses a live meeting the bot relay does not hold, and writes no line', async () => {
    const store = new MeetingStore(dataDir);
    expect(
      store.start({ docId: 'd-mic', engine: 'mock', sampleRate: 16_000, mode: 'solo' }),
    ).not.toBeNull();
    const bot: BotStub = { live: false, said: [] };
    const r = await put(store, 'd-mic', bot);
    expect(r?.status).toBe(409);
    expect(readNotesMethod(dataDir, 'd-mic')).toBe(DEFAULT_NOTES_METHOD);
    expect(bot.said).toEqual([]);
  });
});

describe('the line the live session writes', () => {
  // The visible half of a mid-meeting switch: one line under this meeting's
  // own heading, and nothing else touched.
  const ids = { docId: 'd-trace', meetingId: 'm-trace-1' };

  function session(headingId: string | undefined): {
    s: MeetingNotesSession;
    writes: NotesUpdate[];
    errors: string[];
  } {
    const writes: NotesUpdate[] = [];
    const errors: string[] = [];
    const s = beginNotesSession(
      {
        composer: { name: 'never', compose: () => Promise.resolve([]) },
        schedule: new ManualScheduler(),
        now: () => new Date(2026, 8, 9, 10, 38).getTime(),
        readOutline: () => [],
        notesHeadingId: () => headingId,
        onNotes: (u) => {
          writes.push(u);
          return true;
        },
        onError: (m) => errors.push(m),
      },
      ids,
    );
    return { s, writes, errors };
  }

  it('goes under the meeting’s own heading, as one bullet, charged to no tick', async () => {
    const h = session('h-mine');
    h.s.noteMethodChange(notesMethodLabel('ledger-opus'), 'Maya');
    await h.s.end();
    expect(h.writes).toHaveLength(1);
    const edit = h.writes[0]?.edits[0];
    expect(edit?.op).toBe('insert_under_heading');
    expect(edit && 'markdown' in edit ? edit.markdown : '').toBe(
      '- 10:38 Note-taker Ledger · Opus — Maya',
    );
    // No words were said, so a sink that counts what a tick wrote must not
    // charge the room for this line.
    expect(h.writes[0]?.tick.turns).toEqual([]);
  });

  it('the held line lands under this meeting’s heading once the first tick opens it', async () => {
    // The whole point of holding it: the trace ends up INSIDE the minutes it
    // describes, and still reading the time of the change.
    const writes: NotesUpdate[] = [];
    const sched = new ManualScheduler();
    let heading: string | undefined;
    const s = beginNotesSession(
      {
        composer: {
          name: 'opens',
          compose: () => {
            // The compose is what opens the section, so the heading exists
            // from the moment its edits are applied.
            heading = 'h-mine';
            return Promise.resolve([{ op: 'insert_at_end', markdown: '- a first bullet' }]);
          },
        },
        schedule: sched,
        now: () => new Date(2026, 8, 9, 10, 38).getTime(),
        readOutline: () => [],
        notesHeadingId: () => heading,
        onNotes: (u) => {
          writes.push(u);
          return true;
        },
      },
      ids,
    );
    s.noteMethodChange(notesMethodLabel('ledger-opus'), 'Maya');
    s.onTurn({ turn: 1, text: 'the boardwalk needs a survey', speaker: 'A', final: true });
    sched.fire();
    await s.end();
    const traces = writes
      .flatMap((w) => w.edits)
      .filter((e) => 'markdown' in e && e.markdown.includes('Note-taker'));
    expect(traces).toHaveLength(1);
    expect(traces[0]?.op).toBe('insert_under_heading');
    expect(traces[0] && 'markdown' in traces[0] ? traces[0].markdown : '').toBe(
      '- 10:38 Note-taker Ledger · Opus — Maya',
    );
  });

  /**
   * THE SECTION THE TICK JUST CREATED IS NOT IN THE OUTLINE THE TICK READ.
   *
   * A resolver that derives the heading from the outline it is handed — which
   * is what the server's does — is handed a snapshot taken BEFORE the edits
   * were applied. Resolving the held line from it on the one tick that opens
   * the section finds nothing, so the line waits for a tick that may never
   * come, and a meeting that ends there drops it with the section sitting
   * right in the doc.
   */
  it('lands the held line on the opening tick even when the heading comes from the outline', async () => {
    const writes: NotesUpdate[] = [];
    const sched = new ManualScheduler();
    const opened: prose.OutlineEntry[] = [
      { id: 'h-mine', kind: 'heading', nodeName: 'h2', level: 2, text: 'Meeting notes' },
    ];
    // Flipped by the write itself, so the two outlines are the real before
    // and after of the compose that opens the section.
    let applied = false;
    const s = beginNotesSession(
      {
        composer: {
          name: 'opens',
          compose: () => Promise.resolve([{ op: 'insert_at_end', markdown: '- a first bullet' }]),
        },
        schedule: sched,
        now: () => new Date(2026, 8, 9, 10, 38).getTime(),
        readOutline: () => (applied ? opened : []),
        notesHeadingId: ({ outline }) => outline.find((e) => e.id === 'h-mine')?.id,
        onNotes: (u) => {
          writes.push(u);
          if (u.tick.turns.length > 0) applied = true;
          return true;
        },
      },
      ids,
    );
    s.noteMethodChange(notesMethodLabel('ledger-opus'), 'Maya');
    s.onTurn({ turn: 1, text: 'the boardwalk needs a survey', speaker: 'A', final: true });
    sched.fire();
    // The meeting ends on the same tick that opened the section: there is no
    // second tick to carry the line, which is the case that lost it.
    await s.end();
    const traces = writes
      .flatMap((w) => w.edits)
      .filter((e) => 'markdown' in e && e.markdown.includes('Note-taker'));
    expect(traces).toHaveLength(1);
    expect(traces[0]?.op).toBe('insert_under_heading');
    expect(traces[0] && 'headingId' in traces[0] ? traces[0].headingId : '').toBe('h-mine');
  });

  it('WAITS when this meeting has opened no section yet, rather than going to the doc end', async () => {
    // Written at the end of the DOCUMENT, the line would be overtaken: the
    // first compose opens this meeting's section below it, so the trace ends
    // up outside the minutes it describes — or inside the previous meeting's.
    const h = session(undefined);
    h.s.noteMethodChange(notesMethodLabel('original'), undefined);
    await h.s.end();
    expect(h.writes.flatMap((w) => w.edits)).toEqual([]);
    expect(h.errors.join(' ')).toContain('never opened a notes section');
  });

  /**
   * A DOC THAT WOULD NOT TAKE THE LINE HAS NOT BEEN TOLD ANYTHING.
   *
   * `onNotes` answers `false` or `'refused'` for a write the doc rejected —
   * a concurrent edit, or the edit guard. The preference behind the line is
   * already recorded by then, so discarding it leaves the doc missing the
   * switch marker it promised with no way back. It is held instead, the way
   * the compose path carries words a refused write never landed.
   */
  for (const answer of [false, 'refused'] as const) {
    it(`keeps the line when the doc answers ${JSON.stringify(answer)}, and writes it on the next take`, async () => {
      const writes: NotesUpdate[] = [];
      let take = false;
      const s = beginNotesSession(
        {
          composer: { name: 'never', compose: () => Promise.resolve([]) },
          schedule: new ManualScheduler(),
          now: () => new Date(2026, 8, 9, 10, 38).getTime(),
          readOutline: () => [],
          notesHeadingId: () => 'h-mine',
          onNotes: (u) => {
            if (!take) return answer;
            writes.push(u);
            return true;
          },
        },
        ids,
      );
      s.noteMethodChange(notesMethodLabel('ledger-opus'), 'Maya');
      // Nothing reached the doc, and nothing was thrown away either.
      await settle();
      expect(writes).toEqual([]);
      take = true;
      s.noteMethodChange(notesMethodLabel('original'), 'Maya');
      await s.end();
      const traces = writes
        .flatMap((w) => w.edits)
        .filter((e) => 'markdown' in e && e.markdown.includes('Note-taker'));
      // Both lines: the one the doc refused, and the one it took.
      expect(traces).toHaveLength(2);
      expect(traces.map((e) => ('markdown' in e ? e.markdown : ''))).toEqual([
        '- 10:38 Note-taker Ledger · Opus — Maya',
        '- 10:38 Note-taker Original — Maya',
      ]);
    });
  }

  it('MUTATION CONTROL: the same change with a section already there is written at once', async () => {
    const h = session('h-mine');
    h.s.noteMethodChange(notesMethodLabel('original'), undefined);
    await h.s.end();
    expect(h.writes.flatMap((w) => w.edits)[0]?.op).toBe('insert_under_heading');
    expect(h.errors.join(' ')).not.toContain('never opened a notes section');
  });
});
