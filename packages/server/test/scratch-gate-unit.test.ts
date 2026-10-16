/**
 * Which paths are scratch, and which doc on a board the gate names.
 * The routes that read these are driven in scratch-share-gate.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { hasScratchSegment, scratchDocOn, scratchInFolder } from '../src/share/scratch-gate.ts';

describe('hasScratchSegment', () => {
  it.each([
    ['/repo/scratch/plan.md', true],
    ['scratch/plan.md', true],
    ['C:\\repo\\scratch\\plan.md', true],
    ['/repo/Scratch/plan.md', true],
    ['/repo/a/scratch/b/plan.md', true],
    ['/repo/scratchpad/plan.md', false],
    ['/repo/my-scratch/plan.md', false],
    ['/repo/docs/scratch', false],
    ['/repo/docs/plan.md', false],
    ['', false],
  ])('%s is %p', (path, want) => {
    expect(hasScratchSegment(path)).toBe(want);
  });

  it('counts the last segment of a folder path', () => {
    expect(hasScratchSegment('/repo/scratch', { dir: true })).toBe(true);
    expect(hasScratchSegment('/repo/scratch/', { dir: true })).toBe(true);
    expect(hasScratchSegment('/repo/docs', { dir: true })).toBe(false);
  });
});

describe('scratchDocOn', () => {
  const docs = [
    { docId: 'plain', sourceUrl: '/repo/docs/a.md' },
    { docId: 'set-1:scratch/b.md', relPath: 'scratch/b.md', setId: 'set-1', title: 'b.md' },
    { docId: 'elsewhere', sourceUrl: '/repo/scratch/c.md' },
  ];

  it('finds a scratch member of a set the board holds', () => {
    expect(scratchDocOn(['plain', 'set-1'], docs)).toEqual({
      docId: 'set-1:scratch/b.md',
      title: 'b.md',
      path: 'scratch/b.md',
    });
  });

  it('ignores a scratch doc on another board', () => {
    expect(scratchDocOn(['plain'], docs)).toBeNull();
  });
});

describe('scratchDocOn with a folder scan', () => {
  const folder = [{ docId: 'set-2:README.md', setId: 'set-2', workspaceRoot: '/repo' }];

  it('finds a scratch file in a held set that no doc meta names yet', () => {
    const scan = () => ['README.md', 'scratch/notes.md'];
    expect(scratchDocOn(['set-2'], folder, scan)).toEqual({
      docId: 'set-2',
      path: 'scratch/notes.md',
    });
  });

  it('passes a held set whose folder has no scratch file', () => {
    expect(scratchDocOn(['set-2'], folder, () => ['README.md', 'scratchpad/a.md'])).toBeNull();
  });

  it('does not scan a set the board does not hold', () => {
    let scanned = false;
    const scan = () => {
      scanned = true;
      return ['scratch/notes.md'];
    };
    expect(scratchDocOn(['other'], folder, scan)).toBeNull();
    expect(scanned).toBe(false);
  });
});

describe('scratchInFolder', () => {
  it('names the folder itself when it sits in a scratch tree', () => {
    expect(scratchInFolder('/repo/scratch', () => [])).toBe('/repo/scratch');
  });

  it('names the first scratch file below the folder', () => {
    expect(scratchInFolder('/repo', () => ['a.md', 'x/scratch/b.md'])).toBe('x/scratch/b.md');
  });

  it('passes a folder with none', () => {
    expect(scratchInFolder('/repo', () => ['a.md'])).toBeNull();
  });
});
