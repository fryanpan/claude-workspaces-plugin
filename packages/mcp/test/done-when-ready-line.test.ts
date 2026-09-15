/** The wording of the done-when ready wake (`done-when-ready-line.ts`). */
import { describe, expect, it } from 'vitest';
import { doneWhenReadyLine } from '../src/done-when-ready-line.ts';

const FRAME = {
  taskId: 't-tide',
  title: 'Reader can read the tide chart',
  lineId: 'd-430',
  line: 'the chart reads at 430 wide',
  url: 'https://example.com/workspaces/w-1?task=t-tide',
};

describe('doneWhenReadyLine', () => {
  it('names the task, the line, the link and the exact call that hands it over', () => {
    const line = doneWhenReadyLine(FRAME);
    expect(line).toContain('"Reader can read the tide chart" (t-tide)');
    expect(line).toContain('"the chart reads at 430 wide"');
    expect(line).toContain(FRAME.url);
    expect(line).toContain('report_done_when(taskId: "t-tide"');
    expect(line).toContain('id: "d-430", verdict: "owner"');
    expect(line).not.toContain('who is not listening');
  });

  it('says whose line it is when the lead is told on the builder’s behalf', () => {
    expect(doneWhenReadyLine({ ...FRAME, forAssignee: 'Tidewright' })).toContain(
      '(for Tidewright, who is not listening)',
    );
  });
});
