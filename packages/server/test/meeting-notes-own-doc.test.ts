/**
 * A MEETING ON A PERSON'S OWN DOC WRITES ITS NOTES INTO A DOC OF ITS OWN.
 *
 * The owner, 2026-10-04, after a meeting filed its notes among the paragraphs
 * of a doc he had written: "Put them in a separate doc and don't mess up my
 * original doc." These cases drive the real notes sinks over a two-doc store
 * and check the original's blocks are untouched, the notes doc holds the
 * notes, the original links to it in one line, a resume keeps the same notes
 * doc, and a doc with nothing of a person's in it keeps today's behaviour.
 *
 * All fixtures are synthetic and every name is a house fixture name. The repo
 * is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type prose, prose as proseNs } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  type NotesHeadingMemory,
  createNotesHeadingMemory,
  withServerNotesSinks,
} from '../src/meeting-notes-doc.ts';
import {
  HANDOFF_REUSE_MS,
  type NotesDocMint,
  createNotesTargets,
  createServerNotesDocMint,
  holdsOwnWriting,
} from '../src/meeting-notes-target.ts';
import { type NotesComposeInput, beginNotesSession } from '../src/meeting-notes.ts';
import { meetingDirPath, meetingTranscriptPath } from '../src/meetings.ts';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import { readNotesQuality } from '../src/notes-quality-store.ts';
import { createNotesWrittenBlocks } from '../src/notes-written-blocks.ts';
import { type TestDoc, markdownOfDoc, notesDocStore } from './notes-doc-helpers.ts';
import { ManualScheduler, addNotes } from './notes-tick-harness.ts';
import { waitFor } from './wait-for.ts';

const SOURCE = 'd-river';
const MEETING = 'm-1760000000077';

const OWN_DOC = [
  '# Riverbend plan',
  '',
  '## Ferry timetable',
  '',
  'What I want settled before the season opens.',
  '',
  '## Slipway signage',
  '',
  'The boards we have are older than the slipway.',
  '',
].join('\n');

const SAID = [
  'The Harborlight ferry leaves at six every weekday morning.',
  'Riverbend passengers change boats at the northern pontoon.',
  'Winter timetable drops the late crossing after October.',
  'Saltmarsh cyclists need racks on the lower deck.',
  'Ticket prices rise by fifty pence in April.',
  'The slipway boards need replacing before the regatta.',
  'New signage goes up beside the harbour office.',
  'Lettering stays white on dark blue paint.',
  'The harbour master approves every sign before printing.',
  'Printing quotes arrive from three local workshops.',
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function docFrom(markdown: string, meta: TestDoc['meta'] = { type: 'markdown' }): TestDoc {
  const ydoc = new Y.Doc();
  if (markdown) proseNs.applyMarkdownToFragment(proseNs.getProseFragment(ydoc), markdown);
  return { ydoc, meta };
}

/** Every top-level block, as Yjs serializes it: content, ids and marks. */
function blocksOf(ydoc: Y.Doc): string[] {
  return proseNs
    .getProseFragment(ydoc)
    .toArray()
    .map((el) => el.toString());
}

/** A world of docs, and a mint that adds a fresh one to it. */
function world(source: TestDoc) {
  const docs: Record<string, TestDoc> = { [SOURCE]: source };
  const store = notesDocStore(docs);
  const minted: string[] = [];
  const mint: NotesDocMint = (from) => {
    const docId = `d-notes-${minted.length + 1}`;
    const title = `${from.title ?? 'Untitled'} — meeting notes`;
    const doc = docFrom('', { type: 'markdown', title, huddle: true });
    proseNs.clearAuthorshipOnPersonEdit(doc.ydoc);
    docs[docId] = doc;
    minted.push(docId);
    return { docId, title, url: `/workspaces/w-1/docs/${docId}` };
  };
  return { docs, store, minted, mint };
}

