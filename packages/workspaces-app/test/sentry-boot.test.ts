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
const browserTracingIntegration = vi.fn(() => ({ name: 'BrowserTracing' }));
const browserProfilingIntegration = vi.fn(() => ({ name: 'BrowserProfiling' }));
const consoleLoggingIntegration = vi.fn((opts: { levels: string[] }) => ({
  name: 'ConsoleLogs',
  levels: opts.levels,
}));

vi.mock('@sentry/browser', () => ({
  init,
  browserTracingIntegration,
  browserProfilingIntegration,
  consoleLoggingIntegration,
  setMeasurement: vi.fn(),
}));

type InitOptions = {
  dsn: string;
  release?: string;
  tracesSampleRate: number;
  profileSessionSampleRate: number;
  profileLifecycle: string;
  enableLogs: boolean;
  enableMetrics: boolean;
  integrations: Array<{ name: string; levels?: string[] }>;
  sendDefaultPii: boolean;
  initialScope: { tags: Record<string, string> };
  beforeSend: (e: unknown) => unknown;
  beforeSendTransaction: (e: unknown) => unknown;
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
    document.head.innerHTML = '';
    // Removed, not set to undefined: the next test must see a page where the
    // module never ran, which is the state an unconfigured box is in.
    Reflect.deleteProperty(window, '__cwSentry');
  });

  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('does nothing at all when the shell names no DSN', async () => {
    shell({ 'sentry-page-type': 'doc' });
    await boot();
    expect(init).not.toHaveBeenCalled();
    expect((window as unknown as Record<string, unknown>).__cwSentry).toBeUndefined();
  });

  it('inits once when the shell names a DSN (the control for the case above)', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'doc' });
    await boot();
    expect(init).toHaveBeenCalledTimes(1);
    expect((init.mock.calls[0]?.[0] as InitOptions).dsn).toBe(DSN);
    expect((window as unknown as Record<string, unknown>).__cwSentry).toBeDefined();
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

  it('profiles every session while a trace is open, and forwards warn/error console lines as logs', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'board' });
    await boot();
    const opts = init.mock.calls[0]?.[0] as InitOptions;
    const names = opts.integrations.map((i) => i.name);
    expect(names).toContain('BrowserTracing');
    expect(names).toContain('BrowserProfiling');
    // Profiles ride the traces: a session is always sampled, and the
    // profiler runs whenever a root span is open rather than on a manual
    // start nobody calls.
    expect(opts.profileSessionSampleRate).toBe(1);
    expect(opts.profileLifecycle).toBe('trace');
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

  it('scrubs every event and every transaction on the way out', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'doc' });
    await boot();
    const opts = init.mock.calls[0]?.[0] as InitOptions;
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.tracesSampleRate).toBe(1);
    const needle = 'quarterly-comp-review.md';
    for (const hook of [opts.beforeSend, opts.beforeSendTransaction]) {
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
 * Two invariants a unit test cannot see, because they are about what ends up
 * in a BUNDLE rather than what a function returns. Source pins, deliberately
 * — and each names the failure it is standing in for.
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

  it('the board still feeds its load phases into the pageload trace', () => {
    // The built-in load recorder and Sentry have to tell one story: the same
    // msToBoot / msToFirstProjection the report posts land as measurements.
    expect(boardSrc).toMatch(/setMeasurement\('ms_to_boot'/);
    expect(boardSrc).toMatch(/setMeasurement\('ms_to_first_projection'/);
    expect(boardSrc).toContain('pageSentry()');
  });
});
