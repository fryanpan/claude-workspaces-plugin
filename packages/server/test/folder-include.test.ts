/**
 * A folder of recordings inside a repository whose `.gitignore` says `*.mp4`,
 * attached with and without `include`. The names follow the shape of the peer
 * lead's folder, with house fixture words in place of theirs.
 *
 * Without `include`, the recordings stay out, and `skipped` says they are
 * gitignored. That is the share floor: inside a repo, what a visitor may
 * open is what git lists. With `include`, the named files are listed, open
 * and stream, and every entry that cannot be admitted is in `skipped` with a
 * reason.
 *
 * The png that went missing was never dropped. A browse bind's `files` names
 * only the entry doc, which is the first listed file, so `fileCount: 2`
 * counted both pngs and `files` showed one. The answer now carries `listed`,
 * every file the bind listed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { isListedFile } from '../src/fs-listing.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { tinyMp4 } from './tiny-mp4.ts';
import { tinyPng } from './tiny-png.ts';

const MP4_A = 'video-A-harborlight.mp4';
const MP4_B = 'video-B-riverbend.mp4';
const PNG_A = 'video-A-harborlight-firstframe.png';
const PNG_B = 'video-B-riverbend-lastframe.png';

describe('a folder of gitignored recordings', () => {
  let dataDir: string;
  let repo: string;
  let folder: string;
  let docStore: DocStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'include-data-'));
    repo = mkdtempSync(join(tmpdir(), 'include-src-'));
    execFileSync('git', ['-C', repo, 'init', '-q']);
    writeFileSync(join(repo, '.gitignore'), '*.mp4\n.env\n');
    folder = join(repo, 'recordings');
    mkdirSync(folder);
    writeFileSync(join(folder, MP4_A), tinyMp4(4096, 1));
    writeFileSync(join(folder, MP4_B), tinyMp4(4096, 2));
    writeFileSync(join(folder, PNG_A), tinyPng(40));
    writeFileSync(join(folder, PNG_B), tinyPng(90));
    docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
  });

  afterEach(() => {
    docStore.flush();
    docStore.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('names both pngs, though files holds only the entry doc', async () => {
    const res = await docStore.bindFolder({ folderPath: folder });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fileCount).toBe(2);
    expect(res.files.map((f) => f.relPath)).toEqual([PNG_A]);
    expect(res.listed).toEqual([PNG_A, PNG_B]);
    expect((await docStore.openContextFile(res.setId, PNG_B)).ok).toBe(true);
  });

  it('without include, keeps the recordings out and says they are gitignored', async () => {
    const res = await docStore.bindFolder({ folderPath: folder });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skipped).toEqual([
      { path: MP4_A, reason: 'gitignored' },
      { path: MP4_B, reason: 'gitignored' },
    ]);
    expect(await docStore.openContextFile(res.setId, MP4_A)).toEqual({
      ok: false,
      error: 'not-listed',
    });
    const raw = await docStore.resolveSetFile(res.setId, MP4_A, { media: true });
    expect(raw).toEqual({ ok: false, error: 'not-listed' });
  });

  it('with include, lists, opens and streams the named recordings', async () => {
    const res = await docStore.bindFolder({
      folderPath: folder,
      include: [MP4_A, MP4_B, PNG_A, PNG_B],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fileCount).toBe(4);
    expect(res.listed).toEqual([PNG_A, MP4_A, PNG_B, MP4_B].sort());
    expect(res.skipped).toEqual([]);
    // The share rule reads the stored include back, so a later open (the
    // reader's click, a share visitor's request) is admitted too.
    expect((await docStore.openContextFile(res.setId, MP4_B)).ok).toBe(true);
    const raw = await docStore.resolveSetFile(res.setId, MP4_A, { media: true });
    expect(raw.ok).toBe(true);
    const tree = docStore.listRepoFiles(res.setId);
    expect(tree.files?.map((f) => f.relPath)).toContain(MP4_A);
  });

  it('refuses each include entry it cannot admit, and says why', async () => {
    writeFileSync(join(folder, '.env'), 'MARKER=not-a-credential\n');
    writeFileSync(join(folder, 'pack.zip'), new Uint8Array([0x50, 0x4b, 3, 4]));
    mkdirSync(join(folder, 'clips'));
    mkdirSync(join(folder, '.cache'));
    writeFileSync(join(folder, '.cache', 'old.mp4'), tinyMp4(512, 3));
    writeFileSync(join(repo, 'outside.mp4'), tinyMp4(512, 4));
    symlinkSync(join(repo, 'outside.mp4'), join(folder, 'linked.mp4'));
    const res = await docStore.bindFolder({
      folderPath: folder,
      include: [
        MP4_A,
        '.env',
        '../outside.mp4',
        'missing.mp4',
        'clips',
        '.cache/old.mp4',
        'pack.zip',
        'linked.mp4',
        'forged\nline.mp4',
        'forged\u2028line.mp4',
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.listed).toContain(MP4_A);
    const reasons = Object.fromEntries(res.skipped.map((s) => [s.path, s.reason]));
    expect(reasons).toEqual({
      [MP4_B]: 'gitignored',
      '.env': 'credential-name',
      '../outside.mp4': 'bad-path',
      'missing.mp4': 'not-found',
      clips: 'not-a-regular-file',
      // The directory's own row stays: git ignores everything under it.
      '.cache/': 'gitignored',
      '.cache/old.mp4': 'hidden',
      'pack.zip': 'unsupported-type',
      'linked.mp4': 'not-a-regular-file',
      'forged\nline.mp4': 'bad-path',
      'forged\u2028line.mp4': 'bad-path',
    });
    expect((await docStore.openContextFile(res.setId, '.env')).ok).toBe(false);
    expect((await docStore.openContextFile(res.setId, 'linked.mp4')).ok).toBe(false);
  });

  it('admits an included file only for the set that named it', () => {
    expect(isListedFile(folder, MP4_A, [MP4_A])).toBe(true);
    expect(isListedFile(folder, MP4_A)).toBe(false);
    expect(isListedFile(folder, MP4_B, [MP4_A])).toBe(false);
  });
});
