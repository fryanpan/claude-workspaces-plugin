import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
