/**
 * The walk, the refusal list and the move fingerprint, driven over a real
 * directory tree.
 *
 * The refusal cases are the ones that matter: this listing is what decides
 * which files a mount can serve at all, so a name that gets past it is a name
 * somebody off the box can read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isServableRelPath, matchMoves, sampleHash, scanMount } from '../src/mount-scan.ts';

describe('scanMount', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-mount-scan-'));
    mkdirSync(join(root, 'shots'));
    mkdirSync(join(root, 'keys'));
    mkdirSync(join(root, '.secrets'));
    writeFileSync(join(root, 'notes.md'), '# Notes\n');
    writeFileSync(join(root, 'shots', 'home.png'), 'png-bytes');
    // Every shape the refusal list names. Fictional content only.
    writeFileSync(join(root, '.env'), 'SAMPLE_TOKEN=not-a-real-value\n');
    writeFileSync(join(root, '.env.production'), 'SAMPLE_TOKEN=not-a-real-value\n');
    writeFileSync(join(root, '.npmrc'), 'registry=https://registry.example.invalid\n');
    writeFileSync(join(root, 'keys', 'server.pem'), 'placeholder\n');
    writeFileSync(join(root, 'keys', 'server.key'), 'placeholder\n');
    writeFileSync(join(root, 'keys', 'id_ed25519'), 'placeholder\n');
    writeFileSync(join(root, '.secrets', 'anything.txt'), 'placeholder\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lists the project files and refuses every credential-shaped name', () => {
    const listed = scanMount(root).files.map((f) => f.relPath);
    expect(listed).toEqual(['notes.md', 'shots/home.png']);
  });

  it('refuses the same names when they are asked for by path', () => {
    for (const refused of [
      '.env',
      '.env.production',
      '.npmrc',
      'keys/server.pem',
      'keys/server.key',
      'keys/id_ed25519',
      '.secrets/anything.txt',
      '../outside.md',
      'a/../../outside.md',
      '',
    ]) {
      expect(isServableRelPath(refused)).toBe(false);
    }
    expect(isServableRelPath('shots/home.png')).toBe(true);
    expect(isServableRelPath('notes.md')).toBe(true);
  });

  it('skips node_modules and .git rather than walking them', () => {
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '[core]\n');
    expect(scanMount(root).files.map((f) => f.relPath)).toEqual(['notes.md', 'shots/home.png']);
  });

  it('reports the size and mtime a reconcile compares against', () => {
    const found = scanMount(root).files.find((f) => f.relPath === 'notes.md');
    expect(found?.size).toBe('# Notes\n'.length);
    expect(found?.mtimeMs).toBeGreaterThan(0);
  });
});

describe('sampleHash', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-mount-hash-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('agrees for identical bytes and differs when one byte does', () => {
    writeFileSync(join(root, 'a'), 'hello world');
    writeFileSync(join(root, 'b'), 'hello world');
    writeFileSync(join(root, 'c'), 'hello worlD');
    const a = sampleHash(join(root, 'a'), 11);
    expect(a).toBe(sampleHash(join(root, 'b'), 11));
    expect(a).not.toBe(sampleHash(join(root, 'c'), 11));
  });

  it('separates two files of different lengths that share a prefix', () => {
    writeFileSync(join(root, 'a'), 'hello');
    writeFileSync(join(root, 'b'), 'hello!');
    expect(sampleHash(join(root, 'a'), 5)).not.toBe(sampleHash(join(root, 'b'), 6));
  });

  it('answers null for a file it cannot read, so nothing matches it', () => {
    expect(sampleHash(join(root, 'absent'), 10)).toBeNull();
  });
});

describe('matchMoves', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-mount-moves-'));
    writeFileSync(join(root, 'moved.png'), 'the same bytes');
    writeFileSync(join(root, 'other.png'), 'quite different');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const fresh = () => [
    { key: 'k:moved.png', abs: join(root, 'moved.png'), size: 'the same bytes'.length },
    { key: 'k:other.png', abs: join(root, 'other.png'), size: 'quite different'.length },
  ];

  it('pairs a vanished key with the file holding its bytes', () => {
    const hash = sampleHash(join(root, 'moved.png'), 'the same bytes'.length) as string;
    const moves = matchMoves([{ key: 'k:old.png', size: 'the same bytes'.length, hash }], fresh());
    expect(moves).toHaveLength(1);
    expect(moves[0]?.goneKey).toBe('k:old.png');
    expect(moves[0]?.freshKey).toBe('k:moved.png');
  });

  it('matches nothing when the bytes differ, even at the same size', () => {
    writeFileSync(join(root, 'moved.png'), 'THE SAME BYTES');
    const moves = matchMoves(
      [{ key: 'k:old.png', size: 'the same bytes'.length, hash: 'a-hash-of-something-else' }],
      fresh(),
    );
    expect(moves).toEqual([]);
  });

  it('cannot match a gone file whose fingerprint was never recorded', () => {
    expect(matchMoves([{ key: 'k:old.png', size: 'the same bytes'.length }], fresh())).toEqual([]);
  });

  it('gives one fresh file to at most one gone key', () => {
    const hash = sampleHash(join(root, 'moved.png'), 'the same bytes'.length) as string;
    const moves = matchMoves(
      [
        { key: 'k:old-a.png', size: 'the same bytes'.length, hash },
        { key: 'k:old-b.png', size: 'the same bytes'.length, hash },
      ],
      fresh(),
    );
    expect(moves).toHaveLength(1);
  });
});
