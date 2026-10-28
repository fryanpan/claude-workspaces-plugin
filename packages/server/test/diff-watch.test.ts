/**
 * An open diff review based on the working tree follows it: a tracked
 * file's first edit joins the file list, a save that moves its counts
 * redraws them, a save of the same bytes sends nothing, and opening the
 * review checks a diff that moved while no page held it (`folder-watch.ts`).
 *
 * Each case binds a real temp repo, opens the stream the page holds, and
 * saves with a rename the way an editor does. All fixtures are invented.
 * Port 0, temp data dirs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentIdOf } from '@claude-workspaces/core';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import { MAX_WAIT_MS } from '../src/folder-watch.ts';
import { NUDGE_COALESCE_MS } from '../src/page-nudges.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { framesOf } from './stream-frames.ts';
import { waitFor } from './wait-for.ts';

/** Past one burst's whole journey: settle, the pass, the coalesced frame. */
const PAST_A_BURST = MAX_WAIT_MS + NUDGE_COALESCE_MS * 2 + 300;

describe('diff watch, through the server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let base: string;
  let reviewId = '';
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Harborlight',
        GIT_AUTHOR_EMAIL: 'harborlight@example.invalid',
        GIT_COMMITTER_NAME: 'Harborlight',
        GIT_COMMITTER_EMAIL: 'harborlight@example.invalid',
      },
    }).trim();
  const open = async () => {
    const abort = new AbortController();
    const res = await fetch(`${base}/workspaces/${reviewId}/events:stream`, {
      headers: { host: 'localhost' },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    return framesOf(res, abort);
  };
  const changes = (page: { names: () => string[] }) =>
    page.names().filter((n) => n === 'attachments.changed').length;
  /**
   * Save the way an editor does: a temp file renamed over the old one.
   *
   * The temp file sits BESIDE the repo, not in it. A working-tree diff lists
   * untracked files, and a pass's `git ls-files --others` runs in a child
   * process alongside this one, so a temp inside the repo could be listed in
   * the instant before its rename — one more listing change, and one more
   * frame than the save sent. CI on 22 Oct read 2 where the case expects 1:
   * the first-edit `waitFor` below re-saves every poll while a pass runs.
   */
  const save = (rel: string, text: string) => {
    const tmp = `${repo}-${rel.replaceAll('/', '_')}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, join(repo, rel));
  };
  /** The diff file list's row for a path, as the sidebar reads it. */
  const row = (relPath: string) =>
    handle.docStore
      .list()
      .find((m) => attachmentIdOf(m) === reviewId && m.type === 'diff' && m.relPath === relPath);

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'diff-watch-data-'));
    repo = mkdtempSync(join(tmpdir(), 'diff-watch-repo-'));
    git('init', '-q');
    writeFileSync(join(repo, 'tides.md'), '# Riverbend tides\n');
    writeFileSync(join(repo, 'guide.md'), '# Saltmarsh guide\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    // One change already, so the review has something to list.
    writeFileSync(join(repo, 'tides.md'), '# Riverbend tides\n\nHigh water at noon.\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const bound = await handle.docStore.bindDiff({ repoPath: repo, base: 'HEAD' });
    if (!bound.ok) throw new Error(`bind failed: ${bound.error}`);
    reviewId = bound.reviewId;
    // timed: past the bind's own persist and coalesced frame, so a frame
    // counted below can only come from the disk.
    await new Promise((r) => setTimeout(r, DOC_STORE_TIMINGS.persistMs + NUDGE_COALESCE_MS * 2));
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('a tracked file’s first edit joins the list, a save moves its counts, a no-op save is silent', async () => {
    const page = await open();
    try {
      await waitFor(() => handle.folderWatches.size() === 1);
      expect(row('guide.md')).toBeUndefined();
      // A first edit to a tracked file: the git listing does not move.
      // Saved again until a frame lands: Bun on Linux arms a recursive watch
      // a moment late, and a repeat of the same bytes moves no count.
      await waitFor(() => {
        save('guide.md', '# Saltmarsh guide\n\nOne.\n');
        return changes(page) >= 1;
      });
      // timed: a whole burst window, to prove the edit sent one frame.
      await new Promise((r) => setTimeout(r, PAST_A_BURST));
      expect(changes(page)).toBe(1);
      expect(row('guide.md')?.diffAdditions).toBe(2);

      await waitFor(() => {
        save('guide.md', '# Saltmarsh guide\n\nOne.\nTwo.\n');
        return changes(page) >= 2;
      });
      // timed: a whole burst window, to prove the save sent one frame.
      await new Promise((r) => setTimeout(r, PAST_A_BURST));
      expect(changes(page)).toBe(2);
      expect(row('guide.md')?.diffAdditions).toBe(3);

      // The same bytes again: an event, and nothing for the page.
      save('guide.md', '# Saltmarsh guide\n\nOne.\nTwo.\n');
      // timed: two burst windows, long enough for the pass to have run.
      await new Promise((r) => setTimeout(r, PAST_A_BURST * 2));
      expect(changes(page)).toBe(2);
    } finally {
      page.stop();
    }
    await waitFor(() => handle.folderWatches.size() === 0);
  }, 20_000);

  it('opening the review checks a diff that moved while nobody had it open, once', async () => {
    writeFileSync(join(repo, 'guide.md'), '# Saltmarsh guide\n\nOne.\n');
    // timed: past a burst, so no watch opened below can hear this write.
    await new Promise((r) => setTimeout(r, PAST_A_BURST));
    const page = await open();
    try {
      await waitFor(() => changes(page) >= 1);
      // timed: a whole burst window, to prove the open sent one frame.
      await new Promise((r) => setTimeout(r, PAST_A_BURST));
      expect(changes(page)).toBe(1);
      expect(row('guide.md')?.diffAdditions).toBe(2);
    } finally {
      page.stop();
    }
    // Unmoved since: the next open sends nothing.
    const again = await open();
    try {
      await waitFor(() => handle.folderWatches.size() === 1);
      // timed: a whole burst window, long enough for the opening pass.
      await new Promise((r) => setTimeout(r, PAST_A_BURST));
      expect(changes(again)).toBe(0);
    } finally {
      again.stop();
    }
  }, 20_000);
});
