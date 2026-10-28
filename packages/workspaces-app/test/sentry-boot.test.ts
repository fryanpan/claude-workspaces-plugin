import {
  enterRecoverableInsert,
  leaveRecoverableInsert,
} from '@claude-workspaces/core/mock-swap-noise';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The browser's Sentry entry, exercised rather than pattern-matched.
 *
 * `/app/sentry.js` is the only place any page loads the SDK — board, doc,
 * mockup, landing — so what it reads off the shell and what it hands
 * `Sentry.init` is the whole contract behind "compare load times across page
 * types". The SDK is mocked; everything else (the meta tags, the module's own
 * gate, the scrub it installs) is the real code path.
 *
 * The unconfigured case is asserted with a positive control: the same
 * `init` spy must fire when a DSN IS present, otherwise "init was not called"
 * is satisfied by a module that never ran at all.
 */
const init = vi.fn();
const captureException = vi.fn();
const consoleLoggingIntegration = vi.fn((opts: { levels: string[] }) => ({
  name: 'ConsoleLogs',
  levels: opts.levels,
}));

vi.mock('@sentry/browser', () => ({
  init,
  captureException,
  consoleLoggingIntegration,
}));

type InitOptions = {
  dsn: string;
  release?: string;
  tracesSampleRate?: number;
  profileSessionSampleRate?: number;
  enableLogs: boolean;
  enableMetrics: boolean;
  integrations: Array<{ name: string; levels?: string[] }>;
  sendDefaultPii: boolean;
  initialScope: { tags: Record<string, string> };
  beforeSend: (e: unknown) => unknown;
  beforeSendLog: (e: unknown) => unknown;
  beforeSendMetric: (e: unknown) => unknown;
};

function shell(tags: Record<string, string>): void {
  document.head.innerHTML = Object.entries(tags)
    .map(([name, content]) => `<meta name="${name}" content="${content}">`)
    .join('');
}

async function boot(): Promise<void> {
  vi.resetModules();
  await import('../src/sentry-boot.ts');
}

const DSN = 'https://examplekey@o0.ingest.sentry.io/0';

/** A short synthetic workspace id — route templates match on POSITION, so
 *  nothing here needs a realistic-length one. */
const WS_ID = 'w-abc123';

