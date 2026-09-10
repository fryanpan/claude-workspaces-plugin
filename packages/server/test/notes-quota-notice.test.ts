/**
 * The doc-facing half of a quota outage: one notice, and its retraction.
 *
 * Driven through the edits the module answers with, which is what the notes
 * pipeline hands the doc. All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  type NoticeOutlineEntry,
  QUOTA_NOTICE_MARK,
  QUOTA_NOTICE_TEXT,
  createQuotaNoticeState,
  quotaNoticeClearEdits,
  quotaNoticeEdits,
} from '../src/notes-quota-notice.ts';

const notice = (id: string): NoticeOutlineEntry => ({
  id,
  text: QUOTA_NOTICE_TEXT,
  author: 'meeting-notes',
});

describe('quotaNoticeEdits', () => {
  it('writes the notice under the meeting section when there is one', () => {
    const state = createQuotaNoticeState();
    const edits = quotaNoticeEdits(state, [], 'h1');
    expect(edits).toEqual([
      { op: 'insert_under_heading', headingId: 'h1', markdown: QUOTA_NOTICE_TEXT },
    ]);
  });

  it('writes at the end of the doc when the section is not open yet', () => {
    const edits = quotaNoticeEdits(createQuotaNoticeState(), [], undefined);
    expect(edits).toEqual([{ op: 'insert_at_end', markdown: QUOTA_NOTICE_TEXT }]);
  });

  it('says it once per outage: a second refusal writes nothing', () => {
    const state = createQuotaNoticeState();
    expect(quotaNoticeEdits(state, [], 'h1')).toHaveLength(1);
    expect(quotaNoticeEdits(state, [], 'h1')).toEqual([]);
    expect(quotaNoticeEdits(state, [], 'h1')).toEqual([]);
  });

  it('adopts a notice already in the doc, so a restarted session adds no second one', () => {
    // A fresh state — the session restarted mid-outage and remembers nothing.
    const state = createQuotaNoticeState();
    expect(quotaNoticeEdits(state, [notice('b7')], 'h1')).toEqual([]);
    // And it knows the doc is claiming an outage, so the retraction still runs.
    expect(state.open).toBe(true);
  });

  it('ignores a person’s own line that happens to start the same way', () => {
    const theirs: NoticeOutlineEntry = { id: 'b3', text: `${QUOTA_NOTICE_MARK} again?` };
    expect(quotaNoticeEdits(createQuotaNoticeState(), [theirs], 'h1')).toHaveLength(1);
  });

  it('says nothing at all about the credential', () => {
    const [edit] = quotaNoticeEdits(createQuotaNoticeState(), [], 'h1');
    const text = edit && 'markdown' in edit ? edit.markdown : '';
    expect(text).not.toMatch(/key|token|x-api|secret/i);
  });
});

describe('quotaNoticeClearEdits', () => {
  it('deletes every notice the note-taker wrote, and nothing else', () => {
    const state = createQuotaNoticeState();
    quotaNoticeEdits(state, [], 'h1');
    const outline: NoticeOutlineEntry[] = [
      { id: 'b1', text: 'Deployment moved to Thursday.', author: 'meeting-notes' },
      notice('b2'),
      { id: 'b3', text: `${QUOTA_NOTICE_MARK} — I typed this` /* no author: a person */ },
      notice('b4'),
    ];
    expect(quotaNoticeClearEdits(state, outline)).toEqual([
      { op: 'delete_block', blockId: 'b2' },
      { op: 'delete_block', blockId: 'b4' },
    ]);
    expect(state.open).toBe(false);
  });

  it('reopens the outage after a clear, so a later one is announced again', () => {
    const state = createQuotaNoticeState();
    quotaNoticeEdits(state, [], 'h1');
    quotaNoticeClearEdits(state, [notice('b2')]);
    expect(quotaNoticeEdits(state, [], 'h1')).toHaveLength(1);
  });
});
