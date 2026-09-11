/**
 * The one-shot move of stored prompt overrides onto the markdown defaults.
 *
 * Bryan's rule: an override that is the OLD default word for word is
 * soft-cleared, and any other override is kept, marked "written before
 * markdown". Nobody here can read prod's data, so every case a store could be
 * in is built and run: no file, an unreadable file, a file of old defaults, a
 * file of somebody's own words, and a file this migration already moved.
 *
 * All fixtures are synthetic apart from the old default texts, which are the
 * shipped prompts as they read on main before the rewrite.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTES_PROMPT_FILENAME } from '../src/notes-prompt-store.ts';
import { PROMPT_CATALOG } from '../src/prompt-catalog.ts';
import {
  BOARD_PROMPT_FIELDS,
  MARKDOWN_PROMPTS_FILE_VERSION,
  type MigratablePrompt,
  PRE_MARKDOWN_DEFAULT_SHA256,
  boardPromptBeforeMarkdown,
  isPreMarkdownDefault,
  migrateBoardPrompts,
  migratePromptRecords,
  sha256,
} from '../src/prompt-markdown-migration.ts';
import { PROMPTS_FILENAME, createPromptStore } from '../src/prompt-store.ts';
import { createServer } from '../src/server.ts';
import { TaskStore } from '../src/tasks.ts';
import { preMarkdownDefaults, readPreMarkdownDefault } from './pre-markdown-defaults.ts';

const OLD = preMarkdownDefaults();
const OWN_WORDS = 'Riverbend notes: two bullets per topic, owners named.';

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-prompt-md-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface StoredFile {
  version: number;
  prompts: Record<
    string,
    { value?: string; beforeMarkdown?: boolean; previous?: Array<{ value: string }> }
  >;
}

function writeFile(dir: string, file: unknown): void {
  writeFileSync(join(dir, PROMPTS_FILENAME), JSON.stringify(file, null, 2));
}
function readFile(dir: string): StoredFile {
  return JSON.parse(readFileSync(join(dir, PROMPTS_FILENAME), 'utf8')) as StoredFile;
}

describe('what counts as the old default', () => {
  it('knows every shipped prompt, by the hash of the text it replaced', () => {
    expect(Object.keys(PRE_MARKDOWN_DEFAULT_SHA256).sort()).toEqual(
      PROMPT_CATALOG.map((p) => p.id).sort(),
    );
    // Every old text but meeting capture's is under `fixtures/`. That one
    // quotes a person's name in an example, which a public fixture must not
    // carry; its hash was taken from the same dump of 8cc724fa as the others.
    expect(Object.keys(OLD).sort()).toEqual(
      PROMPT_CATALOG.map((p) => p.id)
        .filter((id) => id !== 'meeting-capture')
        .sort(),
    );
    for (const [id, text] of Object.entries(OLD)) {
      expect([id, sha256(text)]).toEqual([id, PRE_MARKDOWN_DEFAULT_SHA256[id] ?? '']);
    }
  });

  it('is the old text word for word, give or take the ends', () => {
    const old = readPreMarkdownDefault('meeting-notes');
    expect(isPreMarkdownDefault('meeting-notes', old)).toBe(true);
    expect(isPreMarkdownDefault('meeting-notes', `\n${old}  \n`)).toBe(true);
    // One word changed is somebody's words.
    expect(isPreMarkdownDefault('meeting-notes', old.replace('the', 'a'))).toBe(false);
    // Another prompt's old default is not this one's.
    expect(isPreMarkdownDefault('meeting-capture', old)).toBe(false);
  });

  it('never takes the NEW default for the old one', () => {
    for (const def of PROMPT_CATALOG) {
      expect([def.id, isPreMarkdownDefault(def.id, def.default)]).toEqual([def.id, false]);
    }
  });
});

describe('migratePromptRecords', () => {
  it('clears an exact old default into the history, and marks every other override', () => {
    const out = migratePromptRecords<MigratablePrompt>(
      {
        'meeting-notes': { value: OLD['meeting-notes'] ?? '' },
        'meeting-capture': { value: OWN_WORDS },
        'voice-router': { previous: [{ value: 'older', replacedAt: 1 }] },
      },
      42,
    );
    expect(out['meeting-notes']).toEqual({
      previous: [{ value: OLD['meeting-notes'] ?? '', replacedAt: 42 }],
    });
    expect(out['meeting-capture']).toEqual({ value: OWN_WORDS, beforeMarkdown: true });
    // A record with no words in force is left as it was: there is nothing to mark.
    expect(out['voice-router']).toEqual({ previous: [{ value: 'older', replacedAt: 1 }] });
  });
});

describe('the server prompt store, on each file it could find', () => {
  it('soft-clears an old default: the new default is sent, the old words are kept', () => {
    const dir = dataDir();
    writeFile(dir, {
      version: 1,
      prompts: { 'voice-router': { value: OLD['voice-router'], updatedAt: 1 } },
    });
    const store = createPromptStore({ dataDir: dir });
    const def = PROMPT_CATALOG.find((p) => p.id === 'voice-router');
    expect(store.read('voice-router')).toBe(def?.default ?? '');
    expect(store.view('voice-router')).toEqual({ value: def?.default ?? '', isDefault: true });
    const file = readFile(dir);
    expect(file.version).toBe(MARKDOWN_PROMPTS_FILE_VERSION);
    expect(file.prompts['voice-router']?.value).toBeUndefined();
    expect(file.prompts['voice-router']?.previous?.map((p) => p.value)).toEqual([
      OLD['voice-router'] ?? '',
    ]);
  });

  it('keeps somebody’s own words exactly, marked written before markdown', () => {
    const dir = dataDir();
    writeFile(dir, { version: 1, prompts: { 'meeting-notes': { value: OWN_WORDS } } });
    const store = createPromptStore({ dataDir: dir });
    expect(store.read('meeting-notes')).toBe(OWN_WORDS);
    expect(store.view('meeting-notes')).toEqual({
      value: OWN_WORDS,
      isDefault: false,
      beforeMarkdown: true,
    });
    expect(readFile(dir).prompts['meeting-notes']?.beforeMarkdown).toBe(true);
  });

  it('drops the mark once the words are saved over, and never puts it back', () => {
    const dir = dataDir();
    writeFile(dir, { version: 1, prompts: { 'meeting-notes': { value: OWN_WORDS } } });
    expect(createPromptStore({ dataDir: dir }).write('meeting-notes', 'New words.').ok).toBe(true);
    // A fresh store is a restart: the file says the migration ran.
    const again = createPromptStore({ dataDir: dir });
    expect(again.view('meeting-notes')).toEqual({ value: 'New words.', isDefault: false });
    expect(readFile(dir).version).toBe(MARKDOWN_PROMPTS_FILE_VERSION);
  });

  it('does not clear the old default a person saves AFTER the move', () => {
    // Past the migration the old text is just words somebody chose.
    const dir = dataDir();
    const store = createPromptStore({ dataDir: dir });
    expect(store.write('voice-router', OLD['voice-router'] ?? '').ok).toBe(true);
    expect(createPromptStore({ dataDir: dir }).read('voice-router')).toBe(
      OLD['voice-router'] ?? '',
    );
  });

  it('moves a notes-prompt.md from before the store the same way', () => {
    // That file predates this store, so its words predate markdown too — even
    // though the prompts.json it is moved into is born at the new version.
    const def = PROMPT_CATALOG.find((p) => p.id === 'meeting-notes');
    const cleared = dataDir();
    writeFileSync(join(cleared, NOTES_PROMPT_FILENAME), OLD['meeting-notes'] ?? '');
    expect(createPromptStore({ dataDir: cleared }).read('meeting-notes')).toBe(def?.default ?? '');
    expect(readFile(cleared).prompts['meeting-notes']?.previous?.map((p) => p.value)).toEqual([
      (OLD['meeting-notes'] ?? '').trim(),
    ]);

    const kept = dataDir();
    writeFileSync(join(kept, NOTES_PROMPT_FILENAME), OWN_WORDS);
    expect(createPromptStore({ dataDir: kept }).view('meeting-notes')).toEqual({
      value: OWN_WORDS,
      isDefault: false,
      beforeMarkdown: true,
    });
  });

  it('creates no file where there was none', () => {
    const dir = dataDir();
    const store = createPromptStore({ dataDir: dir });
    const def = PROMPT_CATALOG.find((p) => p.id === 'meeting-notes');
    expect(store.read('meeting-notes')).toBe(def?.default ?? '');
    expect(existsSync(join(dir, PROMPTS_FILENAME))).toBe(false);
  });

  it('never overwrites a file it cannot read', () => {
    const dir = dataDir();
    writeFileSync(join(dir, PROMPTS_FILENAME), '{ not json');
    createPromptStore({ dataDir: dir }).read('meeting-notes');
    expect(readFileSync(join(dir, PROMPTS_FILENAME), 'utf8')).toBe('{ not json');
  });
});

describe('a board’s two prompt fields', () => {
  it('clears an old default and remembers the words it cleared', () => {
    const board = {
      reviewItemCriteria: OLD['review-item-criteria'],
      effortEstimatePrompt: OWN_WORDS,
    };
    expect(migrateBoardPrompts(board, 7)).toBe(true);
    expect(board.reviewItemCriteria).toBeUndefined();
    expect(board.effortEstimatePrompt).toBe(OWN_WORDS);
    expect(boardPromptBeforeMarkdown(board, 'effortEstimatePrompt')).toBe(true);
    expect(boardPromptBeforeMarkdown(board, 'reviewItemCriteria')).toBe(false);
    expect(board).toMatchObject({
      promptMarkdownMigration: {
        at: 7,
        cleared: { reviewItemCriteria: OLD['review-item-criteria'] },
      },
    });
  });

  it('runs once: words saved after it are never marked', () => {
    const board: { effortEstimatePrompt?: string } = { effortEstimatePrompt: OWN_WORDS };
    migrateBoardPrompts(board, 1);
    board.effortEstimatePrompt = 'Typed after the move.';
    expect(migrateBoardPrompts(board, 2)).toBe(false);
    expect(boardPromptBeforeMarkdown(board, 'effortEstimatePrompt')).toBe(false);
  });

  it('names the two fields the settings route reads', () => {
    expect(BOARD_PROMPT_FIELDS).toEqual({
      reviewItemCriteria: 'review-item-criteria',
      effortEstimatePrompt: 'effort-estimate',
    });
  });

  it('runs when a board comes off disk, and a board born after it is left alone', () => {
    const dir = dataDir();
    const first = new TaskStore({ dataDir: dir, debounceMs: 5 });
    const old = first.createWorkspace('Harborlight');
    const born = first.createWorkspace('Saltmarsh');
    first.setReviewItemCriteria(old.id, OLD['review-item-criteria'], {
      actor: { id: 'u-1', name: 'Riverbend reviewer' },
    });
    first.setEffortEstimatePrompt(old.id, OWN_WORDS, {
      actor: { id: 'u-1', name: 'Riverbend reviewer' },
    });
    first.setEffortEstimatePrompt(born.id, OWN_WORDS, {
      actor: { id: 'u-1', name: 'Riverbend reviewer' },
    });
    // The board that predates the move: saved as it would have been by the
    // version before this one, with no record of the migration.
    const record = first.getWorkspace(old.id);
    if (record) record.promptMarkdownMigration = undefined;
    first.flush();
    first.stop();

    const second = new TaskStore({ dataDir: dir, debounceMs: 5 });
    try {
      expect(second.reviewItemCriteria(old.id)?.isDefault).toBe(true);
      const oldBoard = second.getWorkspace(old.id);
      expect(oldBoard && boardPromptBeforeMarkdown(oldBoard, 'effortEstimatePrompt')).toBe(true);
      const bornBoard = second.getWorkspace(born.id);
      expect(bornBoard?.effortEstimatePrompt).toBe(OWN_WORDS);
      expect(bornBoard && boardPromptBeforeMarkdown(bornBoard, 'effortEstimatePrompt')).toBe(false);
    } finally {
      second.stop();
    }
  });
  it('a save ends the mark, even a save of the same words', () => {
    const dir = dataDir();
    const first = new TaskStore({ dataDir: dir, debounceMs: 5 });
    const ws = first.createWorkspace('Riverbend');
    const actor = { actor: { id: 'u-1', name: 'Riverbend reviewer' } };
    first.setReviewItemCriteria(ws.id, OWN_WORDS, actor);
    first.setEffortEstimatePrompt(ws.id, OWN_WORDS, actor);
    const record = first.getWorkspace(ws.id);
    if (record) record.promptMarkdownMigration = undefined;
    first.flush();
    first.stop();

    const second = new TaskStore({ dataDir: dir, debounceMs: 5 });
    try {
      const board = second.getWorkspace(ws.id);
      expect(board && boardPromptBeforeMarkdown(board, 'reviewItemCriteria')).toBe(true);
      expect(board && boardPromptBeforeMarkdown(board, 'effortEstimatePrompt')).toBe(true);
      second.setReviewItemCriteria(ws.id, OWN_WORDS, actor);
      second.setEffortEstimatePrompt(ws.id, OWN_WORDS, actor);
      expect(board && boardPromptBeforeMarkdown(board, 'reviewItemCriteria')).toBe(false);
      expect(board && boardPromptBeforeMarkdown(board, 'effortEstimatePrompt')).toBe(false);
      // The record of the run stays, so the board is never migrated again.
      expect(board?.promptMarkdownMigration?.at).toBeGreaterThan(0);
    } finally {
      second.stop();
    }
  });
});

describe('the settings routes say which words predate markdown', () => {
  it('as writtenBeforeMarkdown on the prompt and the board field', async () => {
    const dir = dataDir();
    writeFile(dir, { version: 1, prompts: { 'meeting-notes': { value: OWN_WORDS } } });
    // A board sidecar as the previous version wrote it.
    const seed = new TaskStore({ dataDir: dir, debounceMs: 5 });
    const ws = seed.createWorkspace('Riverbend');
    seed.setReviewItemCriteria(ws.id, OWN_WORDS, {
      actor: { id: 'u-1', name: 'Riverbend reviewer' },
    });
    const rec = seed.getWorkspace(ws.id);
    if (rec) rec.promptMarkdownMigration = undefined;
    seed.flush();
    seed.stop();

    const server = createServer({ port: 0, dataDir: dir });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const prompt = (await (await fetch(`${base}/api/prompts/meeting-notes`)).json()) as {
        writtenBeforeMarkdown?: boolean;
      };
      expect(prompt.writtenBeforeMarkdown).toBe(true);
      const settings = (await (await fetch(`${base}/workspaces/${ws.id}/settings`)).json()) as {
        reviewItemCriteria?: { writtenBeforeMarkdown?: boolean };
        effortEstimatePrompt?: { writtenBeforeMarkdown?: boolean };
      };
      expect(settings.reviewItemCriteria?.writtenBeforeMarkdown).toBe(true);
      expect(settings.effortEstimatePrompt?.writtenBeforeMarkdown).toBeUndefined();
    } finally {
      await server.stop();
    }
  });
});
