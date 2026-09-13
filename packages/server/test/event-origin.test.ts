/**
 * Device and location on the two analytics logs Weekly Review reads.
 *
 * Driven through the real server: a request that looks like a browser writes
 * rows carrying `device` (and `location` when its cookie says so), and the
 * same request without the browser's headers — the shape of an MCP tool call
 * — writes rows carrying neither. The unit cases below pin the UA table and
 * the one timing rule that keeps a background timer from inheriting a
 * finished request's origin.
 *
 * Coordinates are fictional (open ocean). The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGeoCookie } from '@claude-workspaces/core';
import { activityLogPath } from '../src/activity.ts';
import {
  currentEventOrigin,
  deviceFromUserAgent,
  originOfHeaders,
  stampEventOrigin,
  withEventOrigin,
} from '../src/event-origin.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { eventsLogPath } from '../src/tasks.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const UA = {
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  // iPadOS Safari's default "desktop website" UA: indistinguishable from a Mac.
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
};

describe('deviceFromUserAgent', () => {
  it('names the four kinds and the browser', () => {
    expect(deviceFromUserAgent(UA.ipad, null)).toEqual({ kind: 'ipad', browser: 'Safari' });
    expect(deviceFromUserAgent(UA.macSafari, 0)).toEqual({ kind: 'desktop', browser: 'Safari' });
    expect(deviceFromUserAgent(UA.macChrome, null)).toEqual({ kind: 'desktop', browser: 'Chrome' });
    expect(deviceFromUserAgent(UA.iphoneChrome, 5)).toEqual({ kind: 'phone', browser: 'Chrome' });
    expect(deviceFromUserAgent(UA.androidPhone, 5)).toEqual({ kind: 'phone', browser: 'Chrome' });
    expect(deviceFromUserAgent(UA.androidTablet, 5)).toEqual({ kind: 'other', browser: 'Chrome' });
    expect(deviceFromUserAgent(UA.windowsEdge, 0)).toEqual({ kind: 'desktop', browser: 'Edge' });
    expect(deviceFromUserAgent(UA.linuxFirefox, 0)).toEqual({
      kind: 'desktop',
      browser: 'Firefox',
    });
  });

  it('tells an iPad sending a Mac user agent apart by its touch points', () => {
    expect(deviceFromUserAgent(UA.macSafari, 5).kind).toBe('ipad');
    // A Mac with no touch hint at all stays a Mac.
    expect(deviceFromUserAgent(UA.macSafari, null).kind).toBe('desktop');
  });
});

describe('originOfHeaders', () => {
  const browserHeaders = (cookie: string) =>
    new Headers({ 'user-agent': UA.macSafari, 'sec-fetch-site': 'same-origin', cookie });

  it('reads device and a rounded location off a browser request', () => {
    const origin = originOfHeaders(browserHeaders('cw_touch=5; cw_geo=12.3456,-45.6789'), true);
    expect(origin.device).toEqual({ kind: 'ipad', browser: 'Safari' });
    expect(origin.location).toEqual({ lat: 12.35, lng: -45.68 });
  });

  it('gives a non-browser request nothing, whatever its cookies say', () => {
    expect(originOfHeaders(browserHeaders('cw_geo=12.34,-45.67'), false)).toEqual({});
  });

  it('refuses a location cookie that is not two in-range numbers', () => {
    for (const bad of ['91,0', '0,181', 'abc,1', '1', '1,2,3', '%E0%A4%A', '']) {
      expect(originOfHeaders(browserHeaders(`cw_geo=${bad}`), true).location, bad).toBeUndefined();
    }
    // Positive control: the same header shape with a valid value is read.
    expect(originOfHeaders(browserHeaders('cw_geo=-0.5,179.99'), true).location).toEqual({
      lat: -0.5,
      lng: 179.99,
    });
  });

  it('rounds a hand-written precise cookie to two decimals on the server', () => {
    expect(parseGeoCookie('12.345678,98.765432')).toEqual({ lat: 12.35, lng: 98.77 });
  });
});

describe('the origin is in scope only while the request is', () => {
  it('stamps inside, and a timer started inside sees nothing once the request is done', async () => {
    const origin = { device: { kind: 'phone' as const, browser: 'Safari' } };
    let inside: object = {};
    let timerSaw: object | undefined;
    let fired = false;
    await withEventOrigin(origin, async () => {
      await Promise.resolve();
      inside = stampEventOrigin({ event: 'task.created' });
      setTimeout(() => {
        timerSaw = currentEventOrigin();
        fired = true;
      }, 0);
    });
    expect(inside).toEqual({ event: 'task.created', device: origin.device });
    await waitFor(() => fired);
    expect(timerSaw).toEqual({});
    expect(stampEventOrigin({ event: 'server.tick' })).toEqual({ event: 'server.tick' });
  });
});

function rows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('both logs, through the real server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'event-origin-'));
    // The sign-in gate refuses an anonymous browser write; it is not under test.
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
    const file = join(dataDir, 'origin-doc.md');
    writeFileSync(file, '# Heading\n\nProse.\n');
    const res = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'origin-doc', type: 'markdown', sourceUrl: file }),
    });
    expect(res.status).toBe(200);
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** What a same-origin page sends: the fetch-metadata headers and its cookies. */
  const browser = (cookie: string) => ({
    'content-type': 'application/json',
    origin: base,
    'sec-fetch-site': 'same-origin',
    'user-agent': UA.macSafari,
    cookie,
  });
  /** What the MCP child sends: no fetch metadata, a runtime UA. */
  const agentHeaders = { 'content-type': 'application/json', 'user-agent': 'Bun/1.3.10' };

  it('a browser doc_open carries device and location; the same POST from an agent carries neither', async () => {
    const post = (headers: Record<string, string>, sessionId: string) =>
      fetch(`${base}/workspaces/${ws}/docs/origin-doc/activity`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'doc_open', payload: { sessionId } }),
      });
    expect((await post(browser('cw_touch=5; cw_geo=10.12,-20.34'), 'from-browser')).status).toBe(
      200,
    );
    expect((await post(agentHeaders, 'from-agent')).status).toBe(200);

    const log = rows(activityLogPath(dataDir));
    const fromBrowser = log.find(
      (r) => (r.payload as { sessionId?: string }).sessionId === 'from-browser',
    );
    const fromAgent = log.find(
      (r) => (r.payload as { sessionId?: string }).sessionId === 'from-agent',
    );
    expect(fromBrowser?.device).toEqual({ kind: 'ipad', browser: 'Safari' });
    expect(fromBrowser?.location).toEqual({ lat: 10.12, lng: -20.34 });
    // Positive control for the absence: the agent's row was written.
    expect(fromAgent).toBeDefined();
    expect(fromAgent?.device).toBeUndefined();
    expect(fromAgent?.location).toBeUndefined();
  });

  it('a browser without a location cookie gets a device and no location', async () => {
    const res = await fetch(`${base}/workspaces/${ws}/docs/origin-doc/activity`, {
      method: 'POST',
      headers: browser('cw_touch=0'),
      body: JSON.stringify({ type: 'doc_open', payload: { sessionId: 'no-geo' } }),
    });
    expect(res.status).toBe(200);
    const row = rows(activityLogPath(dataDir)).find(
      (r) => (r.payload as { sessionId?: string }).sessionId === 'no-geo',
    );
    expect(row?.device).toEqual({ kind: 'desktop', browser: 'Safari' });
    expect(row?.location).toBeUndefined();
  });

  it('a task a browser files stamps its events.jsonl row; one an agent files does not', async () => {
    const file = async (headers: Record<string, string>, title: string) => {
      const res = await fetch(`${base}/workspaces/${ws}/tasks`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title,
          assignee: 'human',
          author: { id: 'agent-riverbend', name: 'Riverbend', kind: 'agent' },
        }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { task: { id: string } }).task.id;
    };
    const browserTask = await file(browser('cw_touch=5; cw_geo=1.5,2.25'), 'Filed from a page');
    const agentTask = await file(agentHeaders, 'Filed from a tool');

    const log = rows(eventsLogPath(dataDir, ws));
    const created = (id: string) => log.find((r) => r.event === 'task.created' && r.taskId === id);
    expect(created(browserTask)?.device).toEqual({ kind: 'ipad', browser: 'Safari' });
    expect(created(browserTask)?.location).toEqual({ lat: 1.5, lng: 2.25 });
    expect(created(agentTask)).toBeDefined();
    expect(created(agentTask)?.device).toBeUndefined();
    expect(created(agentTask)?.location).toBeUndefined();
  });
});
