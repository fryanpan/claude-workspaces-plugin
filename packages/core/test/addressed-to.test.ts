import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createThread, getThreads, listThreads, postReply, setStatus } from '../src/schema.ts';
import type { Addressee, Anchor, User } from '../src/types.ts';

/**
 * A comment can name who it is for. The server writes `addressedTo`; every
 * reader gets it back off the ydoc, and an open thread whose latest comment
 * names people is waiting on them.
 */
const OWNER: User = { id: 'known-owner', name: 'Harborlight', kind: 'known', color: '#336699' };
const ALICE: Addressee = { id: 'user-alice', kind: 'person', name: 'Alice' };
const BOT: Addressee = { id: 'agent-riverbend', kind: 'agent', name: 'Riverbend' };
const anchor: Anchor = { kind: 'subject' } as Anchor;

describe('addressedTo on a comment', () => {
  it('reads back on the first comment and on a reply, and is absent when not written', () => {
    const doc = new Y.Doc();
    const t = createThread(doc, {
      threadId: 't1',
      anchor,
      createdBy: OWNER,
      firstComment: { id: 'c1', text: 'for Alice', addressedTo: [ALICE] },
    });
    expect(t.comments[0]?.addressedTo).toEqual([ALICE]);
    const reply = postReply(doc, 't1', {
      id: 'c2',
      author: OWNER,
      text: 'and the bot',
      addressedTo: [BOT],
    });
    expect(reply?.addressedTo).toEqual([BOT]);
    postReply(doc, 't1', { id: 'c3', author: OWNER, text: 'to nobody' });
    const read = listThreads(doc)[0];
    expect(read?.comments.map((c) => c.addressedTo)).toEqual([[ALICE], [BOT], undefined]);
  });

  it('drops a malformed value written by a peer rather than handing it to a renderer', () => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't1',
      anchor,
      createdBy: OWNER,
      firstComment: { id: 'c1', text: 'x' },
    });
    const comments = getThreads(doc).get('t1')?.get('comments') as Y.Array<Y.Map<unknown>>;
    doc.transact(() =>
      comments
        .get(0)
        .set('addressedTo', [{ id: 7 }, 'nobody', { id: 'a', kind: 'robot', name: 'x' }]),
    );
    expect(listThreads(doc)[0]?.comments[0]?.addressedTo).toBeUndefined();
  });

  it('is waiting on the people the latest comment names, until it resolves or someone replies unaddressed', () => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't1',
      anchor,
      createdBy: OWNER,
      firstComment: { id: 'c1', text: 'Alice?', addressedTo: [ALICE, BOT] },
    });
    expect(listThreads(doc)[0]?.waitingOn).toEqual(['user-alice', 'agent-riverbend']);
    setStatus(doc, 't1', 'resolved');
    expect(listThreads(doc)[0]?.waitingOn).toBeUndefined();
    setStatus(doc, 't1', 'open');
    postReply(doc, 't1', { id: 'c2', author: OWNER, text: 'never mind' });
    expect(listThreads(doc)[0]?.waitingOn).toBeUndefined();
  });
});
