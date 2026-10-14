import { describe, expect, it } from 'bun:test';
import * as Y from 'yjs';
import { findAndReplace, getProseFragment, parseMarkdownBlocks } from '../../core/src/prose.ts';
import {
  STALE_WRITE_WINDOW_MS,
  touchedBlockKeys,
  touchedByDryRun,
  unseenHumanEdit,
} from '../src/scoped-edit-guard.ts';

function docOf(md: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).push(parseMarkdownBlocks(md));
  return doc;
}

/** The keys of the doc's top-level blocks, in order. */
function blockKeys(doc: Y.Doc): string[] {
  return getProseFragment(doc)
    .toArray()
    .map((b) => {
      const id = (b as Y.XmlElement)._item?.id;
      return id ? `${id.client}:${id.clock}` : '';
    });
}

const MD = 'Harborlight paragraph.\n\nRiverbend paragraph.\n\nSaltmarsh paragraph.\n';

describe('touchedBlockKeys', () => {
  it('names the top-level block a deep edit landed in, and nothing else', () => {
    const doc = docOf(MD);
    const fragment = getProseFragment(doc);
    const seen: string[][] = [];
    fragment.observeDeep((events) => seen.push([...touchedBlockKeys(fragment, events)]));
    findAndReplace(doc, { find: 'Riverbend', replace: 'Riverbend Quay' });
    expect(seen).toEqual([[blockKeys(doc)[1] ?? '']]);
  });

  it('names a deleted block and an inserted one', () => {
    const doc = docOf(MD);
    const fragment = getProseFragment(doc);
    const first = blockKeys(doc)[0] ?? '';
    const seen = new Set<string>();
    fragment.observeDeep((events) => {
      for (const k of touchedBlockKeys(fragment, events)) seen.add(k);
    });
    doc.transact(() => {
      fragment.delete(0, 1);
      fragment.insert(0, [new Y.XmlElement('paragraph')]);
    });
    expect(seen.has(first)).toBe(true);
    expect(seen.has(blockKeys(doc)[0] ?? '')).toBe(true);
  });
});

describe('touchedByDryRun', () => {
  it('reports the edited block and leaves the live doc as it was', () => {
    const doc = docOf(MD);
    const before = getProseFragment(doc).toString();
    const { result, touched } = touchedByDryRun(doc, getProseFragment, (copy) =>
      findAndReplace(copy, { find: 'Saltmarsh', replace: 'Saltmarsh Flats' }),
    );
    expect(result.ok).toBe(true);
    expect([...touched]).toEqual([blockKeys(doc)[2] ?? '']);
    expect(getProseFragment(doc).toString()).toBe(before);
  });
});

describe('unseenHumanEdit', () => {
  const now = 1_000_000_000;
  const stamps = new Map([
    ['a', now - 5_000],
    ['b', now - 2 * STALE_WRITE_WINDOW_MS],
  ]);

  it('a tracked reader is judged by order: an edit at or after the read is unseen', () => {
    expect(unseenHumanEdit(new Set(['a']), stamps, { lastReadAt: now - 6_000, now })).toBe(
      now - 5_000,
    );
    expect(unseenHumanEdit(new Set(['a']), stamps, { lastReadAt: now - 5_000, now })).toBe(
      now - 5_000,
    );
    expect(
      unseenHumanEdit(new Set(['a']), stamps, { lastReadAt: now - 4_999, now }),
    ).toBeUndefined();
  });

  it('an untracked reader is judged by the window', () => {
    expect(unseenHumanEdit(new Set(['a']), stamps, { now })).toBe(now - 5_000);
    expect(unseenHumanEdit(new Set(['b']), stamps, { now })).toBeUndefined();
  });

  it('a block no person touched is never stale', () => {
    expect(unseenHumanEdit(new Set(['c']), stamps, { now })).toBeUndefined();
    expect(unseenHumanEdit(new Set(['a']), undefined, { now })).toBeUndefined();
  });
});
