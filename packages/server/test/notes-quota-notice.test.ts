/**
 * The doc-facing half of a quota outage: one notice, and its retraction.
 *
 * Every case here is about what the SESSION believes versus what the DOC
 * says. The two only agree if the state moves on an accepted write, so the
 * writer is a spy that can decline — a sink is allowed to throw, answer
 * `false`, or refuse on policy, and each of those used to be treated as
 * success.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import {
  type NoticeOutlineEntry,
  QUOTA_NOTICE_MARK,
  QUOTA_NOTICE_TEXT,
  announceQuotaOutage,
  createQuotaNoticeState,
  retractQuotaNotice,
} from '../src/notes-quota-notice.ts';

const notice = (id: string): NoticeOutlineEntry => ({
  id,
  text: QUOTA_NOTICE_TEXT,
  author: 'meeting-notes',
});

/** A writer that records what it was handed and answers what the test says. */
function writer(accepts = true) {
  const batches: Array<readonly prose.BlockEdit[]> = [];
  return {
    batches,
    write: (edits: readonly prose.BlockEdit[]): boolean => {
      batches.push(edits);
      return accepts;
    },
  };
}

describe('announcing a quota outage', () => {
  it('writes the notice under the meeting section when there is one', () => {
    const w = writer();
    const state = createQuotaNoticeState();
    announceQuotaOutage(state, [], 'h1', w.write);
    expect(w.batches).toEqual([
      [{ op: 'insert_under_heading', headingId: 'h1', markdown: QUOTA_NOTICE_TEXT }],
    ]);
    expect(state.open).toBe(true);
  });

  it('writes at the end of the doc when the section is not open yet', () => {
    const w = writer();
    announceQuotaOutage(createQuotaNoticeState(), [], undefined, w.write);
    expect(w.batches).toEqual([[{ op: 'insert_at_end', markdown: QUOTA_NOTICE_TEXT }]]);
  });

  it('says it once per outage: a second refusal writes nothing', () => {
    const w = writer();
    const state = createQuotaNoticeState();
    announceQuotaOutage(state, [], 'h1', w.write);
    announceQuotaOutage(state, [], 'h1', w.write);
    announceQuotaOutage(state, [], 'h1', w.write);
    expect(w.batches).toHaveLength(1);
  });

  it('tries again when the doc DECLINED the notice — else the room is never told', () => {
    // The write bounced, so the doc says nothing about the outage. Believing
    // it had landed would suppress every later refusal for the whole meeting.
    const declined = writer(false);
    const state = createQuotaNoticeState();
    announceQuotaOutage(state, [], 'h1', declined.write);
    expect(state.open).toBe(false);

    const accepted = writer();
    announceQuotaOutage(state, [], 'h1', accepted.write);
    expect(accepted.batches).toHaveLength(1);
    expect(state.open).toBe(true);
  });

  it('adopts a notice already in the doc, so a restarted session adds no second one', () => {
    const w = writer();
    const state = createQuotaNoticeState();
    announceQuotaOutage(state, [notice('b7')], 'h1', w.write);
    expect(w.batches).toEqual([]);
    expect(state.open).toBe(true);
  });

  it('ignores a person’s own line that happens to start the same way', () => {
    const w = writer();
    const theirs: NoticeOutlineEntry = { id: 'b3', text: `${QUOTA_NOTICE_MARK} again?` };
    announceQuotaOutage(createQuotaNoticeState(), [theirs], 'h1', w.write);
    expect(w.batches).toHaveLength(1);
  });

  it('says nothing at all about the credential', () => {
    const w = writer();
    announceQuotaOutage(createQuotaNoticeState(), [], 'h1', w.write);
    const edit = w.batches[0]?.[0];
    const text = edit && 'markdown' in edit ? edit.markdown : '';
    expect(text).not.toMatch(/key|token|x-api|secret/i);
  });
});

describe('retracting the notice', () => {
  it('deletes every notice the note-taker wrote, and nothing else', () => {
    const w = writer();
    const state = createQuotaNoticeState();
    announceQuotaOutage(state, [], 'h1', writer().write);
    const outline: NoticeOutlineEntry[] = [
      { id: 'b1', text: 'Deployment moved to Thursday.', author: 'meeting-notes' },
      notice('b2'),
      { id: 'b3', text: `${QUOTA_NOTICE_MARK} — I typed this` },
      notice('b4'),
    ];
    retractQuotaNotice(state, outline, w.write);
    expect(w.batches).toEqual([
      [
        { op: 'delete_block', blockId: 'b2' },
        { op: 'delete_block', blockId: 'b4' },
      ],
    ]);
    expect(state.open).toBe(false);
  });

  it('writes nothing when the doc carries no notice', () => {
    const w = writer();
    retractQuotaNotice(createQuotaNoticeState(), [], w.write);
    expect(w.batches).toEqual([]);
  });

  it('tries again when the doc DECLINED the deletion', () => {
    // A rejected delete leaves the sentence standing. Closing the state here
    // would mean no later tick ever looks, and the doc claims an outage that
    // ended for the rest of the meeting.
    const declined = writer(false);
    const state = createQuotaNoticeState();
    announceQuotaOutage(state, [], 'h1', writer().write);
    retractQuotaNotice(state, [notice('b2')], declined.write);
    expect(state.open).toBe(true);

    const accepted = writer();
    retractQuotaNotice(state, [notice('b2')], accepted.write);
    expect(accepted.batches).toHaveLength(1);
    expect(state.open).toBe(false);
  });

  it('clears a notice this session never wrote — the restart case', () => {
    // A session that started mid-outage remembers writing nothing. If quota
    // recovered before its first compose, its own memory is the wrong thing
    // to ask; the doc is the right thing.
    const w = writer();
    const fresh = createQuotaNoticeState();
    expect(fresh.open).toBe(false);
    retractQuotaNotice(fresh, [notice('b9')], w.write);
    expect(w.batches).toEqual([[{ op: 'delete_block', blockId: 'b9' }]]);
  });

  it('reopens the outage after a clear, so a later one is announced again', () => {
    const state = createQuotaNoticeState();
    announceQuotaOutage(state, [], 'h1', writer().write);
    retractQuotaNotice(state, [notice('b2')], writer().write);
    const w = writer();
    announceQuotaOutage(state, [], 'h1', w.write);
    expect(w.batches).toHaveLength(1);
  });
});
