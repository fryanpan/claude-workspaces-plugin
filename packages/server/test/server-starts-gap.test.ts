/**
 * The reconnect gap a restart opens: the old process writes when its shutdown
 * began, the new one writes when the first page socket reached it, and the
 * report pairs each start with the record before it.
 *
 * Fixtures are synthetic; every file lives in a scratch dir.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ServerStart,
  formatReconnectGaps,
  markFirstClientSocket,
  markServerServing,
  markServerShutdown,
  readServerStarts,
  reconnectGaps,
  recordServerStart,
  serverStartsPath,
} from '../src/server-starts.ts';

const T0 = 1_700_000_000_000;

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'server-starts-gap-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A record that shut down at `shutdownAt`, and the start after it: serving
 *  `listen` ms and first reconnected `reconnect` ms after that shutdown. */
function restart(
  pid: number,
  shutdownAt: number,
  listen?: number,
  reconnect?: number,
): [ServerStart, ServerStart] {
  const prev: ServerStart = { startedAt: shutdownAt - 60_000, pid: pid - 1, shutdownAt };
  const next: ServerStart = {
    startedAt: shutdownAt + 1_000,
    pid,
    ...(listen !== undefined ? { servingAt: shutdownAt + listen } : {}),
    ...(reconnect !== undefined ? { firstClientSocketAt: shutdownAt + reconnect } : {}),
  };
  return [prev, next];
}

describe('the two ends of the gap are written onto the right record', () => {
  it('the shutdown lands on the old record and the first socket on the new one', () => {
    withDir((dir) => {
      const file = serverStartsPath(dir);
      const old = recordServerStart(file, { startedAt: T0, pid: 1 }, []);
      markServerServing(file, old, { servingAt: T0 + 5_000 });
      markServerShutdown(file, old, T0 + 60_000);
      const next = recordServerStart(file, { startedAt: T0 + 61_000, pid: 2 }, []);
      markServerServing(file, next, { servingAt: T0 + 70_000 });
      markFirstClientSocket(file, next, T0 + 72_000);

      const [a, b] = readServerStarts(file);
      expect(a).toMatchObject({ pid: 1, servingAt: T0 + 5_000, shutdownAt: T0 + 60_000 });
      expect(a?.firstClientSocketAt).toBeUndefined();
      expect(b).toMatchObject({ pid: 2, servingAt: T0 + 70_000, firstClientSocketAt: T0 + 72_000 });
      expect(b?.shutdownAt).toBeUndefined();
    });
  });

  it('keeps the first value: a second signal does not move the shutdown later', () => {
    withDir((dir) => {
      const file = serverStartsPath(dir);
      const s = recordServerStart(file, { startedAt: T0, pid: 1 }, []);
      markServerShutdown(file, s, T0 + 1_000);
      markServerShutdown(file, s, T0 + 9_000);
      markFirstClientSocket(file, s, T0 + 2_000);
      markFirstClientSocket(file, s, T0 + 3_000);
      expect(readServerStarts(file)[0]).toMatchObject({
        shutdownAt: T0 + 1_000,
        firstClientSocketAt: T0 + 2_000,
      });
    });
  });

  it('writes nothing for a process with no record of its own', () => {
    withDir((dir) => {
      const file = serverStartsPath(dir);
      recordServerStart(file, { startedAt: T0, pid: 1 }, []);
      markServerShutdown(file, { startedAt: T0, pid: 99 }, T0 + 1_000);
      expect(readServerStarts(file)[0]?.shutdownAt).toBeUndefined();
    });
  });
});

