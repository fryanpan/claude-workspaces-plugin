import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectWidget } from '../src/mockup-widget.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('injectWidget', () => {
  it('adds the embed before the closing body tag', () => {
    const out = injectWidget(
      '<!doctype html><html><body><h1>Report</h1></body></html>',
      'doc-1',
      'w-1',
    );
    expect(out).toContain('<claude-feedback-widget workspace-id="w-1" doc-id="doc-1">');
    expect(out).toContain('src="/widget.iife.js"');
    expect(out.indexOf('claude-feedback-widget')).toBeLessThan(out.indexOf('</body>'));
  });

  it('never writes a reviewer name into the markup', () => {
    // The widget resolves identity from the browser. A `user=` in the page
    // re-brands whoever opens it — which is the leak this whole path exists
    // to make unnecessary.
    expect(injectWidget('<html><body>x</body></html>', 'doc-1', 'w-1')).not.toContain('user=');
  });

  it('leaves a page that already embeds the widget alone', () => {
    const own =
      '<html><body><claude-feedback-widget doc-id="mine" view="tab=a"></claude-feedback-widget><script src="http://elsewhere/widget.iife.js"></script></body></html>';
    expect(injectWidget(own, 'doc-1', 'w-1')).toBe(own);
    const programmatic =
      '<html><body><script>FeedbackWidget.init({docId: "mine"})</script></body></html>';
    expect(injectWidget(programmatic, 'doc-1', 'w-1')).toBe(programmatic);
  });

  /** How many widget elements the page will mount. */
  const embeds = (html: string): number => html.split('<claude-feedback-widget ').length - 1;

  it('adds the widget to a mock that only MENTIONS it — a copied stylesheet, a comment, prose', () => {
    // The board's own chrome carries this selector, so a mock that inlines
    // board.css used to be served without a widget and could not be commented on.
    const copiedChrome =
      '<html><head><style>body:has(claude-feedback-widget) .dock { bottom: 64px; }</style></head><body><h1>Board</h1></body></html>';
    const commented =
      '<html><body><!-- the claude-feedback-widget is added by the server --><h1>Mock</h1></body></html>';
    const prose = '<html><body><p>Comments go through claude-feedback-widget.</p></body></html>';
    // An attribute on an unrelated script names the widget and mounts nothing.
    const scriptAttr =
      '<html><body><script data-component="claude-feedback-widget">window.x = 1;</script></body></html>';
    const lazySrc = '<html><body><script data-src="/widget.iife.js"></script></body></html>';
    for (const page of [copiedChrome, commented, prose, scriptAttr, lazySrc]) {
      expect(embeds(injectWidget(page, 'doc-1', 'w-1'))).toBe(1);
    }
  });

  it('does not add a second widget to a mock that embeds its own after a style block', () => {
    const style = '<style>body:has(claude-feedback-widget) .dock { bottom: 64px; }</style>';
    const byElement = `<html><head>${style}</head><body><claude-feedback-widget workspace-id="w-9" doc-id="mine"></claude-feedback-widget></body></html>`;
    const byScriptTag = `<html><head>${style}</head><body><script src="http://example.test/widget.iife.js" data-doc-id="mine"></script></body></html>`;
    const byInit = `<html><head>${style}</head><body><script>FeedbackWidget.init({ docId: "mine" })</script></body></html>`;
    const byCreate = `<html><body>${style}<script>document.body.append(document.createElement("claude-feedback-widget"))</script></body></html>`;
    for (const page of [byElement, byScriptTag, byInit, byCreate]) {
      expect(injectWidget(page, 'doc-1', 'w-1')).toBe(page);
    }
  });

  it('adds the widget to a mock whose only mention is in a script block the browser never runs', () => {
    // Measured on a served mock: board.css carried as JSON named the widget,
    // and the page went out with none.
    const json =
      '<html><head><script type="application/json" id="chrome">{"css":"body:has(claude-feedback-widget) .dock{bottom:64px}"}</script></head><body><h1>Riverbend</h1></body></html>';
    const template =
      '<html><body><script type="text/x-template" id="launcher"><div>FeedbackWidget.init({ docId: "t" })</div></script><h1>Harborlight</h1></body></html>';
    // A data block's `src` is never fetched, and the type is read without case or parameters.
    const importMap =
      '<html><head><script type="importmap">{"imports":{"widget":"/widget.iife.js"}}</script></head><body></body></html>';
    const dataSrc =
      '<html><body><script type="Application/JSON; charset=utf-8" src="/widget.iife.js"></script></body></html>';
    for (const page of [json, template, importMap, dataSrc]) {
      expect(embeds(injectWidget(page, 'doc-1', 'w-1'))).toBe(1);
    }
  });

  it('still leaves alone a page that mounts the widget from a script the browser runs', () => {
    const init = 'FeedbackWidget.init({ docId: "mine" })';
    const pages = [
      `<script type="">${init}</script>`,
      `<script type="text/javascript">${init}</script>`,
      `<script type='TEXT/JavaScript; charset=utf-8'>${init}</script>`,
      `<script type="application/ecmascript">${init}</script>`,
      `<script type=module>${init}</script>`,
      '<script type="module" src="/widget.iife.js"></script>',
      // The browser decodes the reference and runs it; undecoded, it must not read as data.
      `<script type="text&#x2f;javascript">${init}</script>`,
      // A data-* attribute that looks like a type does not make the script data.
      `<script data-type="application/json">${init}</script>`,
      // A data block beside a real embed does not hide the real one.
      `<script type="application/json">{"w":"claude-feedback-widget"}</script><script>${init}</script>`,
    ].map((scripts) => `<html><body>${scripts}</body></html>`);
    for (const page of pages) {
      expect(injectWidget(page, 'doc-1', 'w-1')).toBe(page);
    }
  });

  it('is not fooled by a comment opener inside a script into hiding the embed after it', () => {
    // Stripping comments before scripts would read `<!--` … `-->` as one
    // comment spanning the real embed, and bolt a second widget on.
    const page =
      '<html><body><script>const open = "<!--";</script><claude-feedback-widget workspace-id="w-9" doc-id="mine"></claude-feedback-widget><!-- end --></body></html>';
    expect(injectWidget(page, 'doc-1', 'w-1')).toBe(page);
  });

  it('appends when the page has no closing body tag', () => {
    const out = injectWidget('<h1>fragment</h1>', 'doc-1', 'w-1');
    expect(out.startsWith('<h1>fragment</h1>')).toBe(true);
    expect(out).toContain('claude-feedback-widget');
  });

  it('escapes the docId into the attribute', () => {
    const out = injectWidget('<body></body>', 'a"><script>bad()</script>', 'w-1');
    expect(out).not.toContain('"><script>bad()');
    expect(out).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('inserts at the LAST closing body tag, not one quoted earlier in the page', () => {
    const out = injectWidget(
      '<html><body><pre>&lt;/body&gt;</pre><code></body></code></body></html>',
      'doc-1',
      'w-1',
    );
    expect(out.indexOf('claude-feedback-widget')).toBeGreaterThan(out.indexOf('<code>'));
  });
});

describe('a bound mockup is served with the widget already in it', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-mockwidget-test-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves a widget-free source file with the embed attached', async () => {
    const file = join(dataDir, 'report.html');
    // Exactly what a generator writes: no review scaffolding anywhere in it.
    const source = '<!doctype html><html><body><h1>Benchmark Run</h1></body></html>';
    writeFileSync(file, source);
    expect(source).not.toContain('claude-feedback-widget');

    const res = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'mock-widget-1', type: 'mockup', sourceUrl: file }),
    });
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);

    const served = await fetch(`${base}/workspaces/${WS}/mockups/mock-widget-1`);
    expect(served.status).toBe(200);
    const html = await served.text();
    expect(html).toContain('Benchmark Run');
    expect(html).toContain('claude-feedback-widget');
    expect(html).toContain('/widget.iife.js');
    // The board the READER opened, written into the embed. Without it the
    // widget refuses to run, so a served mockup that forgot it is a page with
    // a red box where the launcher should be.
    expect(html).toContain(`workspace-id="${WS}"`);
    // …and the file on disk is untouched — the reason this is worth doing.
    expect(Bun.file(file).text()).resolves.toBe(source);
  });
});
