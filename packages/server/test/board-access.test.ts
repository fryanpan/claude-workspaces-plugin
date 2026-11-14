/**
 * The four-word role and the per-board mode, as the store keeps them
 * (`share/board-access.ts`, `share/share-links.ts`). A row written before
 * the access field reads as edit; a hand-edited level that is not one of
 * the two narrow ones reads as edit too; the mode survives a reload.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessRoleOf, parseAccessRole, seatAndAccess } from '../src/share/board-access.ts';
import { ShareLinks } from '../src/share/share-links.ts';

const ALICE = 'alice@harborlight.example';
let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function storeWithAlice(): { store: ShareLinks; ws: string } {
  dir = mkdtempSync(join(tmpdir(), 'board-access-'));
  const store = new ShareLinks({ dataDir: dir });
  const ws = 'ws-harborlight';
  const link = store.create({ workspaceId: ws, createdBy: 'Saltmarsh' });
  store.addToAudience(ws, [ALICE], 'Saltmarsh');
  expect(store.redeem(link.linkId, ALICE)).toMatchObject({ ok: true });
  return { store, ws };
}

describe('the four roles', () => {
  it('reads member as edit and refuses anything else', () => {
    expect(parseAccessRole('member')).toBe('edit');
    expect(parseAccessRole('comment')).toBe('comment');
    expect(parseAccessRole('Owner')).toBeUndefined();
    expect(accessRoleOf('owner', 'view')).toBe('owner');
    expect(seatAndAccess('view')).toEqual({ seat: 'member', access: 'view' });
  });

  it('a row with no access is edit; set and read back every level', () => {
    const { store, ws } = storeWithAlice();
    expect(store.accessRoleOf(ws, ALICE)).toBe('edit');
    for (const role of ['comment', 'view', 'owner', 'edit'] as const) {
      const { seat, access } = seatAndAccess(role);
      expect(store.setMemberRole(ws, ALICE, seat, access)).toBe(true);
      expect(store.accessRoleOf(ws, ALICE)).toBe(role);
    }
    expect(store.accessRoleOf(ws, 'bob@harborlight.example')).toBeNull();
  });

  it('a hand-edited level that is not comment or view reads as edit', () => {
    const { store, ws } = storeWithAlice();
    store.setMemberRole(ws, ALICE, 'member', 'comment');
    const path = join(dir, 'share-links.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"comment"', '"admin"'));
    expect(new ShareLinks({ dataDir: dir }).accessRoleOf(ws, ALICE)).toBe('edit');
  });
});

describe('the roles mode', () => {
  it('is report-only until set, and survives a reload', () => {
    const { store, ws } = storeWithAlice();
    expect(store.rolesModeOf(ws)).toBe('report-only');
    store.setRolesMode(ws, 'enforce');
    expect(new ShareLinks({ dataDir: dir }).rolesModeOf(ws)).toBe('enforce');
    expect(store.rolesModeOf('ws-riverbend')).toBe('report-only');
    store.setRolesMode(ws, 'report-only');
    expect(new ShareLinks({ dataDir: dir }).rolesModeOf(ws)).toBe('report-only');
  });
});