/** One recording leg over the real notes sinks: speak, tick, stop. */
async function leg(opts: {
  w: ReturnType<typeof world>;
  heading: NotesHeadingMemory;
  dataDir: string;
  say: readonly string[];
  compose: (input: NotesComposeInput, tick: number) => readonly prose.BlockEdit[];
}): Promise<void> {
  const schedule = new ManualScheduler();
  const done = new Set<number>();
  const deps = withServerNotesSinks(
    {
      composer: {
        name: 'scripted',
        compose: async (input: NotesComposeInput) => opts.compose(input, input.tick.tick),
      },
      cadenceMs: Number.POSITIVE_INFINITY,
      schedule,
      onTickLifecycle: (event) => {
        if (event.phase !== 'composing') done.add(event.tick);
      },
    },
    {
      docStore: () => opts.w.store,
      tasks: () => ({ listTasks: () => [] }),
      dataDir: opts.dataDir,
      heading: opts.heading,
      mintNotesDoc: opts.w.mint,
    },
  );
  const session = beginNotesSession(deps, { docId: SOURCE, meetingId: MEETING });
  opts.say.forEach((text, turn) => {
    session.onTurn({ turn, text: text.slice(0, -1), final: false });
    session.onTurn({ turn, text, final: true });
  });
  schedule.fire();
  await waitFor(() => done.has(1), { describe: 'the first tick to be written' });
  await session.end();
}

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-own-doc-'));
  dirs.push(dir);
  mkdirSync(meetingDirPath(dir, SOURCE), { recursive: true });
  writeFileSync(
    meetingTranscriptPath(dir, SOURCE, MEETING),
    `${SAID.map((text, turn) => JSON.stringify({ turn, text, ts: 1_000 + turn })).join('\n')}\n`,
  );
  return dir;
}

const NOTES = (input: NotesComposeInput, tick: number) =>
  tick === 1 ? addNotes(input, SAID.map((s) => `- ${s}`).join('\n'), 'Ferry and signage') : [];

describe('a meeting on a doc with a person’s own writing', () => {
  it('leaves every original block as it was and writes the notes to a linked doc', async () => {
    const source = docFrom(OWN_DOC, { type: 'markdown', title: 'Riverbend plan' });
    const w = world(source);
    // Ids are stored by the doc's first write, and the link line is one;
    // store them first so the snapshot compares content, not ids.
    proseNs.ensureBlockIds(source.ydoc);
    const before = blocksOf(source.ydoc);
    const dataDir = freshDataDir();

    await leg({ w, heading: createNotesHeadingMemory(), dataDir, say: SAID, compose: NOTES });

    expect(w.minted).toEqual(['d-notes-1']);
    const after = blocksOf(source.ydoc);
    // Every original block byte-for-byte, and exactly one line added after.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(markdownOfDoc(source.ydoc)).toContain(
      'Meeting notes: [Riverbend plan — meeting notes](/workspaces/w-1/docs/d-notes-1)',
    );
    for (const s of SAID) expect(markdownOfDoc(source.ydoc)).not.toContain(s);

    const notes = markdownOfDoc(w.docs['d-notes-1']?.ydoc ?? new Y.Doc());
    for (const s of SAID) expect(notes).toContain(s);
    // And the notes check read the doc the notes are in.
    const record = readNotesQuality(dataDir, SOURCE, MEETING);
    expect(record?.ideas).toBe(SAID.length);
    expect(record?.uncoveredIdeas).toBe(0);
  });

  it('keeps writing into the same notes doc when the meeting resumes', async () => {
    const source = docFrom(OWN_DOC);
    const w = world(source);
    const heading = createNotesHeadingMemory();
    const dataDir = freshDataDir();
    await leg({ w, heading, dataDir, say: SAID.slice(0, 5), compose: NOTES });
    const linked = blocksOf(source.ydoc);
    await leg({
      w,
      heading,
      dataDir,
      say: SAID.slice(5),
      compose: (input, tick) =>
        tick === 1
          ? addNotes(
              input,
              SAID.slice(5)
                .map((s) => `- ${s}`)
                .join('\n'),
            )
          : [],
    });
    expect(w.minted).toEqual(['d-notes-1']);
    expect(blocksOf(source.ydoc)).toEqual(linked);
    const notes = markdownOfDoc(w.docs['d-notes-1']?.ydoc ?? new Y.Doc());
    for (const s of SAID) expect(notes).toContain(s);
  });
});

