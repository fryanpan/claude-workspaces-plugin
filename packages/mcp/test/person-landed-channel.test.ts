/**
 * `person.landed`: the owner's attended tab arrived on a page of a board this
 * session watches. One line naming the board, the page and the place in
 * view, so the agent can answer about what the person is looking at; and
 * nothing when the landing is the one this session's own `show_person`
 * caused, since the agent already knows where it sent them.
 *
 * All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import { SELF, harness, only } from './channel-harness.ts';

const landed = (over: Record<string, unknown> = {}) => ({
  workspaceId: 'w-harbor',
  person: { id: 'known-riverbend', name: 'Riverbend' },
  resource: { kind: 'doc', id: 'd-plan', title: 'Compliance plan' },
  spot: { surface: 'doc', docId: 'd-plan', blockId: 'b-retention', quote: 'Seven years' },
  ...over,
});

describe('person.landed', () => {
  it('names the board, the page and the place in view', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('person.landed', landed());
    const f = only(frames);
    expect(f.content).toContain('[person.landed]');
    expect(f.content).toContain('Riverbend');
    expect(f.content).toContain('doc d-plan "Compliance plan"');
    expect(f.content).toContain('block b-retention');
    expect(f.content).toContain('"Seven years"');
    expect(f.meta).toMatchObject({
      workspace_id: 'w-harbor',
      doc_id: 'd-plan',
      event: 'person.landed',
    });
  });

  it('names a task panel or a board page by what it is', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage(
      'person.landed',
      landed({
        resource: { kind: 'task', id: 't-7', title: 'Ship it' },
        spot: { surface: 'board', path: '/workspaces/w-harbor?task=t-7' },
      }),
    );
    await messages.emitChannelMessage(
      'person.landed',
      landed({
        resource: { kind: 'page' },
        spot: { surface: 'board', path: '/workspaces/w-harbor/home' },
      }),
    );
    expect(frames.map((f) => f.content)).toEqual([
      expect.stringContaining('task t-7 "Ship it"'),
      expect.stringContaining('/workspaces/w-harbor/home'),
    ]);
    expect(frames[0]?.meta).toMatchObject({ task_id: 't-7' });
  });

  it('says nothing about a landing this session sent the person to', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('person.landed', landed({ actor: { id: SELF, name: 'me' } }));
    expect(frames).toEqual([]);
    await messages.emitChannelMessage(
      'person.landed',
      landed({ actor: { id: 'agent-saltmarsh', name: 'Saltmarsh' } }),
    );
    expect(frames).toHaveLength(1);
  });
});
