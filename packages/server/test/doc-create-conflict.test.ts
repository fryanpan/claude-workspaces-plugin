import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConflictWith } from '../src/doc-create-conflict.ts';

const dir = mkdtempSync(join(tmpdir(), 'doc-create-conflict-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('createConflictWith', () => {
  const file = join(dir, 'Riverbend.md');
  const other = join(dir, 'Harborlight.md');
  writeFileSync(file, '# Riverbend\n');
  writeFileSync(other, '# Harborlight\n');
  const link = join(dir, 'link.md');
  symlinkSync(file, link);

  it('lets a create re-attach the file the doc already has, by any spelling', () => {
    const existing = { type: 'markdown', sourceUrl: file };
    expect(createConflictWith(existing, { type: 'markdown', sourceUrl: file })).toBeNull();
    expect(createConflictWith(existing, { type: 'markdown', sourceUrl: link })).toBeNull();
    expect(
      createConflictWith(existing, { type: 'markdown', sourceUrl: `${dir}/./Riverbend.md` }),
    ).toBeNull();
  });

  it('lets a re-post that names no file through', () => {
    expect(createConflictWith({ type: 'mockup', sourceUrl: file }, { type: 'mockup' })).toBeNull();
  });

  it('refuses another file and a change of type', () => {
    const existing = { type: 'markdown', sourceUrl: file };
    expect(createConflictWith(existing, { type: 'markdown', sourceUrl: other })).toBe('source');
    expect(createConflictWith(existing, { type: 'mockup', sourceUrl: file })).toBe('type');
    expect(createConflictWith({ type: 'mockup' }, { type: 'mockup', sourceUrl: other })).toBe(
      'source',
    );
  });
});

describe('two clones of one remote', () => {
  // Security review, 22 October 2026, finding 5. Two clones whose origin is
  // the same remote share a repo key, so the same relative path in either is
  // one doc: `resolveLiveCopy` surveys every registered checkout of that key
  // and binds the live copy, which is the designed multi-checkout behaviour.
  // Pinned here so a change to it is a decision, not a side effect.
  const clone = (name: string): string => {
    const root = join(dir, name);
    mkdirSync(join(root, 'docs'), { recursive: true });
    const git = (...args: string[]) => expect(spawnSync('git', args, { cwd: root }).status).toBe(0);
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://github.com/harborlight/riverbend.git');
    writeFileSync(join(root, 'docs', 'plan.md'), `# ${name}\n`);
    writeFileSync(join(root, 'docs', 'other.md'), '# other\n');
    return root;
  };

  it('lets the same relative path in the other clone through, and refuses any other path', () => {
    const a = clone('clone-a');
    const b = clone('clone-b');
    const existing = { type: 'markdown', sourceUrl: join(a, 'docs', 'plan.md') };
    expect(
      createConflictWith(existing, { type: 'markdown', sourceUrl: join(b, 'docs', 'plan.md') }),
    ).toBeNull();
    // POSITIVE CONTROL: another file in the same clone is still a repoint.
    expect(
      createConflictWith(existing, { type: 'markdown', sourceUrl: join(b, 'docs', 'other.md') }),
    ).toBe('source');
  });
});
