/**
 * A Record press on a person's own doc, through the real server.
 *
 * A page that can follow says so on its `start` (`handoff`). On a doc holding
 * the person's own writing the server then opens no meeting: it makes a notes
 * doc, links it from the original, and answers `notes_doc`, and the page
 * records on the notes doc, where the notes land in the editor the person is
 * watching. A doc with only a title records where it is.
 *
 * The tidy-up of a meeting whose notes went to a notes doc reads and writes
 * that doc, and leaves the person's own doc as it was.
 *
 * The engine is the mock and the composer is the stub: no network, no bill.
 * All fixtures are synthetic and every name is a house fixture name. The repo
 * is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
  prose,
} from '@claude-workspaces/core';
import { type TickScheduler, createStubNotesComposer } from '../src/meeting-notes.ts';
import {
  listMeetings,
  meetingDirPath,
  meetingIndexPath,
  meetingNotesDocPath,
  meetingTranscriptPath,
} from '../src/meetings.ts';
import { createNotesHeadingFileStore } from '../src/notes-heading-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { waitFor as pollUntil } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/** Advanced by hand: `fire()` is the speaker going quiet. */
class ManualScheduler implements TickScheduler {
  private fns = new Map<number, () => void>();
  private n = 0;
  set(fn: () => void, _ms: number): unknown {
    this.n++;
    this.fns.set(this.n, fn);
    return this.n;
  }
  clear(handle: unknown): void {
    this.fns.delete(handle as number);
  }
  fire(): void {
    const pending = [...this.fns.values()];
    this.fns.clear();
    for (const fn of pending) fn();
  }
}

const SCRIPT: readonly MockScriptTurn[] = [
  { words: ['the', 'ferry', 'runs'], settled: 'The Harborlight ferry runs at six.', speaker: 'A' },
];

interface Frame {
  type: string;
  [key: string]: unknown;
}

/** Poll until `pred` holds; the house loop, so no fixed wait is declared. */
const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
  await pollUntil(() => pred() || undefined, { describe: what, timeout: 2_000 });
};

let handle: ServerHandle;
let base: string;
let wsBase: string;
let dataDir: string;
let WS = '';
const schedule = new ManualScheduler();

const markdownOf = (docId: string): string => {
  const doc = handle.docStore.get(docId);
  if (!doc) throw new Error(`no doc ${docId}`);
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
};

/** Every block of the doc, ids and marks included, in order. */
const blocksOf = (docId: string): string[] => {
  const doc = handle.docStore.get(docId);
  if (!doc) throw new Error(`no doc ${docId}`);
  return prose.addressableBlocks(prose.getProseFragment(doc.ydoc)).map((el) => el.toString());
};

