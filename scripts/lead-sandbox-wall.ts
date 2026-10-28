/**
 * The board wall: the rules that keep a sandboxed lead off every board
 * server's TCP port, so its one way to a board is the lead socket
 * (`packages/server/src/lead-socket.ts`), which admits only that lead's
 * board token.
 *
 * Without it a lead's `curl 127.0.0.1:8787` is a trusted-local caller and
 * reads every board. Each port is denied at every address (`*:<port>`), so
 * `localhost`, `::1` and this machine's LAN and tailnet addresses are covered
 * too. The ports are `BOARD_SERVER_PORTS`, which `scripts/staging.ts` also
 * enforces, so a staging server cannot listen where the wall does not look.
 *
 * Off unless a lead's config sets `boardWall`: a walled lead's board tools
 * do not reach the lead socket yet, so `lead-sandbox.ts` refuses to launch
 * one and only `--check` uses it.
 */
import { BOARD_SERVER_PORTS } from '../packages/server/src/reserved-ports.ts';

export { BOARD_SERVER_PORTS };

/** The deny lines for a lead, or none when its config leaves the wall off. */
export function boardWallRules(
  on: boolean,
  ports: readonly number[] = BOARD_SERVER_PORTS,
): string[] {
  if (!on) return [];
  return ports.map(
    (port) => `(deny network-outbound (remote ip "*:${port}")) ; a board server's port`,
  );
}

/**
 * What a TCP connect answers, from `node -e` or `bun -e`: `connected`, or
 * the error code. Under the wall the code is `EPERM`, which a port with
 * nothing listening (`ECONNREFUSED`) cannot be mistaken for.
 */
export const CONNECT_PROBE = `const s = require('node:net').connect({ host: process.env.HOST, port: Number(process.env.PORT) });
s.setTimeout(3000);
s.on('connect', () => { console.log('connected'); s.destroy(); });
s.on('timeout', () => { console.log('timeout'); s.destroy(); });
s.on('error', (e) => console.log(e.code ?? 'error'));`;

/**
 * Every address a lead could reach this machine's board server at: both
 * loopbacks, and each LAN and tailnet address the interfaces report.
 * IPv6 link-local addresses are left out; they need a zone to connect to.
 */
export function wallHosts(
  interfaces: NodeJS.Dict<Array<{ address: string; family: string; internal: boolean }>>,
): string[] {
  const out = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(interfaces))
    for (const i of list ?? [])
      if (!i.internal && !i.address.toLowerCase().startsWith('fe80:')) out.add(i.address);
  return [...out];
}