describe('a meeting on a doc with nothing of a person’s in it', () => {
  it('writes in place on a doc holding only its title', async () => {
    const source = docFrom('# Riverbend plan\n');
    const w = world(source);
    await leg({
      w,
      heading: createNotesHeadingMemory(),
      dataDir: freshDataDir(),
      say: SAID,
      compose: NOTES,
    });
    expect(w.minted).toEqual([]);
    for (const s of SAID) expect(markdownOfDoc(source.ydoc)).toContain(s);
  });

  it('writes in place on a huddle, whatever it holds', async () => {
    const source = docFrom(OWN_DOC, { type: 'markdown', huddle: true });
    const w = world(source);
    await leg({
      w,
      heading: createNotesHeadingMemory(),
      dataDir: freshDataDir(),
      say: SAID,
      compose: NOTES,
    });
    expect(w.minted).toEqual([]);
    for (const s of SAID) expect(markdownOfDoc(source.ydoc)).toContain(s);
  });

  it('writes in place on a calendar meeting doc, whatever it holds', async () => {
    // Notes written before this release, or after a stop, carry no record and
    // read as a person's writing; a calendar meeting doc keeps them anyway.
    const meta = { type: 'markdown', alias: 'meeting-20261004-0930-x7q2' } as const;
    const source = docFrom(OWN_DOC, meta);
    const w = world(source);
    await leg({
      w,
      heading: createNotesHeadingMemory(),
      dataDir: freshDataDir(),
      say: SAID,
      compose: NOTES,
    });
    expect(w.minted).toEqual([]);
    for (const s of SAID) expect(markdownOfDoc(source.ydoc)).toContain(s);

    const targets = createNotesTargets({
      docStore: () => w.store,
      written: createNotesWrittenBlocks(),
      mint: w.mint,
    });
    expect(targets.handOff(SOURCE)).toBeUndefined();
    // Positive control: the same doc without the alias is handed off.
    source.meta = { type: 'markdown' };
    expect(targets.handOff(SOURCE)?.docId).toBe('d-notes-1');
  });

  it('still hands off a person’s own doc that merely starts meeting-', () => {
    const source = docFrom(OWN_DOC, { type: 'markdown', alias: 'meeting-prep' });
    const w = world(source);
    const targets = createNotesTargets({
      docStore: () => w.store,
      written: createNotesWrittenBlocks(),
      mint: w.mint,
    });
    expect(targets.handOff(SOURCE)?.docId).toBe('d-notes-1');
  });
});

