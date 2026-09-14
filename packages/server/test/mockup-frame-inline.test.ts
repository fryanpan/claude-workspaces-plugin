/**
 * A served mock's frame fetches nothing from the board by itself: the server
 * writes the bridge and every board script and stylesheet the mock names into
 * the frame's bytes (`injectFrameScripts`). Pure, so driven directly over
 * sample pages and a throwaway build; `mockup-frame.test.ts` covers the route
 * that calls it, and `widget/test/mock-access.test.ts` a real browser behind
 * a sign-in gate.
 *
 * Fixtures are fictional — a lemonade stand's price board.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectFrameScripts } from '../src/mockup-frame.ts';

describe('what the server writes into a mock frame', () => {
  it('inlines the bridge first, and the widget and live scripts in place of their tags', () => {
    const dist = mkdtempSync(join(tmpdir(), 'mock-frame-dist-'));
    writeFileSync(join(dist, 'mock-bridge.js'), 'window.bridge=1;');
    writeFileSync(join(dist, 'widget.iife.js'), 'var s="</script><!--";');
    writeFileSync(join(dist, 'mockup-live.js'), 'window.live=1;');
    const page =
      '<!doctype html><html><head><script>mine()</script></head><body>' +
      '<script src="/widget.iife.js"></script>' +
      '<script src="/widget/mockup-live.js" data-cw-live data-doc-id="d-1" data-versions="[1,2]"></script>' +
      '</body></html>';
    const out = injectFrameScripts(
      page,
      new URL('http://board.test/workspaces/w/mockups/d-1'),
      dist,
      null,
    );
    rmSync(dist, { recursive: true, force: true });
    expect(out.indexOf('window.bridge=1')).toBeLessThan(out.indexOf('mine()'));
    expect(out).not.toContain('src="/widget.iife.js"');
    expect(out).not.toContain('src="/widget/mockup-live.js"');
    expect(out).toContain('<script data-feedback-widget>var s="<\\/script><\\!--";</script>');
    expect(out).toContain(
      '<script data-feedback-widget data-cw-live data-doc-id="d-1" data-versions="[1,2]">window.live=1;</script>',
    );
    // Without a built bundle the page is left exactly as it was.
    expect(injectFrameScripts(page, new URL('http://board.test/'), null, null)).toBe(page);
  });

  it('writes every board script the mock names into the frame, and leaves what it cannot', () => {
    const root = mkdtempSync(join(tmpdir(), 'mock-frame-scripts-'));
    const app = join(root, 'app');
    const widget = join(root, 'widget');
    mkdirSync(app);
    mkdirSync(widget);
    writeFileSync(join(app, 'harbor.js'), 'window.harbor=1;');
    writeFileSync(join(app, 'chunked.js'), 'import("./chunk-7.js");');
    writeFileSync(join(app, 'tokens.css'), ':root{--stand:#fc0}');
    writeFileSync(join(root, 'outside.js'), 'window.leak=1;');
    writeFileSync(join(widget, 'widget.iife.js'), 'window.widget=1;');
    writeFileSync(join(widget, 'voice.js'), 'window.voice=1;');
    const pageUrl = new URL('http://board.test/workspaces/w/mockups/d-1?cw-frame=1');
    const page = [
      '<script type="module" src="/app/harbor.js" data-stand=\'1\'></script>',
      '<script src=/app/harbor.js></script>',
      '<script src="http://board.test/widget.iife.js" defer></script>',
      '<script src="/widget/voice.js"></script>',
      '<script src="https://cdn.saltmarsh.test/app/harbor.js"></script>',
      '<script src="/app/chunked.js"></script>',
      '<script src="/app/%2e%2e/outside.js"></script>',
      '<script src="/widget/%2F..%2Foutside.js"></script>',
      '<script src="/app/missing.js"></script>',
      '<script data-src="/app/harbor.js"></script>',
      '<script>var t=\'<link rel="stylesheet" href="/app/tokens.css">\';</script>',
    ].join('');
    const out = injectFrameScripts(page, pageUrl, widget, app);
    rmSync(root, { recursive: true, force: true });
    expect(out).toBe(
      [
        '<script type="module" data-stand=\'1\'>window.harbor=1;</script>',
        '<script>window.harbor=1;</script>',
        '<script data-feedback-widget defer>window.widget=1;</script>',
        '<script data-feedback-widget>window.voice=1;</script>',
        '<script src="https://cdn.saltmarsh.test/app/harbor.js"></script>',
        '<script src="/app/chunked.js"></script>',
        '<script src="/app/%2e%2e/outside.js"></script>',
        '<script src="/widget/%2F..%2Foutside.js"></script>',
        '<script src="/app/missing.js"></script>',
        '<script data-src="/app/harbor.js"></script>',
        '<script>var t=\'<link rel="stylesheet" href="/app/tokens.css">\';</script>',
      ].join(''),
    );
  });

  it("writes the board's own stylesheets into the frame, which could not fetch them, and nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), 'mock-frame-app-'));
    const dist = join(root, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'tokens-3f2a.css'), ':root{--stand:#fc0}');
    writeFileSync(join(dist, 'board.css'), '.menu{content:"</style>"}');
    writeFileSync(join(root, 'outside.css'), '.leak{}');
    const pageUrl = new URL('http://board.test/workspaces/w/mockups/d-1?cw-frame=1');
    const page = [
      '<link rel="stylesheet" href="/app/tokens-3f2a.css">',
      "<link href='http://board.test/app/board.css' media=\"print\" rel='preload stylesheet'>",
      '<link rel="stylesheet" href="https://fonts.riverbend.test/app/board.css">',
      '<link rel="icon" href="/app/board.css">',
      '<link rel="stylesheet" href="/app/%2e%2e/outside.css">',
      '<link rel="stylesheet" href="/app/%2F..%2Foutside.css">',
      '<link rel="stylesheet" href="/app/missing.css">',
      '<link rel="stylesheet" href="/demo/board.css">',
    ].join('');
    const out = injectFrameScripts(page, pageUrl, null, dist);
    const withoutDist = injectFrameScripts(page, pageUrl, null, null);
    rmSync(root, { recursive: true, force: true });
    expect(out).toBe(
      [
        '<style data-cw-inlined="/app/tokens-3f2a.css">:root{--stand:#fc0}</style>',
        '<style data-cw-inlined="/app/board.css" media="print">.menu{content:"<\\/style>"}</style>',
        '<link rel="stylesheet" href="https://fonts.riverbend.test/app/board.css">',
        '<link rel="icon" href="/app/board.css">',
        '<link rel="stylesheet" href="/app/%2e%2e/outside.css">',
        '<link rel="stylesheet" href="/app/%2F..%2Foutside.css">',
        '<link rel="stylesheet" href="/app/missing.css">',
        '<link rel="stylesheet" href="/demo/board.css">',
      ].join(''),
    );
    expect(out).not.toContain('.leak');
    expect(withoutDist).toBe(page);
  });
});
