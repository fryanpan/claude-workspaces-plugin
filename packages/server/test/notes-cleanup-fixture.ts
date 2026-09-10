/**
 * The fixture a cleanup case needs: a doc store over a real Y.Doc, a composer
 * that answers with whatever the case hands it, and a meeting's worth of
 * transcript on disk.
 *
 * It lives beside the tests rather than inside one of them because both
 * cleanup suites — what the pass does, and what happens to a commented
 * bullet — build the same finished meeting before they can ask anything.
 *
 * Nothing here reads a source file: every export drives the real modules and
 * returns live objects, so a case that uses it is asserting behaviour.
 *
 * All notes and all speech are invented and every name is fictional. The repo
 * is public.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import type { NotesComposeInput, NotesComposer } from '../src/meeting-notes.ts';
import { meetingDirPath, meetingIndexPath, meetingTranscriptPath } from '../src/meetings.ts';
import { NOTES_AUTHOR_ID, type NotesDocStore } from '../src/notes-doc-access.ts';

export const DOC = 'd-riverbend';
export const MEETING = 'm-2026-09-10-a';

const dirs: string[] = [];
export const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-notes-cleanup-'));
  dirs.push(dir);
  return dir;
};
/** Every temp dir this fixture handed out. Call it from an `afterEach`. */
export const dropFreshDirs = (): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

/**
 * A doc store over one Y.Doc that really applies edits, so a case asserts the
 * document rather than the count the pass reported about it.
 *
 * `ownedFrom` is the markdown offset at which the note-taker's own blocks
 * begin: every block from there on is stamped `cwAuthor`, and everything
 * before it reads as a person's writing — which is exactly how the live doc
 * distinguishes them (`clearAuthorshipOnPersonEdit`).
 */
export function docStoreFrom(
  markdown: string,
  ownedHeadings: readonly string[],
): {
  store: NotesDocStore;
  ydoc: Y.Doc;
  markdownNow: () => string;
} {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  prose.applyMarkdownToFragment(fragment, markdown);
  prose.readOutline(ydoc); // mints the ids
  // Stamp authorship on everything from the first owned heading onward — the
  // state a finished meeting leaves the doc in.
  let owning = false;
  for (const el of prose.addressableBlocks(fragment)) {
    const text = el.toString();
    if (ownedHeadings.some((h) => text.includes(h))) owning = true;
    if (owning) el.setAttribute('cwAuthor', NOTES_AUTHOR_ID);
  }
  const doc = { ydoc, meta: { type: 'markdown' as const } };
  const store: NotesDocStore = {
    get: (docId) => (docId === DOC ? doc : undefined),
    readOutline: (docId, opts) =>
      docId === DOC ? { blocks: prose.readOutline(ydoc, opts) } : null,
    applyBlockEdits: (docId, edits, who) => {
      if (docId !== DOC) return { ok: false, error: 'not-found' };
      return {
        ok: true,
        ...prose.applyBlockEdits(ydoc, edits, {
          author: who.author,
          suggestionAuthor: { id: who.author, name: who.authorName ?? who.author, color: '#777' },
        }),
      };
    },
  };
  return {
    store,
    ydoc,
    markdownNow: () => prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc)),
  };
}

/** A composer that returns a fixed list and records what it was asked. */
export function stubComposer(
  edits: readonly prose.BlockEdit[] | (() => never),
): NotesComposer & { seen: NotesComposeInput[] } {
  const seen: NotesComposeInput[] = [];
  return {
    name: 'stub',
    seen,
    compose(input) {
      seen.push(input);
      if (typeof edits === 'function') return Promise.reject(new Error('composer is down'));
      return Promise.resolve(edits);
    },
  };
}

/** A transcript on disk, plus the index line a meeting record needs. */
export function writeTranscript(
  dataDir: string,
  turns: readonly { turn: number; text: string; speaker?: string }[],
  speakers?: Record<string, string>,
): void {
  mkdirSync(meetingDirPath(dataDir, DOC), { recursive: true });
  writeFileSync(
    meetingTranscriptPath(dataDir, DOC, MEETING),
    `${turns.map((t) => JSON.stringify({ ...t, ts: 1 })).join('\n')}\n`,
  );
  const lines = [
    JSON.stringify({
      meetingId: MEETING,
      docId: DOC,
      startedAt: 1,
      engine: 'mock',
      sampleRate: 16000,
    }),
    ...(speakers ? [JSON.stringify({ meetingId: MEETING, speakers })] : []),
  ];
  writeFileSync(meetingIndexPath(dataDir, DOC), `${lines.join('\n')}\n`);
}

export const NOTES = [
  '# Riverbend ferry review',
  '',
  'My own line about the slipway, which nobody may rewrite.',
  '',
  '## Meeting notes',
  '',
  '### Ferry timetable',
  '',
  '- The harbour run moves to the half hour from April',
  '- Kestrel Lane keeps the winter crew',
].join('\n');

export const idOf = (store: NotesDocStore, needle: string): string => {
  const entry = (store.readOutline(DOC)?.blocks ?? []).find((b) => b.text.includes(needle));
  if (!entry) throw new Error(`no block matching ${needle}`);
  return entry.id;
};

export const depsFor = (
  store: NotesDocStore,
  composer: NotesComposer | null,
  dataDir: string,
  headingId: string,
) => ({
  docStore: () => store,
  composer,
  dataDir,
  headingIdOf: () => headingId,
});
