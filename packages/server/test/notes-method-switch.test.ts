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
} from '@claude-workspaces/core';
import {
  type MeetingNotesSession,
  type NotesUpdate,
  beginNotesSession,
} from '../src/meeting-notes.ts';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { MeetingStore } from '../src/meetings.ts';
import { readNotesMethod, readNotesMethodRecord } from '../src/notes-method-store.ts';
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
    const ws: MeetingClient = { data: { docId }, send: () => {} };
    relay.onOpen(ws);
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' }));
    await settle();
    return {
      send: (frame) => relay.onText(ws, JSON.stringify(frame)),
      changes,
      writes,
      stop: async () => {
        relay.onText(ws, JSON.stringify({ type: 'stop' }));
        await settle();
      },
    };
  }

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

  function ctxWith(meetingStore: MeetingStore): MeetingCalendarRoutesContext {
    return {
      docStore: { get: () => undefined },
      meetingStore,
      dataDir,
      j: (status: number, body: unknown) => Response.json(body, { status }),
      isValidDocId: () => true,
    } as unknown as MeetingCalendarRoutesContext;
  }

  async function put(meetingStore: MeetingStore, docId: string): Promise<Response | undefined> {
    const rest = `docs/${docId}/notes-method`;
    return handleMeetingCalendarRoutes(ctxWith(meetingStore), {
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
});

describe('the line the live session writes', () => {
  // The visible half of a mid-meeting switch: one line under this meeting's
  // own heading, and nothing else touched.
  const ids = { docId: 'd-trace', meetingId: 'm-trace-1' };

  function session(headingId: string | undefined): {
    s: MeetingNotesSession;
    writes: NotesUpdate[];
  } {
    const writes: NotesUpdate[] = [];
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
      },
      ids,
    );
    return { s, writes };
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

  it('falls to the end of the doc when this meeting has opened no section', async () => {
    const h = session(undefined);
    h.s.noteMethodChange(notesMethodLabel('original'), undefined);
    await h.s.end();
    expect(h.writes[0]?.edits[0]?.op).toBe('insert_at_end');
  });
});
