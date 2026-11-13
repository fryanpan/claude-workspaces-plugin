/**
 * The Library folder rules, over plain state: what a folder may be called and
 * where, what Meetings refuses, and that archiving takes nothing away.
 *
 * All fixtures synthetic.
 */
import { describe, expect, it } from 'bun:test';
import {
  type FolderState,
  MEETINGS_FOLDER_ID,
  archiveFolder,
  createFolder,
  folderOfDoc,
  liveFolders,
  moveFolder,
  renameFolder,
  setDocFolder,
  unarchiveFolder,
} from '../src/library-folders.ts';

function ids() {
  let n = 0;
  return () => `f-${++n}`;
}

function make(s: FolderState, name: string, parentId: string | null = null, newId = ids()) {
  const res = createFolder(s, { name, parentId }, { now: 1, newId });
  if (!res.ok) throw new Error(res.message);
  return res.folder.id;
}

describe('library folders', () => {
  it('starts with Meetings, which holds meetings nobody filed', () => {
    const s: FolderState = {};
    expect(liveFolders(s).map((f) => f.name)).toEqual(['Meetings']);
    expect(folderOfDoc(s, 'd-sync', true)).toBe(MEETINGS_FOLDER_ID);
    expect(folderOfDoc(s, 'd-plan', false)).toBeNull();
  });

  it('makes folders and subfolders, each with its path', () => {
    const s: FolderState = {};
    const newId = ids();
    const design = make(s, 'Design', null, newId);
    make(s, 'Mocks', design, newId);
    expect(liveFolders(s).map((f) => f.path)).toEqual(['Meetings', 'Design', 'Design/Mocks']);
  });

  it('refuses a duplicate name in the same place, whatever its case, and allows it elsewhere', () => {
    const s: FolderState = {};
    const newId = ids();
    const plans = make(s, 'Plans', null, newId);
    const dup = createFolder(s, { name: ' plans ' }, { now: 1, newId });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error).toBe('duplicate-name');
      expect(dup.message).toContain('the top level');
    }
    // CONTROL: the same name one level down is a different place.
    expect(createFolder(s, { name: 'Plans', parentId: plans }, { now: 1, newId }).ok).toBe(true);
  });

  it('refuses a blank name and a slash', () => {
    const s: FolderState = {};
    for (const name of ['', '   ', 'a/b', 42]) {
      const res = createFolder(s, { name }, { now: 1, newId: ids() });
      expect(res.ok ? 'ok' : res.error).toBe('bad-name');
    }
  });

  it('renames, Meetings included, and refuses a rename onto a sibling', () => {
    const s: FolderState = {};
    const newId = ids();
    const a = make(s, 'Research', null, newId);
    make(s, 'Plans', null, newId);
    expect(renameFolder(s, a, 'Plans').ok).toBe(false);
    expect(renameFolder(s, a, 'Field research').ok).toBe(true);
    expect(renameFolder(s, MEETINGS_FOLDER_ID, 'Calls').ok).toBe(true);
    expect(liveFolders(s)[0]).toMatchObject({
      id: MEETINGS_FOLDER_ID,
      name: 'Calls',
      meetings: true,
    });
  });

  it('moves a folder, never into itself or below itself, and never Meetings', () => {
    const s: FolderState = {};
    const newId = ids();
    const design = make(s, 'Design', null, newId);
    const mocks = make(s, 'Mocks', design, newId);
    const plans = make(s, 'Plans', null, newId);
    expect(moveFolder(s, design, mocks).ok).toBe(false);
    expect(moveFolder(s, design, design).ok).toBe(false);
    expect(moveFolder(s, MEETINGS_FOLDER_ID, plans).ok).toBe(false);
    expect(moveFolder(s, mocks, plans).ok).toBe(true);
    expect(liveFolders(s).find((f) => f.id === mocks)?.path).toBe('Plans/Mocks');
  });

  it('archives reversibly: its docs read as in no folder, then come back', () => {
    const s: FolderState = {};
    const newId = ids();
    const design = make(s, 'Design', null, newId);
    const mocks = make(s, 'Mocks', design, newId);
    setDocFolder(s, 'd-flow', mocks);
    expect(folderOfDoc(s, 'd-flow', false)).toBe(mocks);

    expect(archiveFolder(s, design, 2).ok).toBe(true);
    expect(folderOfDoc(s, 'd-flow', false)).toBeNull();
    expect(liveFolders(s).map((f) => f.name)).toEqual(['Meetings']);
    // Nothing was thrown away: the record and the doc's filing are still there.
    expect(s.libraryFolders?.some((f) => f.id === design)).toBe(true);
    expect(s.docFolders?.['d-flow']).toBe(mocks);

    expect(unarchiveFolder(s, design).ok).toBe(true);
    expect(folderOfDoc(s, 'd-flow', false)).toBe(mocks);
    expect(liveFolders(s).map((f) => f.path)).toEqual(['Meetings', 'Design', 'Design/Mocks']);
  });

  it('never archives Meetings', () => {
    const res = archiveFolder({}, MEETINGS_FOLDER_ID, 1);
    expect(res.ok ? 'ok' : res.error).toBe('built-in');
  });

  it('files a meeting elsewhere or in no folder, and refuses an archived folder', () => {
    const s: FolderState = {};
    const plans = make(s, 'Plans');
    expect(setDocFolder(s, 'd-sync', plans).ok).toBe(true);
    expect(folderOfDoc(s, 'd-sync', true)).toBe(plans);
    setDocFolder(s, 'd-sync', null);
    expect(folderOfDoc(s, 'd-sync', true)).toBeNull();
    archiveFolder(s, plans, 3);
    expect(setDocFolder(s, 'd-sync', plans).ok).toBe(false);
  });

  it('unarchives to the top level when its old parent is gone, and refuses a name now taken', () => {
    const s: FolderState = {};
    const newId = ids();
    const design = make(s, 'Design', null, newId);
    const mocks = make(s, 'Mocks', design, newId);
    archiveFolder(s, mocks, 2);
    archiveFolder(s, design, 3);
    expect(unarchiveFolder(s, mocks).ok).toBe(true);
    expect(liveFolders(s).find((f) => f.id === mocks)?.parentId).toBeNull();

    archiveFolder(s, mocks, 4);
    make(s, 'Mocks', null, newId);
    const res = unarchiveFolder(s, mocks);
    expect(res.ok ? 'ok' : res.error).toBe('duplicate-name');
  });
});
