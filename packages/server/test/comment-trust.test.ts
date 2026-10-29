/**
 * `createCommentTrust`: who reaches an agent as `member`, over a fake roster
 * and fake boards. The end-to-end path through real routes and the MCP
 * renderer is `member-comment-trust.test.ts`. Fixture names only.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { linkIdentity, resetOwnerIdentities } from '../src/actor-identity.ts';
import { type CommentTrustContext, createCommentTrust } from '../src/comment-trust.ts';

const ALICE_ID = 'user-alice';
const ALICE = 'alice@harborlight.example';
const roster: Record<string, { kind: string; status: string; email?: string }> = {
  [ALICE_ID]: { kind: 'person', status: 'active', email: ALICE },
  'user-gone': { kind: 'person', status: 'archived', email: 'gone@harborlight.example' },
  'agent-riverbend': { kind: 'agent', status: 'active' },
};
const audiences: Record<string, string[]> = {
  harborlight: [ALICE, 'gone@harborlight.example'],
  riverbend: [],
};

function trust(over: Partial<CommentTrustContext> = {}, boards = ['harborlight']) {
  return createCommentTrust({
    identityOf: (id) => roster[id] ?? null,
    boardsForDoc: () => new Set(boards),
    memberOf: (ws, email) => audiences[ws]?.includes(email) ?? false,
    ...over,
  });
}

afterEach(() => resetOwnerIdentities());

describe('createCommentTrust', () => {
  it('stamps an admitted member by id, and the owner as owner', () => {
    expect(trust()('task:t1', { id: ALICE_ID, name: 'Alice' })).toBe('member');
    expect(trust()('task:t1', { id: 'known-bryan', name: 'Bryan' })).toBe('owner');
  });

  it('never trusts a name, an anon id, an agent row or an archived person', () => {
    expect(trust()('task:t1', { name: 'Alice' })).toBe('untrusted');
    expect(trust()('task:t1', 'Alice')).toBe('untrusted');
    expect(trust()('task:t1', { id: 'anon-harborlight', name: 'Alice' })).toBe('untrusted');
    expect(trust()('task:t1', { id: 'agent-riverbend', name: 'Riverbend' })).toBe('untrusted');
    expect(trust()('task:t1', { id: 'user-gone', name: 'Gone' })).toBe('untrusted');
  });

  it('trusts an anon id only once it is linked to a member', () => {
    linkIdentity('anon-harborlight', ALICE_ID);
    expect(trust()('task:t1', { id: 'anon-harborlight', name: 'Alice' })).toBe('member');
  });

  it('needs membership of every board the doc reaches, and of at least one', () => {
    expect(trust({}, ['harborlight', 'riverbend'])('d', { id: ALICE_ID, name: 'Alice' })).toBe(
      'untrusted',
    );
    expect(trust({}, ['riverbend'])('d', { id: ALICE_ID, name: 'Alice' })).toBe('untrusted');
    expect(trust({}, [])('d', { id: ALICE_ID, name: 'Alice' })).toBe('untrusted');
  });

  it("quotes a member whose comment carries the owner's name", () => {
    expect(trust()('task:t1', { id: ALICE_ID, name: 'Bryan' })).toBe('untrusted');
    expect(trust()('task:t1', { id: ALICE_ID, name: ' bryan ' })).toBe('untrusted');
    for (const name of [
      'Bryan Chan',
      'Bryan (owner)',
      'Bryan.',
      'ＢＲＹＡＮ',
      '\u0412ryan',
      'Bry\u200Dan',
      'Bry\u0301an',
    ]) {
      expect(trust()('task:t1', { id: ALICE_ID, name })).toBe('untrusted');
    }
    // Contains, not equals: a near-miss is quoted too.
    expect(trust()('task:t1', { id: ALICE_ID, name: 'Alice Bryant' })).toBe('untrusted');
    expect(trust()('task:t1', { id: ALICE_ID, name: 'José' })).toBe('member');
  });

  it('fails closed when the audience cannot be read', () => {
    const broken = trust({
      memberOf: () => {
        throw new Error('share-link registry unreadable');
      },
    });
    expect(broken('task:t1', { id: ALICE_ID, name: 'Alice' })).toBe('untrusted');
    expect(broken('task:t1', { id: 'known-bryan', name: 'Bryan' })).toBe('owner');
  });
});
