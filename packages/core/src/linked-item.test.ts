import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  linkedItemText,
  listThreadsWithLinks,
  postLinkedReply,
  readLinkedItem,
  readLinkedItemField,
} from './linked-item.ts';
import { createThread, listThreads } from './schema.ts';
import type { LinkedReviewItem } from './types.ts';

const TICKET: LinkedReviewItem = {
  workspaceId: 'w-riverbend',
  board: 'Riverbend',
  headline: 'Which Harborlight layout ships?',
  url: '/workspaces/w-riverbend?task=t-1',
  ref: { taskId: 't-1', reviewItemId: 'r-1' },
};
const THREAD: LinkedReviewItem = {
  ...TICKET,
  url: '/workspaces/w-riverbend/mockups/saltmarsh?thread=th-1',
  ref: { docId: 'saltmarsh', threadId: 'th-1' },
};

describe('readLinkedItem', () => {
  it('reads both kinds of item whole', () => {
    expect(readLinkedItem(TICKET)).toEqual(TICKET);
    expect(readLinkedItem(THREAD)).toEqual(THREAD);
  });

  it('drops fields it does not name', () => {
    expect(readLinkedItem({ ...TICKET, extra: '<script>' })).toEqual(TICKET);
  });

  it.each([
    ['absolute URL', 'https://elsewhere.example/x'],
    ['protocol-relative URL', '//elsewhere.example/x'],
    ['javascript URL', 'javascript:alert(1)'],
    ['relative path', 'workspaces/w-riverbend'],
    ['backslash', '/\\elsewhere.example'],
    ['whitespace', '/workspaces/w riverbend'],
    ['empty', ''],
  ])('refuses a %s', (_label, url) => {
    expect(readLinkedItem({ ...TICKET, url })).toBeUndefined();
  });

  it('refuses a missing or mixed ref, and missing text', () => {
    expect(readLinkedItem({ ...TICKET, ref: undefined })).toBeUndefined();
    expect(readLinkedItem({ ...TICKET, ref: { taskId: 't-1' } })).toBeUndefined();
    expect(
      readLinkedItem({ ...TICKET, ref: { taskId: 't-1', reviewItemId: 'r', docId: 'd' } }),
    ).toBeUndefined();
    expect(readLinkedItem({ ...TICKET, headline: '' })).toBeUndefined();
    expect(readLinkedItem({ ...TICKET, board: 7 })).toBeUndefined();
    expect(readLinkedItem({ ...TICKET, headline: 'x'.repeat(501) })).toBeUndefined();
    expect(readLinkedItem('nope')).toBeUndefined();
  });

  it('spreads to nothing when absent', () => {
    expect(readLinkedItemField(undefined)).toEqual({});
    expect(readLinkedItemField(TICKET)).toEqual({ linkedItem: TICKET });
  });
});

describe('a linked item on a comment', () => {
  it('round-trips through listThreadsWithLinks, and a malformed one reads as an ordinary comment', () => {
    const doc = new Y.Doc();
    const alice = { id: 'alice', name: 'Alice', kind: 'known' as const, color: '#336699' };
    createThread(doc, {
      threadId: 'th',
      anchor: { kind: 'subject' } as never,
      createdBy: alice,
      firstComment: { id: 'c1', text: 'Is this the right layout?' },
    });
    postLinkedReply(doc, 'th', { id: 'c2', author: alice, text: 'linked', linkedItem: TICKET });
    postLinkedReply(doc, 'th', {
      id: 'c3',
      author: alice,
      text: 'bad',
      linkedItem: { ...TICKET, url: 'https://elsewhere.example' },
    });
    // The budgeted reader leaves it out; the server's reader reads it in.
    const plain = listThreads(doc)[0]?.comments.find((c) => c.id === 'c2');
    expect(plain && 'linkedItem' in plain).toBe(false);
    const [thread] = listThreadsWithLinks(doc);
    expect(thread?.comments.find((c) => c.id === 'c2')?.linkedItem).toEqual(TICKET);
    const bad = thread?.comments.find((c) => c.id === 'c3');
    expect(bad?.text).toBe('bad');
    expect(bad && 'linkedItem' in bad).toBe(false);
  });
});

describe('linkedItemText', () => {
  it('names the board, the headline and the link, under an optional note', () => {
    const line = linkedItemText(TICKET);
    expect(line).toContain('Riverbend');
    expect(line).toContain(TICKET.headline);
    expect(line).toContain(TICKET.url);
    expect(
      linkedItemText(TICKET, 'Bob, this is the ask.').startsWith('Bob, this is the ask.'),
    ).toBe(true);
  });
});