describe('the page Sentry entry', () => {
  beforeEach(() => {
    init.mockClear();
    captureException.mockClear();
    document.head.innerHTML = '';
    // Removed, not set to undefined: the next test must see a page the
    // shell's inline buffer never ran on.
    Reflect.deleteProperty(window, '__cwSentryEarly');
  });

  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('does nothing at all when the shell names no DSN', async () => {
    shell({ 'sentry-page-type': 'doc' });
    await boot();
    expect(init).not.toHaveBeenCalled();
  });

  it('inits once when the shell names a DSN (the control for the case above)', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'doc' });
    await boot();
    expect(init).toHaveBeenCalledTimes(1);
    expect((init.mock.calls[0]?.[0] as InitOptions).dsn).toBe(DSN);
  });

  it('files the errors the inline buffer held before the SDK arrived, then closes it', async () => {
    const thrown = new Error('Harborlight boot failure');
    const held = Object.assign(
      [
        { kind: 'onerror', error: thrown },
        { kind: 'onunhandledrejection', error: 'Riverbend rejected' },
      ],
      { done: false },
    );
    (window as unknown as Record<string, unknown>).__cwSentryEarly = held;
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'doc' });
    await boot();
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(captureException.mock.calls[0]?.[0]).toBe(thrown);
    expect(captureException.mock.calls[1]?.[0]).toBe('Riverbend rejected');
    // Closed and emptied: from here the SDK's own handlers own every error,
    // and one filed by both would be counted twice.
    expect(held.done).toBe(true);
    expect(held).toHaveLength(0);
    // Filed after init, never before it — a capture with no client is lost.
    expect(init.mock.invocationCallOrder[0]).toBeLessThan(
      captureException.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('drops a held collision a mock round recovered from, judged by the window the buffer copied', async () => {
    const during: Record<string, unknown> = {};
    enterRecoverableInsert('const params = [1];', during);
    const collision = () => new SyntaxError("Identifier 'params' has already been declared");
    const recovered = collision();
    const unrecovered = collision();
    (window as unknown as Record<string, unknown>).__cwSentryEarly = [
      { kind: 'onerror', error: recovered, scope: { ...during } },
      // The control: the same collision held outside any swap is filed.
      { kind: 'onerror', error: unrecovered, scope: {} },
    ];
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'mockup' });
    await boot();
    expect(captureException.mock.calls.map((c) => c[0])).toEqual([unrecovered]);
  });

  it.each(['board', 'doc', 'mockup', 'landing'])(
    'tags the page type the shell named: %s',
    async (pageType) => {
      shell({ 'sentry-dsn': DSN, 'sentry-page-type': pageType });
      await boot();
      expect((init.mock.calls[0]?.[0] as InitOptions).initialScope.tags.page_type).toBe(pageType);
    },
  );

  it('tags an unnamed page type rather than omitting it', async () => {
    // A page that fell through the shell wiring must show up IN the same
    // group-by as the four real types, not be absent from it.
    shell({ 'sentry-dsn': DSN });
    await boot();
    expect((init.mock.calls[0]?.[0] as InitOptions).initialScope.tags.page_type).toBe('unknown');
  });

  it('names the deploy as the release, and keeps the build id as a tag', async () => {
    shell({
      'sentry-dsn': DSN,
      'sentry-page-type': 'board',
      'sentry-release': 'v0.1.0-33-gdec854b',
    });
    await boot();
    const opts = init.mock.calls[0]?.[0] as InitOptions;
    // The release is the DEPLOY, not the bundle hash — that is what lets a
    // regression be attributed to the deploy it arrived with.
    expect(opts.release).toBe('v0.1.0-33-gdec854b');
    expect(opts.initialScope.tags.build_id).toBeTruthy();
  });

  it('omits the release rather than guessing when the shell names none', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'board' });
    await boot();
    expect((init.mock.calls[0]?.[0] as InitOptions).release).toBeUndefined();
  });

  it('reports errors and warn/error console lines, and no traces or profiles', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'board' });
    await boot();
    const opts = init.mock.calls[0]?.[0] as InitOptions;
    // Nothing reads a browser span — page load times are the server's
    // /load-reports — and tracing plus profiling were 24 KB gzipped of an
    // SDK every page downloads. Unset rates are what keep them off.
    expect(opts.integrations.map((i) => i.name)).toEqual(['ConsoleLogs']);
    expect(opts.tracesSampleRate).toBeUndefined();
    expect(opts.profileSessionSampleRate).toBeUndefined();
    // Logs and metrics stated on, not left to the SDK default.
    expect(opts.enableLogs).toBe(true);
    expect(opts.enableMetrics).toBe(true);
    const logs = opts.integrations.find((i) => i.name === 'ConsoleLogs');
    expect(logs?.levels).toEqual(['warn', 'error']);
  });

  it('scrubs every log line and every metric on the way out, same as events', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'doc' });
    await boot();
    const opts = init.mock.calls[0]?.[0] as InitOptions;
    const needle = 'quarterly-comp-review.md';
    const log = { level: 'warn', message: `slow save for /workspaces/${WS_ID}/docs/${needle}` };
    expect(JSON.stringify(log)).toContain(needle);
    expect(JSON.stringify(opts.beforeSendLog(log))).not.toContain(needle);
    // The floor is paths and minted ids — the shapes the SDK and this code
    // produce. A bare filename with no path around it has no shape to
    // match and stays the caller's responsibility, as it does for events.
    const metric = {
      name: 'cw.save.ms',
      value: 12,
      attributes: { doc: `/workspaces/${WS_ID}/docs/${needle}` },
    };
    expect(JSON.stringify(metric)).toContain(needle);
    expect(JSON.stringify(opts.beforeSendMetric(metric))).not.toContain(needle);
  });

  it('drops the redeclaration a mockup round has already recovered from, and only that', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'mockup' });
    await boot();
    const send = (init.mock.calls[0]?.[0] as InitOptions).beforeSend;
    const collision = {
      exception: {
        values: [{ type: 'SyntaxError', value: "Identifier 'params' has already been declared" }],
      },
    };

    // Outside a swap nothing has recovered anything, so the report is filed —
    // this is the control for the drop below, and it is also the shape a
    // `"use strict"` or `type="module"` collision arrives in, which the swap
    // never retries.
    expect(send(collision)).not.toBeNull();

    // Inside the insert the widget is about to retry, it goes nowhere.
    const before = enterRecoverableInsert('const params = [1];');
    try {
      expect(send(collision)).toBeNull();
      // Still narrow while the flag is up: a SyntaxError thrown at runtime is
      // not an early error, nothing retries it, and it is filed.
      expect(
        send({
          exception: { values: [{ type: 'SyntaxError', value: 'Unexpected end of JSON input' }] },
        }),
      ).not.toBeNull();
    } finally {
      leaveRecoverableInsert(before);
    }

    expect(send(collision)).not.toBeNull();
  });

  it('scrubs every event on the way out', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'doc' });
    await boot();
    const opts = init.mock.calls[0]?.[0] as InitOptions;
    expect(opts.sendDefaultPii).toBe(false);
    const needle = 'quarterly-comp-review.md';
    for (const hook of [opts.beforeSend]) {
      const event = {
        transaction: `/workspaces/${WS_ID}/docs/${needle}`,
        request: { url: `https://example.test/review/${needle}` },
      };
      expect(JSON.stringify(event)).toContain(needle); // the needle IS there
      expect(JSON.stringify(hook(event))).not.toContain(needle);
    }
  });
});

/**
 * An invariant a unit test cannot see, because it is about what ends up in a
 * BUNDLE rather than what a function returns. A source pin, deliberately —
 * and it names the failure it is standing in for.
 */
describe('the page bundles stay out of the SDK', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { BOARD_BOOT_SOURCES } = await import('./support/board-boot-sources.ts');
  const boardSrc = BOARD_BOOT_SOURCES.map((m) =>
    readFileSync(join(__dirname, '..', 'src', 'board', `${m}.ts`), 'utf8'),
  ).join('\n');
  const appSrc = readFileSync(join(__dirname, '..', 'src', 'app.ts'), 'utf8');

  it('neither entry imports @sentry/browser', () => {
    // `app.ts` builds with splitting OFF, so an import here — static or
    // dynamic — lands the whole SDK in the file every doc load fetches,
    // configured or not. `board.js` used to carry it as a chunk; now nothing
    // but sentry.js references the SDK at all.
    expect(boardSrc).not.toContain('@sentry/browser');
    expect(appSrc).not.toContain('@sentry/browser');
  });
});
