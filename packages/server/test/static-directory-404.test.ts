/**
 * A static path that names a DIRECTORY answers 404, not 500.
 *
 * `serveStatic` checked only that the path existed and then read it, so a
 * GET on `/widget/` — the widget root itself — tried to read a directory as a
 * file. The read threw EISDIR, the request answered Bun's bare 500, and the
 * throw reached Sentry as a server error. Nothing was wrong with the server;
 * somebody asked for a folder.
 *
 * Every static root is driven here through the running server, because each
 * builds its path differently: `/widget/` joins the remainder, `/demos/`
 * appends `index.html` only when the last segment has no extension, and the
 * fixed widget aliases name a file that could itself be a directory. The
 * Sentry half points a real DSN at a local capture server, and a marker
 * error sent after the requests is the positive control — without it, "no
 * EISDIR arrived" could mean nothing arrived at all.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureServerError,
  flushServerSentry,
  initServerSentry,
  resetServerSentryForTest,
} from '../src/sentry.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { startCaptureServer } from './sentry-capture-server.ts';

describe('a static directory path answers 404 and reports nothing', () => {
  let handle: ServerHandle;
  let capture: ReturnType<typeof startCaptureServer>;
  const dirs: string[] = [];
  let base: string;

  const tempDir = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  beforeAll(async () => {
    capture = startCaptureServer();
    await initServerSentry({ dsn: capture.dsn, release: 'static-dir-test', environment: 'test' });

    const dataDir = tempDir('static-dir-data-');
    const widgetDist = tempDir('static-dir-widget-');
    const appDist = tempDir('static-dir-app-');
    const demosDir = tempDir('static-dir-demos-');
    writeFileSync(join(widgetDist, 'widget.iife.js'), 'console.log("widget")');
    mkdirSync(join(widgetDist, 'chunks'));
    // A directory wearing a file's name: the fixed alias joins it verbatim.
    mkdirSync(join(widgetDist, 'widget.esm.js'));
    writeFileSync(join(appDist, 'board.js'), 'export {}');
    mkdirSync(join(appDist, 'icons'));
    // An extension on the last segment means `/demos/` does NOT append
    // index.html, so the directory itself reaches the read.
    mkdirSync(join(demosDir, 'release-1.2'));

    handle = createServer({
      port: 0,
      dataDir,
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      demosDir,
    });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    handle.stop();
    await flushServerSentry(2000);
    resetServerSentryForTest();
    capture.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('serves the files beside those directories', async () => {
    // Positive control: the roots are wired, so a 404 below is about the
    // directory and not about a root the server never mounted.
    expect((await get('/widget/widget.iife.js')).status).toBe(200);
    expect((await get('/app/board.js')).status).toBe(200);
  });

  it('answers 404 for every static root asked for a directory, and sends Sentry no EISDIR', async () => {
    const statuses: Record<string, number> = {};
    for (const path of [
      '/widget/',
      '/widget/chunks',
      '/widget/chunks/',
      '/widget.esm.js',
      '/app/icons',
      '/app/icons/',
      '/demos/release-1.2',
    ]) {
      statuses[path] = (await get(path)).status;
    }
    expect(statuses).toEqual({
      '/widget/': 404,
      '/widget/chunks': 404,
      '/widget/chunks/': 404,
      '/widget.esm.js': 404,
      '/app/icons': 404,
      '/app/icons/': 404,
      '/demos/release-1.2': 404,
    });

    // Sent AFTER the requests, so its arrival proves the capture path was
    // live for them. Plain words: the privacy scrub redacts anything shaped
    // like an id, so a random suffix would never arrive intact.
    const marker = 'static directory capture probe';
    captureServerError(new Error(marker));
    await flushServerSentry(5000);
    // Read the captured exceptions' messages rather than grepping the raw
    // envelope: Sentry attaches source lines around each stack frame, and
    // this file's own text says EISDIR.
    const captured = capture
      .hits()
      .flatMap((h) => h.text.split('\n'))
      .flatMap((line) => {
        try {
          const item = JSON.parse(line) as { exception?: { values?: { value?: string }[] } };
          return (item.exception?.values ?? []).map((v) => v.value ?? '');
        } catch {
          return [];
        }
      });
    expect(captured).toEqual([marker]);
  });
});