describe('a second Record press on the same doc', () => {
  it('goes to the notes doc the first press made, until the window passes', () => {
    const source = docFrom(OWN_DOC);
    const w = world(source);
    let clock = 1_000;
    const targets = createNotesTargets({
      docStore: () => w.store,
      written: createNotesWrittenBlocks(),
      mint: w.mint,
      now: () => clock,
    });
    const first = targets.handOff(SOURCE);
    clock += 60_000;
    // Another tab, a retry after a drop, Back and Record again.
    expect(targets.handOff(SOURCE)).toEqual(first);
    expect(w.minted).toEqual(['d-notes-1']);
    expect(markdownOfDoc(source.ydoc).match(/Meeting notes: \[/g) ?? []).toHaveLength(1);

    clock += HANDOFF_REUSE_MS;
    expect(targets.handOff(SOURCE)?.docId).toBe('d-notes-2');
  });

  it('goes to the same notes doc while a meeting is live there, past the window', () => {
    const source = docFrom(OWN_DOC);
    const w = world(source);
    let clock = 1_000;
    const targets = createNotesTargets({
      docStore: () => w.store,
      written: createNotesWrittenBlocks(),
      mint: w.mint,
      now: () => clock,
    });
    const live = new Set<string>();
    const recording = (docId: string) => live.has(docId);
    const first = targets.handOff(SOURCE, recording);
    live.add('d-notes-1');
    clock += 3 * HANDOFF_REUSE_MS;
    expect(targets.handOff(SOURCE, recording)).toEqual(first);
    expect(w.minted).toEqual(['d-notes-1']);
    expect(markdownOfDoc(source.ydoc).match(/Meeting notes: \[/g) ?? []).toHaveLength(1);

    // The meeting stops. A press soon after still finds it, because the
    // window runs from the last press; one a window later makes a new one.
    live.clear();
    clock += 60_000;
    expect(targets.handOff(SOURCE, recording)).toEqual(first);
    clock += HANDOFF_REUSE_MS;
    expect(targets.handOff(SOURCE, recording)?.docId).toBe('d-notes-2');
  });
});

describe('what counts as a person’s own writing', () => {
  const entry = (over: Partial<prose.OutlineEntry>): prose.OutlineEntry => ({
    id: 'b1',
    kind: 'block',
    nodeName: 'paragraph',
    text: 'The boards are older than the slipway.',
    ...over,
  });

  it('is a paragraph with words that no meeting wrote', () => {
    expect(holdsOwnWriting([entry({})], new Set())).toBe(true);
  });

  it('is not a heading, an empty line, a marked note, or a block a meeting recorded', () => {
    expect(holdsOwnWriting([entry({ kind: 'heading', nodeName: 'heading' })], new Set())).toBe(
      false,
    );
    expect(holdsOwnWriting([entry({ text: '   ' })], new Set())).toBe(false);
    expect(holdsOwnWriting([entry({ author: NOTES_AUTHOR_ID })], new Set())).toBe(false);
    expect(holdsOwnWriting([entry({})], new Set(['b1']))).toBe(false);
  });
});

describe('the server’s notes-doc mint', () => {
  it('makes a huddle bound to a file, files it on the source’s board, and links it there', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-mint-'));
    dirs.push(dataDir);
    const calls: string[] = [];
    const mint = createServerNotesDocMint(
      {
        createForCaller: (_alias, init) => {
          calls.push(`create ${init.title} huddle=${init.huddle}`);
          return { ok: true, doc: { docId: 'd-new' }, minted: true };
        },
        attachFile: (docId, file) => {
          calls.push(`attach ${docId} ${existsSync(file)}`);
          return { ok: true };
        },
        fileUnderBoard: (docId, requested) => {
          calls.push(`file ${docId} on ${requested}`);
          return requested ?? 'w-default';
        },
        boardOf: () => 'w-harbour',
      },
      dataDir,
    );
    expect(mint({ docId: SOURCE, title: 'Riverbend plan' })).toEqual({
      docId: 'd-new',
      title: 'Riverbend plan — meeting notes',
      url: '/workspaces/w-harbour/docs/d-new',
    });
    expect(calls).toEqual([
      'create Riverbend plan — meeting notes huddle=true',
      'attach d-new true',
      'file d-new on w-harbour',
    ]);
  });

  it('answers nothing when the doc cannot be bound, so the meeting writes in place', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-mint-'));
    dirs.push(dataDir);
    const mint = createServerNotesDocMint(
      {
        createForCaller: () => ({ ok: true, doc: { docId: 'd-new' }, minted: true }),
        attachFile: () => ({ ok: false }),
        fileUnderBoard: () => 'w-1',
        boardOf: () => undefined,
      },
      dataDir,
    );
    expect(mint({ docId: SOURCE })).toBeUndefined();
  });
});
