import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { setCommentDelivered } from './comment-delivery.ts';
import { createThread, readThread } from './schema.ts';
import type { User } from './types.ts';

const author: User = { id: 'u-1', name: 'Bryan', color: '#2e7dd7', kind: 'known' };

function seed(): { doc: Y.Doc; commentId: string } {
  const doc = new Y.Doc();
  createThread(doc, {
    threadId: 'th-1',
    anchor: { kind: 'subject' },
    createdBy: author,
    firstComment: { id: 'c-1', text: 'does this reach anyone?' },
  });
  return { doc, commentId: 'c-1' };
}

const readComment = (doc: Y.Doc) => {
  const map = doc.getMap<Y.Map<unknown>>('threads').get('th-1');
  return map ? readThread(map, 'th-1')?.comments[0] : undefined;
};

describe('setCommentDelivered', () => {
  it('stamps a comment that has never been delivered, and the stamp reads back', () => {
    const { doc, commentId } = seed();
    expect(readComment(doc)?.deliveredAt).toBeUndefined();
    expect(setCommentDelivered(doc, 'th-1', commentId, 1234)).toBe('stamped');
    expect(readComment(doc)?.deliveredAt).toBe(1234);
  });

  it('leaves the first delivery standing when a redelivery arrives', () => {
    const { doc, commentId } = seed();
    setCommentDelivered(doc, 'th-1', commentId, 1234);
    expect(setCommentDelivered(doc, 'th-1', commentId, 9999)).toBe('already');
    expect(readComment(doc)?.deliveredAt).toBe(1234);
  });

  it('writes nothing to the doc on a redelivery', () => {
    const { doc, commentId } = seed();
    setCommentDelivered(doc, 'th-1', commentId, 1234);
    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });
    setCommentDelivered(doc, 'th-1', commentId, 9999);
    expect(updates).toBe(0);
  });

  it('reports a thread or comment that has gone rather than throwing', () => {
    const { doc } = seed();
    expect(setCommentDelivered(doc, 'th-missing', 'c-1', 1)).toBe('gone');
    expect(setCommentDelivered(doc, 'th-1', 'c-missing', 1)).toBe('gone');
  });
});
