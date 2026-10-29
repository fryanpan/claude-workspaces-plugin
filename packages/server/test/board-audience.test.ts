/**
 * A board's audience on its own: who it admits, what an exception does, and
 * the migration that seeds it from the people already in.
 *
 * The store that persists it is `share-links-store.test.ts`; the HTTP half is
 * `share-board-audience.test.ts`. These are the decisions `board-audience.ts`
 * makes alone.
 */
import { describe, expect, it } from 'bun:test';
import {
  type BoardAudience,
  addAudienceEntries,
  boardAudienceAdmits,
  entriesWidenAudience,
  removeFromAudience,
  seedAudiences,
} from '../src/share/board-audience.ts';

const WS = 'w-riverbend';
const ALICE = 'alice@harborlight.example';
const BOB = 'bob@harborlight.example';

const audience = (entries: BoardAudience['entries']): BoardAudience => ({
  workspaceId: WS,
  entries,
});

describe('a board audience', () => {
  it('admits an exact address and every address at an @domain, nobody else', () => {
    const a = audience([
      { match: ALICE, addedAt: 1 },
      { match: '@saltmarsh.example', addedAt: 1 },
    ]);
    expect(boardAudienceAdmits(a, ALICE)).toBe(true);
    expect(boardAudienceAdmits(a, 'ALICE@Harborlight.example')).toBe(true);
    expect(boardAudienceAdmits(a, 'ops@saltmarsh.example')).toBe(true);
    expect(boardAudienceAdmits(a, BOB)).toBe(false);
    expect(boardAudienceAdmits(a, 'ops@sub.saltmarsh.example')).toBe(false);
  });

  it('admits nobody when there is no audience at all', () => {
    expect(boardAudienceAdmits(undefined, ALICE)).toBe(false);
    expect(boardAudienceAdmits(audience([]), ALICE)).toBe(false);
  });

  it('keeps out someone a domain admitted once they are removed, and their own entry beats it', () => {
    const a = audience([{ match: '@harborlight.example', addedAt: 1 }]);
    const removed = removeFromAudience(a, ALICE);
    expect(boardAudienceAdmits(removed, ALICE)).toBe(false);
    expect(boardAudienceAdmits(removed, BOB)).toBe(true);
    const back = addAudienceEntries(removed, [ALICE], 'Bryan', 3);
    expect(boardAudienceAdmits(back, ALICE)).toBe(true);
  });

  it('drops an exact entry when that person is removed', () => {
    const a = audience([
      { match: ALICE, addedAt: 1 },
      { match: BOB, addedAt: 1 },
    ]);
    const removed = removeFromAudience(a, ALICE);
    expect(removed.entries.map((e) => e.match)).toEqual([BOB]);
  });

  it('removes a whole @domain entry when the entry itself is named', () => {
    const a = audience([{ match: '@harborlight.example', addedAt: 1 }]);
    expect(removeFromAudience(a, '@harborlight.example').entries).toEqual([]);
  });

  it('does not add an entry twice', () => {
    const a = addAudienceEntries(audience([{ match: ALICE, addedAt: 1 }]), [ALICE], 'Bryan', 2);
    expect(a.entries).toHaveLength(1);
  });

  it('names the entries a request would add that the audience does not already admit', () => {
    const a = audience([{ match: '@harborlight.example', addedAt: 1 }]);
    expect(entriesWidenAudience(a, [ALICE])).toEqual([]);
    expect(entriesWidenAudience(a, ['@harborlight.example'])).toEqual([]);
    expect(entriesWidenAudience(a, ['carol@riverbend.example', ALICE])).toEqual([
      'carol@riverbend.example',
    ]);
    expect(entriesWidenAudience(undefined, ['@saltmarsh.example'])).toEqual(['@saltmarsh.example']);
  });
});

describe('seeding audiences from the people already in', () => {
  it("keeps every current member, by exact address, and the domains a live link's audience named", () => {
    const seeded = seedAudiences(
      [
        { workspaceId: WS, email: ALICE, addedAt: 5, viaLinkId: 'l1' },
        { workspaceId: WS, email: BOB, addedAt: 6, viaLinkId: 'l1' },
        { workspaceId: 'w-saltmarsh', email: 'ops@saltmarsh.example', addedAt: 7, viaLinkId: 'l2' },
      ],
      [
        { workspaceId: 'w-saltmarsh', live: true, allowDomains: ['@saltmarsh.example'] },
        { workspaceId: 'w-saltmarsh', live: false, allowDomains: ['@revoked.example'] },
      ],
      100,
    );
    const riverbend = seeded.find((a) => a.workspaceId === WS);
    expect(riverbend?.entries.map((e) => e.match)).toEqual([ALICE, BOB]);
    expect(riverbend?.entries[0]?.addedAt).toBe(5);
    const saltmarsh = seeded.find((a) => a.workspaceId === 'w-saltmarsh');
    expect(saltmarsh?.entries.map((e) => e.match)).toEqual([
      'ops@saltmarsh.example',
      '@saltmarsh.example',
    ]);
    for (const a of seeded) {
      expect(boardAudienceAdmits(a, ALICE)).toBe(a.workspaceId === WS);
    }
  });
});
