/**
 * The UI gate (`ui-review-gate.ts`): which rows in flight an agent filed,
 * that read as UI work, with nobody's answer on them. Fixtures are invented.
 */
import { describe, expect, it } from 'bun:test';
import {
  type UiGateTask,
  collectUngatedUiRows,
  uiKeywordIn,
  ungatedUiRows,
} from '../src/ui-review-gate.ts';

const breach = {
  id: 't-1',
  title: 'Agent can move the Plan button onto the ticket',
  filedByAgent: true,
  dispatched: true,
  answeredReviewItem: false,
};

describe('reading a row as UI work', () => {
  it('names the word that made it one', () => {
    expect(uiKeywordIn('Move the Plan button onto the ticket')).toBe('button');
    expect(uiKeywordIn('the CSS banner')).toBe('css');
  });

  it('folds case and takes a plural or a gerund as the same word', () => {
    expect(uiKeywordIn('Two BUTTONS on one screen')).toBe('button');
    expect(uiKeywordIn('a floating panel')).toBe('float');
    expect(uiKeywordIn('Redo the page LAYOUTS')).toBe('page');
  });

  it('matches whole words only, so server prose is not UI work', () => {
    expect(uiKeywordIn('Rebuild the quicksort routine')).toBeUndefined();
    expect(uiKeywordIn('Retry the webhook on a 500')).toBeUndefined();
    // `ui` inside a word is not the word.
    expect(uiKeywordIn('Rebuild the guidance corpus')).toBeUndefined();
  });

  it('reads the body as well as the title', () => {
    expect(
      ungatedUiRows([{ ...breach, title: 'Agent can finish the flow', body: 'Redraw the panel.' }]),
    ).toEqual([{ id: 't-1', title: 'Agent can finish the flow', keyword: 'panel' }]);
  });
});

describe('which rows are a breach', () => {
  it('flags an agent-filed UI row in flight with no answered item', () => {
    expect(ungatedUiRows([breach])).toEqual([
      { id: 't-1', title: breach.title, keyword: 'button' },
    ]);
  });

  it('clears a row on any one of the four reads failing', () => {
    expect(ungatedUiRows([{ ...breach, filedByAgent: false }])).toEqual([]);
    expect(ungatedUiRows([{ ...breach, dispatched: false }])).toEqual([]);
    expect(ungatedUiRows([{ ...breach, answeredReviewItem: true }])).toEqual([]);
    expect(ungatedUiRows([{ ...breach, title: 'Agent can retry a failed webhook' }])).toEqual([]);
  });
});

function task(parts: Partial<UiGateTask> = {}): UiGateTask {
  return {
    id: 't-1',
    title: 'Agent can move the Plan button onto the ticket',
    status: 'in-progress',
    createdBy: 'UX Bot',
    transitions: [{ to: 'in-progress', by: { name: 'UX Bot', kind: 'agent' } }],
    ...parts,
  };
}

const agentsOnly = {
  isAgentName: (name: string) => name === 'UX Bot',
  answeredReviewItem: () => false,
};

describe('collecting a board', () => {
  it('takes a row whose filer the roster places as an agent', () => {
    expect(collectUngatedUiRows([task()], agentsOnly)).toEqual([
      { id: 't-1', title: task().title, keyword: 'button' },
    ]);
  });

  it('leaves a row a person filed, even one an agent then moved', () => {
    expect(collectUngatedUiRows([task({ createdBy: 'Jordan' })], agentsOnly)).toEqual([]);
  });

  it('falls back to the first transition when nothing recorded a filer', () => {
    const row = task({ createdBy: undefined });
    expect(collectUngatedUiRows([row], { ...agentsOnly, isAgentName: () => false })).toHaveLength(
      1,
    );
  });

  it('leaves a row that is not in flight, and a goal band', () => {
    expect(collectUngatedUiRows([task({ status: 'todo' })], agentsOnly)).toEqual([]);
    expect(collectUngatedUiRows([task({ kind: 'goal' })], agentsOnly)).toEqual([]);
  });

  it('leaves an in-progress row nothing ever moved there', () => {
    expect(collectUngatedUiRows([task({ transitions: [] })], agentsOnly)).toEqual([]);
  });

  it('leaves a row somebody answered an item on', () => {
    expect(
      collectUngatedUiRows([task()], { ...agentsOnly, answeredReviewItem: () => true }),
    ).toEqual([]);
  });
});
