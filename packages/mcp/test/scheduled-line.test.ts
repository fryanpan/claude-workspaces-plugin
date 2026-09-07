/** The wording of the two scheduled-run wakes (`scheduled-line.ts`). */
import { describe, expect, it } from 'vitest';
import { scheduledRunLine, spawnRequestedLine } from '../src/scheduled-line.ts';

const RUN = {
  workspaceId: 'w-harbour',
  taskId: 't-run',
  title: 'Sweep the lamp doc',
  ruleId: 't-rule',
  agentId: 'agent-lamplighter',
  agentName: 'Lamplighter',
};

describe('scheduledRunLine', () => {
  it('names the instance, the rule, and the verb that takes it', () => {
    const line = scheduledRunLine({ ...RUN, attempt: 1, attempts: 4 });
    expect(line).toContain('"Sweep the lamp doc" (t-run)');
    expect(line).toContain('rule t-rule');
    expect(line).toContain('task_transition(t-run, "in-progress")');
    expect(line).not.toContain('wake 1');
  });

  it('says which wake this is once the board is repeating itself', () => {
    expect(scheduledRunLine({ ...RUN, attempt: 3, attempts: 4 })).toContain('wake 3 of 4');
  });

  it('renders from a bare id when the frame carries no title', () => {
    expect(scheduledRunLine({ taskId: 't-run' })).toContain('t-run is due');
  });
});

describe('spawnRequestedLine', () => {
  it('names the detached owner, the board the run is on, and the one-run ask', () => {
    const line = spawnRequestedLine(RUN);
    expect(line).toContain('Lamplighter is not attached to board w-harbour');
    expect(line).toContain('"Sweep the lamp doc" (t-run)');
    expect(line).toContain('spin it down');
  });

  it('falls back to the id when the owner has no name', () => {
    expect(spawnRequestedLine({ ...RUN, agentName: undefined })).toContain(
      'agent-lamplighter is not attached',
    );
  });
});
