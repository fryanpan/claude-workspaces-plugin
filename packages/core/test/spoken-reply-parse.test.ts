import { describe, expect, it } from 'vitest';
import { parseSpokenClientMessage, spokenDecisionRequest } from '../src/spoken-reply.ts';

/** The pause a voice page may set on its spoken-reply socket, which the
 *  server's session reads (`msg.pause`), and the request a spoken review
 *  decision turns into. All values synthetic. */
describe('the pause a page sets', () => {
  it('passes two waits inside the range, rounded', () => {
    expect(
      parseSpokenClientMessage(
        JSON.stringify({ type: 'pause', pause: { finishedMs: 1200.4, unfinishedMs: 2600 } }),
      ),
    ).toEqual({ type: 'pause', pause: { finishedMs: 1200, unfinishedMs: 2600 } });
  });

  it('refuses the frame when either wait is outside 500ms to 10s', () => {
    for (const pause of [
      { finishedMs: 100, unfinishedMs: 2600 },
      { finishedMs: 1200, unfinishedMs: 60_000 },
      { finishedMs: 1200 },
      'fast',
    ]) {
      expect(parseSpokenClientMessage(JSON.stringify({ type: 'pause', pause }))).toBeNull();
    }
  });
});

describe('undoing a spoken review decision', () => {
  it("posts to the task review item's undo, with no body", () => {
    expect(
      spokenDecisionRequest({
        id: 'd1',
        action: 'undo',
        target: { kind: 'task-review', taskId: 't-1', reviewItemId: 'r 1' },
      }),
    ).toEqual({ sub: 'tasks/t-1/review-items/r%201/answer/undo', body: {} });
  });

  it("posts to the doc thread's undo, naming the comment", () => {
    expect(
      spokenDecisionRequest({
        id: 'd2',
        action: 'undo',
        target: { kind: 'doc-thread', docId: 'd-1', threadId: 'th-1', commentId: 'c-1' },
      }),
    ).toEqual({ sub: 'docs/d-1/threads/th-1/answer/undo', body: { commentId: 'c-1' } });
  });
});
