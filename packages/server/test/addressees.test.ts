/**
 * Who a comment's `to` may name: the owner, a member of the doc's board, or
 * an agent attached to it. Never a name the body supplies.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AddresseeRoster, resolveAddressees } from '../src/addressees.ts';
import { Identities } from '../src/identities.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'cw-addressees-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
const identities = new Identities({ dataDir });
const alice = identities.upsertByEmail('alice@example.com', { displayName: 'Alice' });
const bob = identities.upsertByEmail('bob@example.com', { displayName: 'Bob' });
const saltmarsh = identities.upsertByEmail('saltmarsh@example.com', { displayName: 'Saltmarsh' });
const bot = identities.upsertAgent('riverbend-bot', 'Riverbend');
const stranger = identities.upsertAgent('harborlight-bot', 'Harborlight');

const roster: AddresseeRoster = {
  identities,
  owner: () => ({ id: 'known-owner', name: 'Owner' }),
  isMember: (board, person) => board === 'b1' && [alice.id, bob.id].includes(person.id),
  attachedAgents: (board) => (board === 'b1' ? [bot?.id ?? ''] : []),
};

const resolve = (to: unknown) => resolveAddressees(to, ['b1'], roster);

describe('resolveAddressees', () => {
  it('answers nothing for an absent `to`, and names members, the owner and attached agents by id', () => {
    expect(resolve(undefined)).toEqual({ ok: true });
    expect(resolve([alice.id, 'known-owner', bot?.id])).toEqual({
      ok: true,
      addressedTo: [
        { id: alice.id, kind: 'person', name: 'Alice' },
        { id: 'known-owner', kind: 'person', name: 'Owner' },
        { id: bot?.id ?? '', kind: 'agent', name: 'Riverbend' },
      ],
    });
  });

  it('accepts an email or a display name for a member and an agent name, and de-duplicates', () => {
    expect(resolve(['bob@example.com', 'Bob', 'Riverbend'])).toEqual({
      ok: true,
      addressedTo: [
        { id: bob.id, kind: 'person', name: 'Bob' },
        { id: bot?.id ?? '', kind: 'agent', name: 'Riverbend' },
      ],
    });
  });

  it('refuses a non-member, an unattached agent, an archived member, a made-up name and a bad shape', () => {
    for (const to of [
      [saltmarsh.id],
      [stranger?.id],
      ['Nobody'],
      'Alice',
      [7],
      [],
      new Array(11).fill(alice.id),
    ]) {
      expect(resolve(to)).toMatchObject({ ok: false, error: 'bad_addressee' });
    }
    identities.archive(bob.id);
    expect(resolve([bob.id])).toMatchObject({ ok: false, error: 'bad_addressee' });
    identities.unarchive(bob.id);
  });

  it('takes the name from the roster, never from the body', () => {
    const got = resolve([{ id: alice.id, name: 'Saltmarsh' }]);
    expect(got).toMatchObject({ ok: false });
    expect(resolve([alice.id])).toMatchObject({ addressedTo: [{ name: 'Alice' }] });
  });
});
