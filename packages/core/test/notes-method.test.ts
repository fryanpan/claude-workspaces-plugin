import { describe, expect, test } from 'vitest';
import {
  DEFAULT_NOTES_METHOD,
  NOTES_METHODS,
  NOTES_METHOD_INFO,
  type NotesMethod,
  notesMethodInfo,
  notesMethodLabel,
  notesMethodUsesLedger,
  parseNotesMethod,
} from '../src/notes-method.ts';

describe('the method table covers the union', () => {
  test('every method has a chooser row, and no row is orphaned', () => {
    for (const id of NOTES_METHODS) expect(notesMethodInfo(id).id).toBe(id);
    expect(NOTES_METHOD_INFO.map((r) => r.id)).toEqual([...NOTES_METHODS]);
  });

  test('the rows read cheapest-first, which is the order the chooser renders', () => {
    expect(NOTES_METHOD_INFO.map((r) => r.label)).toEqual([
      'Original',
      'Ledger · Haiku',
      'Ledger · Opus',
    ]);
  });

  test('every row says completeness and price, because those are what a person picks on', () => {
    for (const row of NOTES_METHOD_INFO) expect(row.detail).toMatch(/\$\d+\.\d\d\/hr$/);
  });
});

describe('the default is the original', () => {
  // The owner's call, and the reason is a bar the ledgers do not yet hold.
  // Pinned so a later method cannot become the default by being added.
  test('a doc nobody has chosen for uses the original', () => {
    expect(DEFAULT_NOTES_METHOD).toBe('original');
  });

  test('the default runs no ledger', () => {
    expect(notesMethodUsesLedger(DEFAULT_NOTES_METHOD)).toBe(false);
  });
});

describe('parsing a method off the wire', () => {
  test.each([...NOTES_METHODS])('%s survives the round trip', (id) => {
    expect(parseNotesMethod(id)).toBe(id);
  });

  test.each([
    ['a method that does not exist', 'ledger-sonnet'],
    ['the empty string', ''],
    ['a number', 7],
    ['an object', { method: 'original' }],
    ['null', null],
    ['nothing at all', undefined],
  ])('%s is undefined, not the default', (_what, raw) => {
    // UNDEFINED AND NOT `original`: a client too old to name a method must
    // leave a stored choice standing, and only `undefined` can say that.
    expect(parseNotesMethod(raw)).toBeUndefined();
  });
});

describe('which methods run the extract pass', () => {
  test('both ledgers do, and the original does not', () => {
    const ledgers = NOTES_METHODS.filter((m: NotesMethod) => notesMethodUsesLedger(m));
    expect(ledgers).toEqual(['ledger-haiku', 'ledger-opus']);
  });
});

describe('the label the notes and the fold both use', () => {
  test('a method reads the same in the trace line as on its row', () => {
    for (const row of NOTES_METHOD_INFO) expect(notesMethodLabel(row.id)).toBe(row.label);
  });
});
