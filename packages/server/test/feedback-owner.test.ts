/**
 * `feedbackOwnerBoard`: which board's lead hears product feedback.
 * The delivery itself is `feedback-doc-delivery.test.ts`. Names are fixtures.
 */
import { describe, expect, it } from 'bun:test';
import { DEFAULT_FEEDBACK_BOARD, feedbackOwnerBoard } from '../src/feedback-owner.ts';

const boards = [
  { id: 'board-h', name: 'Harborlight', leadAgentId: 'agent-h' },
  { id: 'board-p', name: 'Workspaces', leadAgentId: 'agent-w' },
  { id: 'board-r', name: 'Riverbend' },
];

describe('feedbackOwnerBoard', () => {
  it('unset, picks the board named Workspaces', () => {
    expect(DEFAULT_FEEDBACK_BOARD).toBe('Workspaces');
    expect(feedbackOwnerBoard(undefined, boards)).toBe('board-p');
    expect(feedbackOwnerBoard('   ', boards)).toBe('board-p');
  });

  it('a configured id wins over the default name', () => {
    expect(feedbackOwnerBoard('board-r', boards)).toBe('board-r');
  });

  it('a configured name matches without regard to case or space', () => {
    expect(feedbackOwnerBoard(' harborLIGHT ', boards)).toBe('board-h');
  });

  it('an id match outranks a board whose NAME is that string', () => {
    const tricky = [...boards, { id: 'board-x', name: 'board-r' }];
    expect(feedbackOwnerBoard('board-r', tricky)).toBe('board-r');
  });

  it('answers null when nothing matches', () => {
    expect(feedbackOwnerBoard('Saltmarsh', boards)).toBeNull();
    expect(feedbackOwnerBoard(undefined, [])).toBeNull();
  });

  it('never picks a retired board, by id or by name', () => {
    const retired = [{ id: 'board-old', name: 'Workspaces', leadAgentId: 'agent-o', retiredAt: 1 }];
    expect(feedbackOwnerBoard(undefined, retired)).toBeNull();
    expect(feedbackOwnerBoard('board-old', retired)).toBeNull();
    // POSITIVE CONTROL: the same board unretired is picked.
    expect(feedbackOwnerBoard(undefined, [{ ...retired[0], retiredAt: undefined }])).toBe(
      'board-old',
    );
  });

  it('of several same-named boards, prefers one with a lead, then listing order', () => {
    const twins = [
      { id: 'board-a', name: 'Workspaces' },
      { id: 'board-b', name: 'Workspaces', leadAgentId: 'agent-b' },
      { id: 'board-c', name: 'Workspaces', leadAgentId: 'agent-c' },
    ];
    expect(feedbackOwnerBoard(undefined, twins)).toBe('board-b');
    expect(
      feedbackOwnerBoard(
        undefined,
        twins.map((b) => ({ id: b.id, name: b.name })),
      ),
    ).toBe('board-a');
  });
});
