/**
 * The Mac's pull, driven against a fake remote: the config it accepts, the
 * file it will read, and what it does when a stream drops.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FetchLike,
  createHomeRemotes,
  homeRemotesFromEnv,
  parseHomeRemotesConfig,
} from '../src/home-remotes.ts';
import { waitFor } from './wait-for.ts';

const MAC = 'mac-origin.harborlight.test';
const CLOUD = 'riverbend-origin.harborlight.test';
const BOARD = 'w-riverbend';
const token = () => ({
  clientId: 'test-client.access',
  clientSecret: `test-${crypto.randomUUID()}`,
});
const configJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    address: 'https://workspaces.harborlight.test',
    self: MAC,
    boardOrigins: { [MAC]: ['w-harbor'], [CLOUD]: [BOARD] },
    serviceTokens: { [CLOUD]: token() },
    ...over,
  });

describe('parseHomeRemotesConfig', () => {
  it('reads the Worker’s table and a token per remote origin', () => {
    const c = parseHomeRemotesConfig(configJson());
    if ('error' in c) throw new Error(c.error);
    expect(c.address).toBe('https://workspaces.harborlight.test');
    expect(c.table.get(BOARD)).toBe(CLOUD);
    expect([...c.tokens.keys()]).toEqual([CLOUD]);
  });

  it.each([
    ['not JSON', '{'],
    ['an http address', configJson({ address: 'http://workspaces.harborlight.test' })],
    ['an address with a path', configJson({ address: 'https://workspaces.harborlight.test/x' })],
    ['a malformed table', configJson({ boardOrigins: { 'Not A Host': [BOARD] } })],
    [
      'one board under two origins',
      configJson({ boardOrigins: { [MAC]: [BOARD], [CLOUD]: [BOARD] } }),
    ],
    ['a remote with no token', configJson({ serviceTokens: {} })],
    [
      'a token with a bad secret',
      configJson({ serviceTokens: { [CLOUD]: { clientId: 'a', clientSecret: 'b c' } } }),
    ],
  ])('refuses %s', (_why, raw) => {
    expect('error' in parseHomeRemotesConfig(raw)).toBe(true);
  });
});

describe('homeRemotesFromEnv', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const file = (mode: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'home-remotes-'));
    dirs.push(dir);
    const path = join(dir, 'home-remotes.json');
    writeFileSync(path, configJson());
    chmodSync(path, mode);
    return path;
  };

  it('reads a file only its owner can read', () => {
    expect(homeRemotesFromEnv({ CW_HOME_REMOTES_FILE: file(0o600) })?.table.get(BOARD)).toBe(CLOUD);
  });

  it('refuses a file others can read, and reads nothing when unset', () => {
    expect(homeRemotesFromEnv({ CW_HOME_REMOTES_FILE: file(0o644) })).toBeNull();
    expect(homeRemotesFromEnv({})).toBeNull();
  });
});

describe('createHomeRemotes', () => {
  const feedOf = (title: string) => ({
    v: 1,
    boardId: BOARD,
    boardName: 'Riverbend board',
    rows: [
      {
        key: 'k',
        kind: 'task-review',
        title,
        ask: '',
        askedBy: 'lead',
        since: Date.UTC(2026, 9, 16),
      },
    ],
  });

  it('re-reads on a frame, and again when a dropped stream reopens', async () => {
    const config = parseHomeRemotesConfig(configJson());
    if ('error' in config) throw new Error(config.error);
    let title = 'first';
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const calls: string[] = [];
    const remote: FetchLike = async (url, init) => {
      calls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get('cf-access-client-id')).toBe('test-client.access');
      if (url.endsWith('/events:stream')) {
        return new Response(
          new ReadableStream<Uint8Array>({ start: (c) => void streams.push(c) }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return Response.json(feedOf(title));
    };
    let changes = 0;
    const remotes = createHomeRemotes({
      config,
      fetch: remote,
      onChange: () => {
        changes += 1;
      },
      retryMs: 10,
    });
    try {
      expect(remotes.boards()[0]?.reached).toBeNull();
      remotes.start();
      await waitFor(() => remotes.boards()[0]?.rows[0]?.title === 'first', {
        describe: 'first read',
      });
      expect(calls[0]).toBe(
        `https://workspaces.harborlight.test/workspaces/${BOARD}/home-feed/events:stream`,
      );

      title = 'second';
      streams[0]?.enqueue(
        new TextEncoder().encode('event: landing.changed\ndata: {"parts":["boards"]}\n\n'),
      );
      await waitFor(() => remotes.boards()[0]?.rows[0]?.title === 'second', {
        describe: 'frame read',
      });

      // A frame for anything else reads nothing.
      const before = calls.length;
      streams[0]?.enqueue(new TextEncoder().encode(': keepalive\n\nevent: other\ndata: {}\n\n'));
      title = 'third';
      streams[0]?.close();
      // The stream dropped: it reopens and reads once, catching up.
      await waitFor(() => streams.length === 2, { describe: 'the stream reopened' });
      await waitFor(() => remotes.boards()[0]?.rows[0]?.title === 'third', {
        describe: 'catch-up read',
      });
      expect(calls.slice(before).filter((u) => u.endsWith('/home-feed'))).toHaveLength(1);
      expect(changes).toBe(3);
    } finally {
      remotes.dispose();
    }
  });

  it('keeps the last rows and says so when the remote stops answering', async () => {
    const config = parseHomeRemotesConfig(configJson());
    if ('error' in config) throw new Error(config.error);
    let up = true;
    const remote: FetchLike = async (url) => {
      if (!up) throw new Error('unreachable');
      if (url.endsWith('/events:stream')) {
        return new Response(
          new ReadableStream<Uint8Array>({ start: (c) => setTimeout(() => c.close(), 20) }),
        );
      }
      return Response.json(feedOf('kept'));
    };
    const remotes = createHomeRemotes({ config, fetch: remote, onChange: () => {}, retryMs: 10 });
    try {
      remotes.start();
      await waitFor(() => remotes.boards()[0]?.reached === true, { describe: 'first read' });
      up = false;
      await waitFor(() => remotes.boards()[0]?.reached === false, { describe: 'marked unreached' });
      expect(remotes.boards()[0]?.rows[0]?.title).toBe('kept');
    } finally {
      remotes.dispose();
    }
  });
});
