/**
 * The mount brief's wording, over hand-made inputs.
 *
 * The route's own test (`attach-mounts-route.test.ts`) proves the brief
 * reaches an attaching session. What only this level can drive is the case a
 * route test cannot stage cheaply: a `local-only` project answering a caller
 * off the box, where the folder NAMES have to stop at the edge with the bytes
 * while the count still goes out.
 */
import { describe, expect, it } from 'bun:test';
import { attachMountsBrief } from '../src/attach-mounts.ts';

describe('attachMountsBrief', () => {
  it('names the verb and the caveat when nothing is mounted', () => {
    const brief = attachMountsBrief({
      repoKey: 'git:example/x',
      folders: [],
      mayNameFolders: true,
    });
    expect(brief.count).toBe(0);
    expect(brief.folders).toBeUndefined();
    expect(brief.note).toContain('mount_folder');
    expect(brief.note).toContain('.gitignore is not a privacy control');
  });

  it('answers for a board with no project at all', () => {
    const brief = attachMountsBrief({ repoKey: null, folders: [], mayNameFolders: true });
    expect(brief.project).toBeNull();
    expect(brief.note).toContain('mount_folder');
  });

  it('names the folders, and spells the repo root as a dot', () => {
    const brief = attachMountsBrief({
      repoKey: 'git:example/harborlight',
      folders: ['docs/mocks', ''],
      mayNameFolders: true,
    });
    expect(brief.count).toBe(2);
    expect(brief.folders).toEqual(['docs/mocks', '.']);
    expect(brief.note).toContain('docs/mocks');
  });

  it('withholds the names of a local-only project off the box, but not the count', () => {
    const brief = attachMountsBrief({
      repoKey: 'git:example/harborlight',
      folders: ['clients/riverbend'],
      mayNameFolders: false,
    });
    expect(brief.count).toBe(1);
    // Absent, not empty: an empty list is the claim "no folders", which is a
    // different thing from "not telling you which".
    expect(brief.folders).toBeUndefined();
    expect(brief.note).not.toContain('riverbend');
  });
});
