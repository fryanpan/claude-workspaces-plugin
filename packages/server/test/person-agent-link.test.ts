/**
 * A person's lead agent: active only when the person names the agent AND the
 * agent confirms the person, in either order.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Identities } from '../src/identities.ts';
import { PersonAgentLinks } from '../src/person-agent-link.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-person-agent-'));
  dirs.push(dataDir);
  const identities = new Identities({ dataDir });
  const alice = identities.upsertByEmail('alice@example.com').id;
  const bob = identities.upsertByEmail('bob@example.com').id;
  const a1 = identities.upsertAgent('harborlight-a1', 'Harborlight')?.id ?? '';
  const b1 = identities.upsertAgent('riverbend-b1', 'Riverbend')?.id ?? '';
  return {
    dataDir,
    identities,
    links: new PersonAgentLinks(dataDir, identities),
    alice,
    bob,
    a1,
    b1,
  };
}

describe('PersonAgentLinks', () => {
  it('links when the person names the agent and the agent confirms', () => {
    const { links, alice, a1 } = world();
    expect(links.nameLeadAgent(alice, a1)).toEqual({ ok: true, state: 'pending' });
    expect(links.personOfAgent(a1)).toBeNull();
    expect(links.confirmPerson(a1, alice)).toEqual({ ok: true, state: 'linked' });
    expect(links.personOfAgent(a1)).toBe(alice);
    expect(links.leadAgentOf(alice)).toBe(a1);
  });

  it('links in the other order too', () => {
    const { links, alice, a1 } = world();
    expect(links.confirmPerson(a1, alice)).toEqual({ ok: true, state: 'pending' });
    expect(links.nameLeadAgent(alice, a1)).toEqual({ ok: true, state: 'linked' });
    expect(links.leadAgentOf(alice)).toBe(a1);
  });

  it('refuses Bob naming an agent already linked to Alice', () => {
    const { links, alice, bob, a1 } = world();
    links.nameLeadAgent(alice, a1);
    links.confirmPerson(a1, alice);
    expect(links.nameLeadAgent(bob, a1)).toEqual({ ok: false, error: 'agent_claimed' });
    expect(links.personOfAgent(a1)).toBe(alice);
  });

  it('leaves the link pending when an agent confirms a person who never named it', () => {
    const { links, alice, bob, a1 } = world();
    links.nameLeadAgent(alice, a1);
    expect(links.confirmPerson(a1, bob)).toEqual({ ok: true, state: 'pending' });
    expect(links.personOfAgent(a1)).toBeNull();
    expect(links.leadAgentOf(bob)).toBeNull();
  });

  it('unlinks when either side clears', () => {
    const a = world();
    a.links.nameLeadAgent(a.alice, a.a1);
    a.links.confirmPerson(a.a1, a.alice);
    a.links.nameLeadAgent(a.alice, null);
    expect(a.links.personOfAgent(a.a1)).toBeNull();
    const b = world();
    b.links.nameLeadAgent(b.alice, b.a1);
    b.links.confirmPerson(b.a1, b.alice);
    b.links.confirmPerson(b.a1, null);
    expect(b.links.leadAgentOf(b.alice)).toBeNull();
  });

  it('refuses a person id, an archived agent and the shared agent id as a lead agent', () => {
    const { links, identities, alice, bob, b1 } = world();
    expect(links.nameLeadAgent(alice, bob)).toEqual({ ok: false, error: 'not_an_agent' });
    expect(links.nameLeadAgent(alice, 'known-agent')).toEqual({ ok: false, error: 'shared_agent' });
    identities.archive(b1);
    expect(links.nameLeadAgent(alice, b1)).toEqual({ ok: false, error: 'archived' });
    expect(links.confirmPerson(b1, alice)).toEqual({ ok: false, error: 'archived' });
  });

  it('stops answering a link whose person is archived', () => {
    const { links, identities, alice, a1 } = world();
    links.nameLeadAgent(alice, a1);
    links.confirmPerson(a1, alice);
    identities.archive(alice);
    expect(links.personOfAgent(a1)).toBeNull();
  });

  it('reads the same links back after a restart, from a file only its owner can read', () => {
    const { dataDir, identities, links, alice, a1 } = world();
    links.nameLeadAgent(alice, a1);
    links.confirmPerson(a1, alice);
    expect(new PersonAgentLinks(dataDir, identities).leadAgentOf(alice)).toBe(a1);
    expect(statSync(join(dataDir, 'person-agent-links.json')).mode & 0o777).toBe(0o600);
  });
});