/** A markdown doc bound to a file under the data dir, filed on the board. */
async function createDoc(name: string, title: string, body: string): Promise<string> {
  const path = join(dataDir, `${name}.md`);
  writeFileSync(path, body);
  const res = await fetch(`${base}/workspaces/${WS}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: name, sourceUrl: path, title }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { docId: string }).docId;
}

/** Open the doc's audio socket and send a first `start`. */
async function startOn(
  docId: string,
  handoff: boolean,
): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const ws = new WebSocket(`${wsBase}${meetingSocketPath(WS, docId)}`);
  ws.binaryType = 'arraybuffer';
  const frames: Frame[] = [];
  ws.addEventListener('message', (ev) => frames.push(JSON.parse(ev.data as string) as Frame));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('audio socket refused')));
  });
  ws.send(
    JSON.stringify({
      type: 'start',
      sampleRate: MEETING_SAMPLE_RATE,
      encoding: MEETING_AUDIO_ENCODING,
      mode: 'solo',
      ...(handoff ? { handoff: true } : {}),
    }),
  );
  await waitFor(
    () => frames.some((f) => f.type === 'ready' || f.type === 'notes_doc'),
    'an answer',
  );
  return { ws, frames };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'cw-notes-handoff-'));
  handle = createServer({
    port: 0,
    dataDir,
    transcription: createMockTranscriptionEngine(SCRIPT),
    meetingNotes: { composer: createStubNotesComposer(), quietMs: 1_000, schedule },
  });
  base = `http://127.0.0.1:${handle.port}`;
  wsBase = `ws://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a Record press on a doc holding the person’s own writing', () => {
  it('opens no meeting there and sends the page to a linked notes doc, where notes land', async () => {
    const source = await createDoc(
      'harbour-plan',
      'Harbour plan',
      '# Harbour plan\n\nWhat I want settled before the season opens.\n',
    );
    // Block ids are stored by the doc's first write, and the link line is
    // one; store them first so the snapshot compares content, not ids.
    const sourceDoc = handle.docStore.get(source);
    if (!sourceDoc) throw new Error(`no doc ${source}`);
    prose.ensureBlockIds(sourceDoc.ydoc);
    const before = blocksOf(source);

    const press = await startOn(source, true);
    const moved = press.frames.find((f) => f.type === 'notes_doc');
    expect(moved, JSON.stringify(press.frames)).toBeDefined();
    expect(press.frames.some((f) => f.type === 'ready')).toBe(false);
    press.ws.close();
    // No meeting, so no transcript, no engine session and no bill.
    expect(listMeetings(dataDir, source)).toEqual([]);

    const notesDocId = String(moved?.docId);
    expect(notesDocId).not.toBe(source);
    expect(moved?.url).toBe(`/workspaces/${WS}/docs/${notesDocId}`);
    expect(moved?.title).toBe('Harbour plan — meeting notes');
    // Filed on the source's board: the board answers for it, as it does for
    // the source (the control), and refuses a doc it does not hold.
    const filed = async (id: string): Promise<number> =>
      (await fetch(`${base}/workspaces/${WS}/docs/${id}/meetings`)).status;
    expect(await filed(source)).toBe(200);
    expect(await filed(notesDocId)).toBe(200);
    expect(await filed('d-nowhere')).toBe(404);
    expect(handle.docStore.get(notesDocId)?.meta.huddle).toBe(true);

    // The original keeps every block it had, byte for byte, and gains one
    // line: the link.
    const after = blocksOf(source);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(markdownOf(source)).toContain(
      `Meeting notes: [Harbour plan — meeting notes](/workspaces/${WS}/docs/${notesDocId})`,
    );

    // The page records on the notes doc. It is a huddle, so it writes in
    // place even though it asked to hand off.
    const meeting = await startOn(notesDocId, true);
    expect(meeting.frames.some((f) => f.type === 'ready')).toBe(true);
    for (let i = 0; i < SCRIPT[0]!.words.length + 1; i++) meeting.ws.send(new Uint8Array(640));
    await waitFor(
      () => meeting.frames.some((f) => f.type === 'transcript' && f.final === true),
      'the settled turn',
    );
    schedule.fire();
    await waitFor(
      () => markdownOf(notesDocId).includes('The Harborlight ferry runs at six.'),
      'the note in the notes doc',
    );
    meeting.ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => meeting.frames.some((f) => f.type === 'stopped'), 'stopped');
    meeting.ws.close();
    expect(markdownOf(source)).not.toContain('The Harborlight ferry runs at six.');
    expect(blocksOf(source).slice(0, before.length)).toEqual(before);
  });

  it('records in place on a doc holding only its title', async () => {
    const titled = await createDoc('river-sync', 'River sync', '# River sync\n');
    const press = await startOn(titled, true);
    expect(press.frames.some((f) => f.type === 'ready')).toBe(true);
    expect(press.frames.some((f) => f.type === 'notes_doc')).toBe(false);
    press.ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => press.frames.some((f) => f.type === 'stopped'), 'stopped');
    press.ws.close();
    expect(markdownOf(titled)).not.toContain('Meeting notes: [');
  });
});

describe('the tidy-up of a meeting whose notes went to a notes doc', () => {
  it('reads and writes the notes doc, and leaves the original as it was', async () => {
    const MEETING = 'm-saltmarsh-1';
    const source = await createDoc(
      'saltmarsh-plan',
      'Saltmarsh plan',
      '# Saltmarsh plan\n\nA paragraph I wrote myself.\n\nMeeting notes: [Saltmarsh plan — meeting notes](/x)\n',
    );
    const notes = await createDoc(
      'saltmarsh-notes',
      'Saltmarsh plan — meeting notes',
      '# Saltmarsh plan — meeting notes\n\n## Slipway\n\n- The harbour run moves to the half hour\n',
    );
    // What the meeting left on disk, all keyed by the doc it was started on:
    // the transcript, the index line, the section it opened (a heading in the
    // notes doc) and the record of where its notes went.
    mkdirSync(meetingDirPath(dataDir, source), { recursive: true });
    writeFileSync(
      meetingTranscriptPath(dataDir, source, MEETING),
      `${[
        { turn: 0, text: 'The slipway closes for maintenance in October.', ts: 1 },
        { turn: 1, text: 'The winter crew stays on until April.', ts: 2 },
      ]
        .map((t) => JSON.stringify(t))
        .join('\n')}\n`,
    );
    writeFileSync(
      meetingIndexPath(dataDir, source),
      `${JSON.stringify({ meetingId: MEETING, docId: source, startedAt: 1, engine: 'mock', sampleRate: 16000 })}\n${JSON.stringify({ meetingId: MEETING, endedAt: 3, turns: 2 })}\n`,
    );
    const heading = (handle.docStore.readOutline(notes)?.blocks ?? []).find(
      (b) => b.text === 'Slipway',
    );
    if (!heading) throw new Error('no notes heading in the fixture');
    createNotesHeadingFileStore(dataDir).write({ docId: source, meetingId: MEETING }, heading.id);
    for (const el of prose.addressableBlocks(
      prose.getProseFragment(handle.docStore.get(notes)!.ydoc),
    ))
      if (el.toString().includes('harbour run')) el.setAttribute('cwAuthor', 'meeting-notes');
    writeFileSync(
      meetingNotesDocPath(dataDir, source, MEETING),
      `${JSON.stringify({ docId: source, meetingId: MEETING, notesDocId: notes, at: 1 })}\n`,
    );
    const before = blocksOf(source);
    const tidy = (): Promise<Response> =>
      fetch(`${base}/workspaces/${WS}/docs/${source}/meetings/${MEETING}/notes-cleanup`, {
        method: 'POST',
      });

    // Somebody recording on the notes doc is writing the section this pass
    // would rewrite, so it waits, as it does for a recording on the original.
    const live = await startOn(notes, false);
    expect(live.frames.some((f) => f.type === 'ready')).toBe(true);
    expect((await tidy()).status).toBe(409);
    live.ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => live.frames.some((f) => f.type === 'stopped'), 'stopped');
    live.ws.close();

    const res = await fetch(
      `${base}/workspaces/${WS}/docs/${source}/meetings/${MEETING}/notes-cleanup`,
      { method: 'POST' },
    );
    const body = (await res.json()) as { ok: boolean; turns: number; touched: number };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.turns).toBe(2);
    expect(body.touched).toBeGreaterThan(0);
    expect(markdownOf(notes)).toContain('The slipway closes for maintenance in October.');
    expect(blocksOf(source)).toEqual(before);
  });
});
