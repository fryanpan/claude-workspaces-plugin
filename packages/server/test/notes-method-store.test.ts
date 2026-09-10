import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MAX_KEPT_CHANGES,
  type NotesMethodChange,
  notesMethodPath,
  readNotesMethod,
  readNotesMethodRecord,
  writeNotesMethod,
} from '../src/notes-method-store.ts';

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'notes-method-'));
}

const at = 1_757_000_000_000;

describe('a doc nobody has chosen for', () => {
  test('reads as the default and has no record', () => {
    const dir = dataDir();
    expect(readNotesMethodRecord(dir, 'd1')).toBeNull();
    expect(readNotesMethod(dir, 'd1')).toBe('original');
  });
});

describe('a choice survives the process that made it', () => {
  test('what was written is what the next read answers', () => {
    const dir = dataDir();
    writeNotesMethod(dir, 'd1', { method: 'ledger-opus', at, by: 'Maya Okonkwo' });
    // A SECOND READ FROM DISK, not the returned value: "reload keeps it" is a
    // property of the file, and returning the record would pass either way.
    expect(readNotesMethod(dir, 'd1')).toBe('ledger-opus');
  });

  test('the change records who, when and which', () => {
    const dir = dataDir();
    writeNotesMethod(dir, 'd1', {
      method: 'ledger-haiku',
      at,
      by: 'Devin Aluko',
      meetingId: 'm-7',
    });
    const [change] = readNotesMethodRecord(dir, 'd1')?.changes ?? [];
    expect(change).toEqual({ method: 'ledger-haiku', at, by: 'Devin Aluko', meetingId: 'm-7' });
  });

  test('one doc’s choice is not another doc’s', () => {
    const dir = dataDir();
    writeNotesMethod(dir, 'd1', { method: 'ledger-opus', at });
    expect(readNotesMethod(dir, 'd2')).toBe('original');
  });

  test('changes accumulate in the order they were made', () => {
    const dir = dataDir();
    writeNotesMethod(dir, 'd1', { method: 'ledger-haiku', at });
    writeNotesMethod(dir, 'd1', { method: 'ledger-opus', at: at + 1000 });
    writeNotesMethod(dir, 'd1', { method: 'original', at: at + 2000 });
    const rec = readNotesMethodRecord(dir, 'd1');
    expect(rec?.method).toBe('original');
    expect(rec?.changes.map((c) => c.method)).toEqual(['ledger-haiku', 'ledger-opus', 'original']);
  });
});

describe('what counts as a change worth recording', () => {
  test('picking the row that is already on, at rest, records nothing new', () => {
    const dir = dataDir();
    writeNotesMethod(dir, 'd1', { method: 'ledger-opus', at });
    writeNotesMethod(dir, 'd1', { method: 'ledger-opus', at: at + 1000 });
    expect(readNotesMethodRecord(dir, 'd1')?.changes).toHaveLength(1);
  });

  test('CONTROL: the same pick INSIDE a meeting is recorded, because the notes trace it', () => {
    const dir = dataDir();
    writeNotesMethod(dir, 'd1', { method: 'ledger-opus', at });
    writeNotesMethod(dir, 'd1', { method: 'ledger-opus', at: at + 1000, meetingId: 'm-1' });
    expect(readNotesMethodRecord(dir, 'd1')?.changes).toHaveLength(2);
  });

  test('the kept history has a ceiling, and it keeps the newest', () => {
    const dir = dataDir();
    const methods = ['original', 'ledger-haiku'] as const;
    for (let i = 0; i < MAX_KEPT_CHANGES + 10; i++) {
      // Alternating, so no write is the dropped no-op repeat.
      const method = methods[i % 2] as NotesMethodChange['method'];
      writeNotesMethod(dir, 'd1', { method, at: at + i, meetingId: `m-${i}` });
    }
    const changes = readNotesMethodRecord(dir, 'd1')?.changes ?? [];
    expect(changes).toHaveLength(MAX_KEPT_CHANGES);
    expect(changes.at(-1)?.at).toBe(at + MAX_KEPT_CHANGES + 9);
  });
});

describe('a file the store cannot trust is a doc with no preference', () => {
  function plant(dir: string, docId: string, body: string): void {
    const path = notesMethodPath(dir, docId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf8');
  }

  test.each([
    ['not JSON at all', '{ this is not'],
    ['JSON that is not an object', '"original"'],
    ['an object with no method', '{"changes":[]}'],
    ['a method that does not exist', '{"method":"ledger-sonnet","changes":[]}'],
    ['a half-written file', '{"method":"ledger-op'],
  ])('%s reads as the default rather than throwing', (_what, body) => {
    const dir = dataDir();
    plant(dir, 'd1', body);
    expect(readNotesMethod(dir, 'd1')).toBe('original');
  });

  test('CONTROL: the same shape with a real method reads back', () => {
    const dir = dataDir();
    plant(dir, 'd1', '{"method":"ledger-opus","changes":[]}');
    expect(readNotesMethod(dir, 'd1')).toBe('ledger-opus');
  });

  test('a change row that is malformed is dropped, and the good rows stay', () => {
    const dir = dataDir();
    plant(
      dir,
      'd1',
      JSON.stringify({
        method: 'ledger-opus',
        changes: [
          { method: 'ledger-opus', at },
          { method: 'nonsense', at: at + 1 },
          { method: 'original', at: 'soon' },
          null,
          { method: 'ledger-haiku', at: at + 3, by: 'Ines Vantor' },
        ],
      }),
    );
    const changes = readNotesMethodRecord(dir, 'd1')?.changes ?? [];
    expect(changes.map((c) => c.method)).toEqual(['ledger-opus', 'ledger-haiku']);
  });
});

describe('the write does not expose a half-written file', () => {
  test('the file on disk parses after every write', () => {
    const dir = dataDir();
    for (const method of ['ledger-opus', 'original', 'ledger-haiku'] as const) {
      writeNotesMethod(dir, 'd1', { method, at, meetingId: `m-${method}` });
      // The rename is what makes this true; a plain write would let a reader
      // between the two syscalls see a truncated file.
      expect(() => JSON.parse(readFileSync(notesMethodPath(dir, 'd1'), 'utf8'))).not.toThrow();
    }
  });
});