describe('reconnectGaps', () => {
  it('measures each start from the shutdown of the record before it', () => {
    const [a, b] = restart(2, T0, 8_000, 11_000);
    const g = reconnectGaps([a, b], 20);
    expect(g.gaps).toEqual([
      {
        startedAt: b.startedAt,
        pid: 2,
        cause: 'unexplained',
        shutdownAt: T0,
        toListeningMs: 8_000,
        toReconnectMs: 11_000,
      },
    ]);
  });

  it('has no gap after a crash, and a listening gap without a page to reconnect', () => {
    const crashed: ServerStart = { startedAt: T0, pid: 1 };
    const afterCrash: ServerStart = { startedAt: T0 + 5_000, pid: 2, servingAt: T0 + 9_000 };
    const nobodyWatching: ServerStart = { ...afterCrash, shutdownAt: T0 + 60_000 };
    const quiet: ServerStart = { startedAt: T0 + 61_000, pid: 3, servingAt: T0 + 66_000 };
    const g = reconnectGaps([crashed, nobodyWatching, quiet], 20);
    expect(g.gaps.map((r) => r.pid)).toEqual([3]);
    expect(g.gaps[0]?.toListeningMs).toBe(6_000);
    expect(g.gaps[0]?.toReconnectMs).toBeUndefined();
    expect(g.toReconnect).toEqual({ count: 0, medianMs: null, longestMs: null });
  });

  it('takes the median and the longest over the last N starts only', () => {
    // Five restarts in a row, reconnect gaps 4s, 10s, 6s, 30s, 8s.
    const starts: ServerStart[] = [{ startedAt: T0, pid: 1, shutdownAt: T0 + 100_000 }];
    const reconnects = [4_000, 10_000, 6_000, 30_000, 8_000];
    reconnects.forEach((r, i) => {
      const prev = starts.at(-1) as ServerStart;
      const down = prev.shutdownAt as number;
      starts.push({
        startedAt: down + 500,
        pid: i + 2,
        servingAt: down + r - 1_000,
        firstClientSocketAt: down + r,
        shutdownAt: down + 100_000,
      });
    });
    const all = reconnectGaps(starts, 20);
    expect(all.last).toBe(6);
    expect(all.toReconnect).toEqual({ count: 5, medianMs: 8_000, longestMs: 30_000 });
    expect(all.toListening).toEqual({ count: 5, medianMs: 7_000, longestMs: 29_000 });

    // The last three: 6s, 30s, 8s. The 4s and 10s fall out.
    const recent = reconnectGaps(starts, 3);
    expect(recent.gaps.map((r) => r.toReconnectMs)).toEqual([6_000, 30_000, 8_000]);
    expect(recent.toReconnect).toEqual({ count: 3, medianMs: 8_000, longestMs: 30_000 });

    // An even count takes the mean of the middle two.
    expect(reconnectGaps(starts, 2).toReconnect.medianMs).toBe(19_000);
  });

  it('prints each gap and the summary lines, and says so when there are none', () => {
    const [a, b] = restart(2, T0, 8_000, 11_000);
    const text = formatReconnectGaps(reconnectGaps([a, b], 20));
    expect(text).toContain('to listening 8.0s  to first reconnect 11.0s');
    expect(text).toContain('to first reconnect: median 11.0s, longest 11.0s (of 1)');
    expect(text).toContain('to listening: median 8.0s, longest 8.0s (of 1)');
    expect(formatReconnectGaps(reconnectGaps([a], 20))).toContain('none recorded');
  });
});

describe('scripts/server-starts.ts prints the gap', () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'scripts',
    'server-starts.ts',
  );

  it('reads the gap off the data dir, and refuses a bad --last', () => {
    withDir((dir) => {
      const now = Date.now();
      const file = serverStartsPath(dir);
      const old = recordServerStart(file, { startedAt: now - 120_000, pid: 21 }, []);
      markServerShutdown(file, old, now - 60_000);
      const next = recordServerStart(file, { startedAt: now - 59_000, pid: 22 }, []);
      markServerServing(file, next, { servingAt: now - 52_000 });
      markFirstClientSocket(file, next, now - 49_500);

      const out = spawnSync('bun', ['run', script, '--data-dir', dir, '--last', '5'], {
        encoding: 'utf8',
      });
      expect(out.status).toBe(0);
      expect(out.stdout).toContain('reconnect gap over the last 2 starts');
      expect(out.stdout).toContain(
        'pid 22  unexplained  to listening 8.0s  to first reconnect 10.5s',
      );

      const bad = spawnSync('bun', ['run', script, '--data-dir', dir, '--last', '0'], {
        encoding: 'utf8',
      });
      expect(bad.status).toBe(2);
    });
  });
});
