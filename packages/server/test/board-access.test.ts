/**
 * The four-word role and the per-board mode, as the store keeps them
 * (`share/board-access.ts`, `share/share-links.ts`). A row written before
 * the access field reads as edit; a hand-edited level that is not one of
 * the two narrow ones reads as edit too; every board enforces unless its
 * owner set it back to report-only, and that opt-out survives a reload.
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
  it('enforces until set to report-only, and survives a reload', () => {
    const { store, ws } = storeWithAlice();
    expect(store.rolesModeOf(ws)).toBe('enforce');
    expect(store.rolesModeOf('ws-riverbend')).toBe('enforce');
    store.setRolesMode(ws, 'report-only');
    expect(new ShareLinks({ dataDir: dir }).rolesModeOf(ws)).toBe('report-only');
    expect(new ShareLinks({ dataDir: dir }).rolesModeOf('ws-riverbend')).toBe('enforce');
    store.setRolesMode(ws, 'enforce');
    expect(new ShareLinks({ dataDir: dir }).rolesModeOf(ws)).toBe('enforce');
  });

  it('stores the opt-out, not an opt-in list', () => {
    const { store, ws } = storeWithAlice();
    const path = join(dir, 'share-links.json');
    store.setRolesMode(ws, 'report-only');
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(saved.rolesReportOnly).toEqual([ws]);
    expect(saved.rolesEnforced).toBeUndefined();
    store.setRolesMode(ws, 'enforce');
    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(after.rolesReportOnly).toBeUndefined();
  });

  it('reads a registry written under the old opt-in list: every board enforces', () => {
    const { ws } = storeWithAlice();
    const path = join(dir, 'share-links.json');
    const legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // The old shape: only the boards listed enforced, and the rest reported.
    legacy.rolesEnforced = ['ws-saltmarsh'];
    writeFileSync(path, JSON.stringify(legacy));
    const reloaded = new ShareLinks({ dataDir: dir });
    expect(reloaded.rolesModeOf('ws-saltmarsh')).toBe('enforce');
    expect(reloaded.rolesModeOf(ws)).toBe('enforce');
    // The next write drops the old field rather than carrying it forward.
    reloaded.setRolesMode(ws, 'report-only');
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(saved.rolesEnforced).toBeUndefined();
    expect(saved.rolesReportOnly).toEqual([ws]);
  });

  it('drops a hand-edited opt-out entry that is not a board id', () => {
    const { ws } = storeWithAlice();
    const path = join(dir, 'share-links.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    raw.rolesReportOnly = [ws, '', 7, null];
    writeFileSync(path, JSON.stringify(raw));
    const reloaded = new ShareLinks({ dataDir: dir });
    expect(reloaded.rolesModeOf(ws)).toBe('report-only');
    expect(reloaded.rolesModeOf('')).toBe('enforce');
  });
});
