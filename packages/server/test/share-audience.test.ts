/**
 * A share link's audience on its own: what the parser accepts, what an entry
 * admits, and how the store applies it at redemption and on every later
 * membership question. The HTTP half is `share-link-audience.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audienceAdmits, parseShareAudience, storedAudience } from '../src/share/share-audience.ts';
import { ShareLinks } from '../src/share/share-links.ts';

const ALICE = 'alice@harborlight.example';
const BOB = 'bob@harborlight.example';
const RIVERBEND = 'alice@riverbend.example';

describe('parseShareAudience', () => {
  it('accepts addresses and @domains, lower-cased and de-duplicated', () => {
    expect(parseShareAudience(['Alice@Harborlight.Example', '@riverbend.example', ALICE])).toEqual({
      ok: true,
      audience: [ALICE, '@riverbend.example'],
    });
  });

  for (const bad of [
    '',
    ' ',
    ' @harborlight.example',
    'alice @harborlight.example',
    '@',
    'alice@',
    '*@harborlight.example',
    '@*.harborlight.example',
    'alice@bob@harborlight.example',
    '*.harborlight.example',
    '@harborlight',
    '@-harborlight.example',
    '@harborlight..example',
  ]) {
    it(`refuses ${JSON.stringify(bad)}, and the whole list with it`, () => {
      expect(parseShareAudience([ALICE, bad]).ok).toBe(false);
    });
  }

  it('reads a bare domain as @domain, the shape older callers send', () => {
    expect(parseShareAudience(['Harborlight.Example'])).toEqual({
      ok: true,
      audience: ['@harborlight.example'],
    });
  });

  it('refuses an empty list, a non-list and a non-string entry', () => {
    expect(parseShareAudience([]).ok).toBe(false);
    expect(parseShareAudience('@harborlight.example').ok).toBe(false);
    expect(parseShareAudience([42]).ok).toBe(false);
  });

  it('reads a stored audience that does not parse as one admitting nobody', () => {
    expect(storedAudience(undefined)).toBeUndefined();
    expect(storedAudience(['*'])).toEqual([]);
    expect(audienceAdmits(storedAudience(['*']), ALICE)).toBe(false);
  });
});

describe('audienceAdmits', () => {
  const domain = ['@harborlight.example'];
  it('admits an exact address and no other', () => {
    expect(audienceAdmits([ALICE], ALICE)).toBe(true);
    expect(audienceAdmits([ALICE], BOB)).toBe(false);
  });
  it('admits every address at the domain, case-insensitively', () => {
    expect(audienceAdmits(domain, BOB)).toBe(true);
    expect(audienceAdmits(domain, 'Bob@HarborLight.EXAMPLE')).toBe(true);
    expect(audienceAdmits([ALICE], 'ALICE@harborlight.example')).toBe(true);
  });
  it('does not admit a lookalike domain or a subdomain', () => {
    expect(audienceAdmits(domain, 'x@harborlight.example.evil.test')).toBe(false);
    expect(audienceAdmits(domain, 'x@sub.harborlight.example')).toBe(false);
    expect(audienceAdmits(domain, 'x@evilharborlight.example')).toBe(false);
  });
  it('admits everyone when there is no audience', () => {
    expect(audienceAdmits(undefined, RIVERBEND)).toBe(true);
  });
});

describe('the store applies the audience', () => {
  let dataDir: string;
  let links: ShareLinks;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'share-audience-'));
    links = new ShareLinks({ dataDir });
    // The board names both domains, so what these cases test is the LINK's
    // own audience inside it (the board's is `board-audience.test.ts`).
    links.addToAudience('w-board', ['@harborlight.example', '@riverbend.example'], 'Bryan');
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const mint = (allowDomains?: string[]) =>
    links.create({
      workspaceId: 'w-board',
      createdBy: 'Test Agent',
      ...(allowDomains ? { allowDomains } : {}),
    });

  it('refuses a redemption outside the audience and writes nothing', () => {
    const link = mint(['@harborlight.example']);
    expect(links.redeem(link.linkId, RIVERBEND)).toEqual({ ok: false, state: 'outside-audience' });
    expect(links.isMember('w-board', RIVERBEND)).toBe(false);
    expect(links.allMembers()).toHaveLength(0);
    expect(links.get(link.linkId)?.redemptions).toHaveLength(0);
    expect(links.redeem(link.linkId, BOB).ok).toBe(true);
    expect(links.isMember('w-board', BOB)).toBe(true);
  });

  it('ends a member once the audience on disk stops naming them, and a new link re-admits', () => {
    const link = mint([ALICE, BOB]);
    links.redeem(link.linkId, ALICE);
    links.redeem(link.linkId, BOB);
    const path = join(dataDir, 'share-links.json');
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    disk.links[0].allowDomains = [BOB];
    writeFileSync(path, JSON.stringify(disk));
    const reloaded = new ShareLinks({ dataDir });
    expect(reloaded.isMember('w-board', ALICE)).toBe(false);
    expect(reloaded.roleOf('w-board', ALICE)).toBeNull();
    expect(reloaded.isMember('w-board', BOB)).toBe(true);
    // A second link that does name Alice lets her back in.
    const open = reloaded.create({ workspaceId: 'w-board', createdBy: 'Test Agent' });
    expect(reloaded.redeem(open.linkId, ALICE)).toMatchObject({ ok: true, added: true });
    expect(reloaded.isMember('w-board', ALICE)).toBe(true);
  });

  const narrowOnDisk = (audience: string[]) => {
    const path = join(dataDir, 'share-links.json');
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    disk.links[0].allowDomains = audience;
    writeFileSync(path, JSON.stringify(disk));
    return new ShareLinks({ dataDir });
  };

  it('lists only the members the audience still admits, and will not re-role the rest', () => {
    const link = mint([ALICE, BOB]);
    links.redeem(link.linkId, ALICE);
    links.redeem(link.linkId, BOB);
    const reloaded = narrowOnDisk([BOB]);
    expect(reloaded.membersOf('w-board').map((m) => m.email)).toEqual([BOB]);
    expect(reloaded.allMembers().map((m) => m.email)).toEqual([BOB]);
    expect(reloaded.setMemberRole('w-board', ALICE, 'owner')).toBe(false);
    expect(reloaded.setMemberRole('w-board', BOB, 'owner')).toBe(true);
  });

  it('gives a refused member the role of the second link they redeem', () => {
    const link = mint([ALICE]);
    links.redeem(link.linkId, ALICE);
    const reloaded = narrowOnDisk([BOB]);
    const owners = reloaded.create({
      workspaceId: 'w-board',
      createdBy: 'Test Agent',
      role: 'owner',
    });
    expect(reloaded.redeem(owners.linkId, ALICE)).toMatchObject({ ok: true, added: true });
    expect(reloaded.roleOf('w-board', ALICE)).toBe('owner');
    expect(reloaded.membersOf('w-board')).toHaveLength(1);
  });

  it('leaves a link with no audience exactly as it was', () => {
    const link = mint();
    expect(link).not.toHaveProperty('allowDomains');
    expect(links.redeem(link.linkId, RIVERBEND).ok).toBe(true);
    expect(new ShareLinks({ dataDir }).isMember('w-board', RIVERBEND)).toBe(true);
  });
});
