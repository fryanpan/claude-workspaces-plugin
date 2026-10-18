/**
 * A folder of recordings and screenshots, attached the way a peer lead
 * attached one: two mp4s and two pngs, inside a repository that ignores
 * `*.mp4`. Before this suite the bind answered `fileCount: 2, skipped: []`,
 * and the reader could open neither recording nor the screenshot.
 *
 * The screenshot's name is the one macOS writes, with U+202F NARROW NO-BREAK
 * SPACE before "PM". `git ls-files` C-quotes any path with a byte above 0x7f
 * unless it is asked for NUL-separated output, so the scan used to record
 * `"Screenshot … 3.04.12\342\200\257PM.png"` — quotes and octal escapes
 * included — which names no file. It was counted, and it could not be opened.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { scanFolderPaths } from '../src/fs-scan.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { tinyMp4 } from './tiny-mp4.ts';
import { tinyPng } from './tiny-png.ts';

const SCREENSHOT = 'Screenshot 2026-10-16 at 3.04.12 PM.png';

function makeDocStore(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

describe('attaching a folder of recordings and screenshots', () => {
  let dataDir: string;
  let repo: string;
  let docStore: DocStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'drop-data-'));
    repo = mkdtempSync(join(tmpdir(), 'drop-src-'));
    execFileSync('git', ['-C', repo, 'init', '-q']);
    writeFileSync(join(repo, '.gitignore'), '*.mp4\n');
    writeFileSync(join(repo, 'harborlight-walkthrough.mp4'), tinyMp4(4096, 1));
    writeFileSync(join(repo, 'riverbend-walkthrough.mp4'), tinyMp4(4096, 2));
    writeFileSync(join(repo, 'chart.png'), tinyPng(40));
    writeFileSync(join(repo, SCREENSHOT), tinyPng(90));
    docStore = makeDocStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('lists a file whose name carries a non-ASCII character under its real name', () => {
    const listed = scanFolderPaths(repo);
    expect(listed).toContain(SCREENSHOT);
    expect(listed.some((p) => p.startsWith('"'))).toBe(false);
  });

  it('opens the screenshot from the folder it was attached in', async () => {
    const res = await docStore.bindFolder({ folderPath: repo });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Positive control: the plain-named png opens on the same set.
    expect((await docStore.openContextFile(res.setId, 'chart.png')).ok).toBe(true);
    expect((await docStore.openContextFile(res.setId, SCREENSHOT)).ok).toBe(true);
  });

  it('names every file it leaves out, with the reason', async () => {
    const res = await docStore.bindFolder({ folderPath: repo });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { path: 'harborlight-walkthrough.mp4', reason: 'gitignored' },
        { path: 'riverbend-walkthrough.mp4', reason: 'gitignored' },
      ]),
    );
    // `.gitignore` itself is listed; the two pngs are listed; nothing else.
    expect(res.fileCount).toBe(3);
  });
});
