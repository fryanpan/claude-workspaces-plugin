import { describe, expect, it } from 'vitest';
/**
 * An agent session's edits through the collab core: who it is, what
 * `editDoc` and `setTile` do to a room's doc, what they refuse, and that a
 * page holding only a view role cannot run them.
 */
import * as Y from 'yjs';
import {
  type EditResult,
  agentPrincipal,
  editDocAction,
  isAgentPrincipal,
  setTileAction,
} from '../src/agent/index.ts';
import { type CollabRole, type Principal, createRoomHost } from '../src/collab/index.ts';

const ROOM = 'harborlight';
const ALICE: Principal = { id: 'alice', name: 'Alice' };

/** One room whose doc the test holds, the agent as editor, Alice as `role`. */
function room(aliceRole: CollabRole = 'view') {
  const doc = new Y.Doc();
  const origins: unknown[] = [];
  doc.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin));
  const agent = agentPrincipal('sess_01', 'Riverbend');
  const host = createRoomHost({
    docs: { open: (id) => (id === ROOM ? doc : null) },
    role: (who) => (who.id === agent.id ? 'edit' : who.id === ALICE.id ? aliceRole : null),
    actions: { editDoc: editDocAction(), setTile: setTileAction({ maxBytes: 100 }) },
  });
  const run = (who: Principal, name: string, body: unknown) => {
    const res = host.action(ROOM, who, name, body);
    return res.ok ? (res.value as EditResult) : res;
  };
  return { doc, origins, agent, run };
}

describe('agentPrincipal', () => {
  it('names one session, and only an agent: id reads as an agent', () => {
    const agent = agentPrincipal('sess_01', 'Riverbend');
    expect(agent).toEqual({ id: 'agent:sess_01', name: 'Riverbend' });
    expect(isAgentPrincipal(agent)).toBe(true);
    expect(isAgentPrincipal(ALICE)).toBe(false);
  });

  it('refuses a session id that could smuggle a separator or be empty', () => {
    for (const bad of ['', 'a:b', 'a b', 'x'.repeat(129)]) {
      expect(() => agentPrincipal(bad), bad).toThrow(TypeError);
    }
  });
});

describe('editDoc', () => {
  it('replaces the whole text as one splice, so a cursor outside it stays', () => {
    const { doc, agent, run } = room();
    const text = doc.getText('body');
    text.insert(0, 'Tide at noon. Wind light.');
    const cursor = Y.createRelativePositionFromTypeIndex(text, 20); // in "light"
    expect(run(agent, 'editDoc', { text: 'Tide at dusk. Wind light.' })).toEqual({ ok: true });
    expect(text.toString()).toBe('Tide at dusk. Wind light.');
    expect(Y.createAbsolutePositionFromRelativePosition(cursor, doc)?.index).toBe(20);
  });

  it('replaces one passage that occurs exactly once', () => {
    const { doc, agent, run } = room();
    doc.getText('body').insert(0, 'alpha beta gamma');
    expect(run(agent, 'editDoc', { find: 'beta', replace: 'BETA' })).toEqual({ ok: true });
    expect(doc.getText('body').toString()).toBe('alpha BETA gamma');
  });

  it('tells the agent what to fix instead of guessing', () => {
    const { doc, agent, run } = room();
    doc.getText('body').insert(0, 'one two one');
    const err = (body: unknown) => (run(agent, 'editDoc', body) as { error: string }).error;
    expect(err({ find: 'three', replace: 'x' })).toBe('no-match');
    expect(err({ find: 'one', replace: 'x' })).toBe('ambiguous');
    expect(err({ find: '', replace: 'x' })).toBe('bad-body');
    expect(err({ text: 42 })).toBe('bad-body');
    expect(doc.getText('body').toString()).toBe('one two one');
  });

  it('writes in one transaction whose origin is the agent', () => {
    const { doc, origins, agent, run } = room();
    doc.getText('body').insert(0, 'draft');
    origins.length = 0;
    run(agent, 'editDoc', { text: 'final draft' });
    expect(origins).toEqual([agent]);
  });
});

describe('setTile', () => {
  it('writes a JSON value a page reads back as plain data, and null removes it', () => {
    const { doc, agent, run } = room();
    expect(run(agent, 'setTile', { tile: 'sleep', value: { hours: 7.5 } })).toEqual({ ok: true });
    expect(doc.getMap('tiles').toJSON()).toEqual({ sleep: { hours: 7.5 } });
    expect(run(agent, 'setTile', { tile: 'sleep', value: null })).toEqual({ ok: true });
    expect(doc.getMap('tiles').toJSON()).toEqual({});
  });

  it('refuses a bad tile name, a missing value and one over the size limit', () => {
    const { doc, agent, run } = room();
    const err = (body: unknown) => (run(agent, 'setTile', body) as { error: string }).error;
    expect(err({ tile: '', value: 1 })).toBe('bad-body');
    expect(err({ tile: 'a/b', value: 1 })).toBe('bad-body');
    expect(err({ tile: 'sleep' })).toBe('bad-body');
    expect(err({ tile: 'sleep', value: 'x'.repeat(200) })).toBe('too-large');
    expect(doc.getMap('tiles').size).toBe(0);
  });
});

describe('who may run them', () => {
  it('a view or comment role cannot; an edit role can', () => {
    for (const role of ['view', 'comment'] as const) {
      const { doc, run } = room(role);
      const res = run(ALICE, 'setTile', { tile: 'sleep', value: 1 }) as { error: string };
      expect(res.error, role).toBe('read-only');
      expect(doc.getMap('tiles').size).toBe(0);
    }
    const { run } = room('edit');
    expect(run(ALICE, 'setTile', { tile: 'sleep', value: 1 })).toEqual({ ok: true });
  });
});
