/**
 * `bootBin` answers for its own child and nobody else, even when another
 * server is already on the port a probe would have handed out — the order
 * that made the restore and move-board tests talk to a stranger on CI.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { bootBin, stopBin } from './boot-bin.ts';

const scratch = mkdtempSync(join(tmpdir(), 'cw-boot-bin-'));
const children: ChildProcess[] = [];
let foreign: ServerHandle | undefined;

afterAll(() => {
  foreign?.stop();
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

describe('bootBin', () => {
  it('reaches its own child while another server holds the port a probe just freed', async () => {
    // The race, forced: a probe frees a port and another process's server
    // binds it before the child could.
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const taken = probe.port;
    probe.stop(true);
    foreign = createServer({ port: taken, dataDir: join(scratch, 'foreign') });

    const dataDir = join(scratch, 'mine');
    const booted = await bootBin({ dataDir, children });
    expect(booted.port).not.toBe(taken);

    const host = `localhost:${booted.port}`;
    const res = await fetch(`${booted.base}/workspaces`, {
      method: 'POST',
      headers: { host, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    expect(res.status).toBe(200);
    const id = ((await res.json()) as { workspace: { id: string } }).workspace.id;
    // The board is the child's: it reads it back, and the other server never had it.
    const read = (base: string, port: number) =>
      fetch(`${base}/workspaces/${id}?format=json`, { headers: { host: `localhost:${port}` } });
    expect((await read(booted.base, booted.port)).status).toBe(200);
    expect((await read(`http://127.0.0.1:${taken}`, taken as number)).status).toBe(404);
    await stopBin(booted.child);
  }, 60_000);

  it('names why a child that dies before listening died, without waiting out the timeout', async () => {
    // A data dir that is a file: the child refuses it and exits.
    const notADir = join(scratch, 'not-a-dir');
    await Bun.write(notADir, 'Riverbend');
    await expect(bootBin({ dataDir: notADir, children })).rejects.toThrow(
      /bin\.ts exited .* before listening/,
    );
  }, 60_000);
});
