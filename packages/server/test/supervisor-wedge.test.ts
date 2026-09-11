/**
 * The contrast the watchdog change rests on, shown on a real server.
 *
 * A child process runs `createServer` on a throwaway data dir, then blocks
 * its own main thread on command. While it is blocked, the probe the
 * supervisor USED to run — a TCP connect, kept below verbatim as the control —
 * still reports `listening`, because the kernel completes the handshake from
 * the listen backlog without the process's help. The new probe sends a
 * request, gets nothing back, and says `no-answer`.
 *
 * Both probes are also run against the same server BEFORE the block, where
 * both must say healthy. Without that, a `no-answer` could be a probe that
 * never worked rather than a server that stopped.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyConnectError } from '../src/port-bind.ts';
import { probeHealth } from '../src/supervisor-health.ts';
import { waitFor } from './wait-for.ts';

const fixture = join(import.meta.dir, 'fixtures', 'wedge-server.ts');

/**
 * The control: `probePortListening` as `scripts/serve.ts` ran it before this
 * change, minus nothing but its name. It resolves on `connect` alone.
 */
function oldProbePortListening(
  port: number,
  host = '127.0.0.1',
): Promise<'listening' | 'not-listening' | 'inconclusive'> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host });
    let settled = false;
    const done = (verdict: 'listening' | 'not-listening' | 'inconclusive') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(verdict);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done('listening'));
    socket.once('timeout', () => done('not-listening'));
    socket.once('error', (err) => done(classifyConnectError(err)));
  });
}

/** Read a child's pipe as it arrives, so the test can poll what it said. */
async function drain(stream: ReadableStream<Uint8Array>, onText: (text: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    onText(decoder.decode(value, { stream: true }));
  }
}

describe('a server whose loop is blocked', () => {
  let child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>> | null = null;
  let dataDir: string | null = null;

  afterEach(() => {
    child?.kill('SIGKILL');
    child = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  it('passes the old connect-only probe and fails the new one', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'supervisor-wedge-'));
    const proc = Bun.spawn(['bun', 'run', fixture, dataDir], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child = proc;
    let out = '';
    let err = '';
    void drain(proc.stdout, (text) => {
      out += text;
    });
    void drain(proc.stderr, (text) => {
      err += text;
    });

    const bound = await waitFor(() => /^ready (\d+)$/m.exec(out)?.[1], {
      timeout: 30_000,
      describe: 'the fixture server to bind',
    }).catch((e: Error) => {
      throw new Error(`${e.message}; the child's stderr ended: ${err.slice(-1000)}`);
    });
    const port = Number(bound);

    // Positive control: the server is up and both probes agree.
    expect(await oldProbePortListening(port)).toBe('listening');
    const before = await probeHealth(port);
    expect(before).toEqual({ verdict: 'answering', status: 200 });

    proc.stdin.write('wedge\n');
    proc.stdin.flush();
    await waitFor(() => out.includes('wedged\n'), { timeout: 10_000, describe: 'the wedge' });

    // The block has no end, so nothing here races it: the child stays
    // wedged until afterEach kills it. The answer budget is short only to
    // keep the test quick; the block is longer than any budget.
    const [oldVerdict, newResult] = await Promise.all([
      oldProbePortListening(port),
      probeHealth(port, { answerTimeoutMs: 500 }),
    ]);
    expect(oldVerdict).toBe('listening');
    expect(newResult.verdict).toBe('no-answer');
  }, 60_000);
});
