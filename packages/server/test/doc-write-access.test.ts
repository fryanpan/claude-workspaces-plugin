/**
 * `docWriteNeed`: the level each doc subroute write needs. The routes behind
 * it are driven end to end in `thread-write-access.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { docWriteNeed } from '../src/routes/doc-write-access.ts';

describe('docWriteNeed', () => {
  it('asks nothing of a read', () => {
    for (const rest of ['threads', 'threads/t1', 'suggestions', 'content']) {
      expect(docWriteNeed('GET', rest), rest).toBeNull();
      expect(docWriteNeed('HEAD', rest), rest).toBeNull();
    }
  });

  it('asks comment of a thread write, and edit of one that changes the text', () => {
    for (const rest of [
      'threads',
      'threads/by_find',
      'threads/t1/comments',
      'threads/t1/resolve',
    ]) {
      expect(docWriteNeed('POST', rest), rest).toBe('comment');
    }
    for (const verb of ['rewrite_region', 'insert_after', 'insert_blocks_after']) {
      expect(docWriteNeed('POST', `threads/t1/${verb}`), verb).toBe('edit');
    }
  });

  it('asks edit of every text edit and suggestion answer', () => {
    for (const rest of [
      'content',
      'find_and_replace',
      'block_edits',
      'delete_section',
      'agent_anchors',
      'agent_anchors/a1/edit',
      'suggestions/s1/accept',
      'suggestions/resolve_all',
    ]) {
      expect(docWriteNeed('POST', rest), rest).toBe('edit');
    }
    expect(docWriteNeed('DELETE', 'agent_anchors/a1')).toBe('edit');
  });

  it('does not judge a subroute it does not name', () => {
    expect(docWriteNeed('POST', 'title')).toBeNull();
    expect(docWriteNeed('POST', 'threadsx')).toBeNull();
  });
});
