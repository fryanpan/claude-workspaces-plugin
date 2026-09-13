/**
 * The route table's `loopback-only` and `trusted-local` rows, checked against
 * the server rather than read off it.
 *
 * `route-table.test.ts` checks the gate column against `shareScopeAllows`,
 * which answers one question: can a share visitor reach this address? Both of
 * these gates answer no to that, so that test cannot tell them apart, and a
 * row filed under the wrong one passed it. Four had been — a deploy POST
 * filed `trusted-local`, the agent token filed `trusted-local`, the push key
 * filed `loopback-only`, and the plugin refresh listing only its read.
 *
 * So this file asks the other question. It dials every such row twice over
 * real sockets, from this machine's loopback address and from one of its
 * non-loopback addresses, with the same `Host` and the same body, and reads
 * which caller the route refused:
 *
 * - `loopback-only` — the off-box caller gets a 403 the on-box caller does not.
 * - `trusted-local` — it does not.
 *
 * The server runs with `accessOnlyBrowserHosts: false` and the dialled
 * address listed as a trusted host, because that is the only configuration in
 * which the difference is reachable at all. With the default on, a
 * non-loopback peer is refused by the host guard before any route runs, so
 * every row would read `loopback-only` for the host guard's reason. Every
 * probe asserts the host guard let it through, so a refusal here is the
 * route's.
 *
 * What it cannot see: the example ids name no real board, doc or task, so a
 * handler that looks something up before it checks the peer address answers
 * 404 to both callers and reads `trusted-local`. Every address check in the
 * server today runs before its lookups.
 *
 * Fake deployer and refresher: nothing here may pull, restart or update a
 * plugin cache.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Deployer } from '../src/deploy.ts';
import { PluginRefresher } from '../src/plugin-refresh.ts';
import { ROUTE_TABLE } from '../src/routes/route-table-rows.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

/** This machine's first non-loopback IPv4 address, if it has one. */
const offBoxAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

const ADDRESS_GATES = new Set(['trusted-local', 'loopback-only']);

interface Answer {
  status: number;
  error: string | undefined;
}

/**
 * Skipped when there is no non-loopback IPv4 to dial from (a sandboxed
 * container), because a probe that silently dials loopback twice would pass
 * every `trusted-local` row and fail every `loopback-only` one for a reason
 * that has nothing to do with the table.
 */
describe.if(Boolean(offBoxAddress))('every address-gated row is gated as the table says', () => {
  let handle: ServerHandle;
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'route-table-loopback-'));
    handle = createServer({
      port: 0,
      // Every interface, as prod binds, so the off-box address can dial it.
      hostname: '::',
      dataDir,
      trustedHosts: [offBoxAddress as string],
      accessOnlyBrowserHosts: false,
      deployer: new Deployer({
        run: async () => ({
          ok: true,
          status: 'deployed',
          changed: false,
          before: 'aaaaaaa',
          after: 'aaaaaaa',
          behind: 0,
          ahead: 0,
          message: 'fixture deploy',
          ranAt: 1,
          restartRequested: false,
        }),
        now: () => 1,
      }),
      pluginRefresher: new PluginRefresher({
        run: async () => ({
          ok: true,
          before: '0.0.1',
          after: '0.0.1',
          changed: false,
          message: 'fixture refresh',
          ranAt: 1,
        }),
        minIntervalMs: 0,
      }),
    });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** One call to `path` from `from`, reduced to what the gate decides. */
  const call = async (from: string, path: string, method: string): Promise<Answer> => {
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const res = await fetch(`http://${from}:${handle.port}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        host: `localhost:${handle.port}`,
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: '{}' } : {}),
    });
    let error: string | undefined;
    // A stream route answers 200 and never ends; only a refusal is read.
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      error = body?.error;
    } else {
      await res.body?.cancel();
    }
    return { status: res.status, error };
  };

  for (const entry of ROUTE_TABLE) {
    if (!ADDRESS_GATES.has(entry.gate)) continue;
    for (const method of entry.methods) {
      it(`${method} ${entry.pattern} — ${entry.gate}`, async () => {
        const offBox = await call(offBoxAddress as string, entry.example, method);
        const onBox = await call('127.0.0.1', entry.example, method);
        // The host guard admitted both, so any refusal below is the route's.
        expect(offBox.error, 'the host guard refused the off-box probe').not.toBe('unknown_host');
        expect(onBox.error, 'the host guard refused the on-box probe').not.toBe('unknown_host');
        const refusedOffBoxOnly = offBox.status === 403 && onBox.status !== 403;
        expect(
          { refusedOffBoxOnly, offBox, onBox },
          `${method} ${entry.pattern} is filed ${entry.gate}`,
        ).toMatchObject({ refusedOffBoxOnly: entry.gate === 'loopback-only' });
      });
    }
  }

  it('reaches a trusted-local route from the off-box address (positive control)', async () => {
    const res = await fetch(`http://${offBoxAddress}:${handle.port}/workspaces`, {
      headers: { host: `localhost:${handle.port}` },
    });
    expect(res.status).toBe(200);
  });
});
