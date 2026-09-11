/**
 * The one-shot move of stored prompt overrides onto the markdown defaults
 * (2026-09-11).
 *
 * Every shipped prompt became markdown in Simplified Technical English on
 * that day. An override is the words somebody saved over a default, and two
 * kinds were saved before it:
 *
 * - AN OVERRIDE THAT IS THE OLD DEFAULT, word for word. Opening a prompt and
 *   pressing Save without an edit wrote one. It is not anybody's words, and
 *   left alone it would pin that deployment to the old prompt forever. So it
 *   is SOFT-cleared: the prompt goes back to the (new) default and the text
 *   is kept — in `previous` for a server prompt, in the board's
 *   `promptMarkdownMigration.cleared` for a board prompt. Nothing is destroyed.
 * - ANY OTHER OVERRIDE is somebody's words and is kept exactly, marked
 *   "written before markdown" so the settings page can say why it reads
 *   differently from its neighbours. The mark lasts until those words are
 *   next saved over.
 *
 * "Word for word" is a SHA-256 of the old default, not a copy of it: six
 * frozen prompt texts in the source would be dead text a reader has to skip,
 * and the comparison needs only equality. Ends are trimmed on both sides,
 * because every editor that could have saved one trims before it writes.
 *
 * Safe on any data, because nothing here reads prod or guesses: a store with
 * no overrides is untouched, an unreadable one is never rewritten, and the
 * migration records that it ran so a later save is never re-marked.
 */

import { createHash } from 'node:crypto';

/**
 * SHA-256 of each prompt's default as it read on main before markdown
 * (8cc724fa), by catalog id. `prompt-markdown-migration.test.ts` checks each
 * but meeting capture's against a copy of the old text kept under
 * `test/fixtures/`; that one quotes a person's name, so no copy is kept.
 */
export const PRE_MARKDOWN_DEFAULT_SHA256: Readonly<Record<string, string>> = {
  'meeting-notes': '9e264b942231a74f6186f7ab5746e69bb661327566e335ededfb582d574227e1',
  'meeting-capture': 'ad078156477f0d78212b00b3fe78d4912075a4af5b78bddc5fc2ec2825951573',
  'thread-summary': '4fc8cbc0a628e7e354a6b8d657e03b5ec693755d41dbce0467fb51c3d8b47463',
  'review-item-criteria': '08e43ae08f66fc1324562d959e44e23ef8eef8f3219a9c77813e21588f29d456',
  'effort-estimate': 'd01d27b4b063a6c569b5aa0da2c28b6d0aca1c3ee673940dcefc834e2de10a12',
  'voice-router': 'c7324f11288ec1eac68d8c044358b8675d424783d201fd25553681032856c4b0',
};

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** True when `value` is prompt `id`'s pre-markdown default, word for word. */
export function isPreMarkdownDefault(id: string, value: string): boolean {
  const want = PRE_MARKDOWN_DEFAULT_SHA256[id];
  return want !== undefined && sha256(value.trim()) === want;
}

/* ===== Server prompts: `<dataDir>/prompts.json` ===== */

/** The file version that says this migration has run. */
export const MARKDOWN_PROMPTS_FILE_VERSION = 2;

/** The slice of a stored prompt record this migration reads and writes. */
export interface MigratablePrompt {
  value?: string;
  beforeMarkdown?: boolean;
  previous?: Array<{ value: string; replacedAt: number }>;
}

/**
 * Every record moved onto the markdown defaults: an exact old default
 * soft-cleared into `previous`, any other override marked `beforeMarkdown`.
 * Pure — the store decides whether and when to write the result.
 */
export function migratePromptRecords<T extends MigratablePrompt>(
  prompts: Record<string, T>,
  now: number,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, rec] of Object.entries(prompts)) {
    const value = rec.value;
    if (typeof value !== 'string' || value.trim() === '') {
      out[id] = rec;
    } else if (isPreMarkdownDefault(id, value)) {
      const { value: _cleared, beforeMarkdown: _mark, ...rest } = rec;
      out[id] = {
        ...rest,
        previous: [...(rec.previous ?? []), { value, replacedAt: now }],
      } as T;
    } else {
      out[id] = { ...rec, beforeMarkdown: true };
    }
  }
  return out;
}

/* ===== Board prompts: fields on a board's own record ===== */

/** The two board-scoped prompts, and the catalog id each one is. */
export const BOARD_PROMPT_FIELDS = {
  reviewItemCriteria: 'review-item-criteria',
  effortEstimatePrompt: 'effort-estimate',
} as const;

export type BoardPromptField = keyof typeof BOARD_PROMPT_FIELDS;

/** What a board records about its run of this migration. Present means ran. */
export interface BoardPromptMigration {
  at: number;
  /** Field → the old default it held, cleared back to the default. */
  cleared?: Partial<Record<BoardPromptField, string>>;
  /** Field → SHA-256 of the override it kept. "Written before markdown"
   *  holds only while the field still hashes to this. */
  kept?: Partial<Record<BoardPromptField, string>>;
}

export interface MigratableBoard {
  reviewItemCriteria?: string;
  effortEstimatePrompt?: string;
  promptMarkdownMigration?: BoardPromptMigration;
}

/**
 * Move one board's two prompt fields onto the markdown defaults, in place.
 * Returns true when it changed the record. A board that has run it already is
 * left alone, so words saved afterwards are never marked.
 */
export function migrateBoardPrompts(board: MigratableBoard, now: number): boolean {
  if (board.promptMarkdownMigration) return false;
  const cleared: Partial<Record<BoardPromptField, string>> = {};
  const kept: Partial<Record<BoardPromptField, string>> = {};
  for (const [field, id] of Object.entries(BOARD_PROMPT_FIELDS) as Array<
    [BoardPromptField, string]
  >) {
    const value = board[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    if (isPreMarkdownDefault(id, value)) {
      cleared[field] = value;
      board[field] = undefined;
    } else {
      kept[field] = sha256(value);
    }
  }
  board.promptMarkdownMigration = {
    at: now,
    ...(Object.keys(cleared).length > 0 ? { cleared } : {}),
    ...(Object.keys(kept).length > 0 ? { kept } : {}),
  };
  return true;
}

/**
 * A save to a board field ends its "written before markdown" mark, even a
 * save of the same words. Call it from every setter of the two fields.
 */
export function endBoardPromptBeforeMarkdown(
  board: MigratableBoard,
  field: BoardPromptField,
): void {
  const kept = board.promptMarkdownMigration?.kept;
  if (!kept || kept[field] === undefined) return;
  delete kept[field];
  if (Object.keys(kept).length === 0 && board.promptMarkdownMigration) {
    board.promptMarkdownMigration.kept = undefined;
  }
}

/** True while a board field still holds the words it held before markdown. */
export function boardPromptBeforeMarkdown(
  board: MigratableBoard,
  field: BoardPromptField,
): boolean {
  const want = board.promptMarkdownMigration?.kept?.[field];
  const value = board[field];
  return want !== undefined && typeof value === 'string' && sha256(value) === want;
}
