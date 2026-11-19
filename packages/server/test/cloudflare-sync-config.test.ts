/**
 * `cf:sync-config` without the keeper (`infra/cloudflare/sync-config.ts`):
 * the two routing configs go to their repository secrets on `gh`'s stdin,
 * the Access config is not sent, and cloudflare.yml is started on main. A
 * stand-in `gh` and stand-in configs; nothing leaves.
 */
import { describe, expect, it } from 'bun:test';
import { type SyncIo, syncConfig } from '../../../infra/cloudflare/sync-config.ts';
import { CONFIG_PATHS } from '../../../infra/cloudflare/vars.ts';

const ZONE = 'harborlight.test';
const P = CONFIG_PATHS.prod;
const ROUTER = JSON.stringify({
  zone: ZONE,
  oneAddress: `workspaces.${ZONE}`,
  projects: { riverbend: `riverbend-origin.${ZONE}` },
});
const SHARE = `name = "share-link-gate"\nroutes = [\n  { pattern = "share.${ZONE}/share/*", zone_name = "${ZONE}" },\n]\n`;
const ACCESS = JSON.stringify({
  projects: {
    riverbend: { hosts: [`riverbend-workspaces.${ZONE}`], emails: ['alice@harborlight.test'] },
  },
});

function world(files: Record<string, string | null>, failOn?: string) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const said: string[] = [];
  const io: SyncIo = {
    read: (rel) => files[rel] ?? null,
    gh: (args, input) => {
      calls.push({ args, ...(input === undefined ? {} : { input }) });
      return { status: failOn && args.includes(failOn) ? 1 : 0, stderr: 'HTTP 403' };
    },
    out: (s) => said.push(s),
    err: (s) => said.push(s),
  };
  return { io, calls, said };
}

const ALL = { [P.router]: ROUTER, [P.shareLink]: SHARE, [P.access]: ACCESS };

describe('cf:sync-config', () => {
  it('writes the two routing configs on stdin, never the Access config, then starts the apply', () => {
    const w = world(ALL);
    expect(syncConfig(w.io)).toBe(0);
    expect(w.calls.map((c) => c.args.slice(0, 3).join(' '))).toEqual([
      'secret set CF_ROUTER_CONFIG',
      'secret set CF_SHARE_LINK_CONFIG',
      'workflow run cloudflare.yml',
    ]);
    expect(w.calls[0]?.input).toBe(ROUTER);
    expect(w.calls[1]?.input).toBe(SHARE);
    const args = w.calls.flatMap((c) => c.args).join(' ');
    expect(args).not.toContain(ZONE);
    expect(args).not.toContain('CF_ACCESS_CONFIG');
    expect(w.calls[2]?.args).toContain('main');
    expect(w.said.join('')).not.toContain(ZONE);
  });

  it('skips a share-link config that is not here, and still applies', () => {
    const w = world({ [P.router]: ROUTER });
    expect(syncConfig(w.io)).toBe(0);
    expect(w.calls.map((c) => c.args[2])).toEqual(['CF_ROUTER_CONFIG', 'cloudflare.yml']);
    expect(w.said.join('')).toContain('keeps the value it has');
  });

  it('writes nothing when the router config is missing or does not parse', () => {
    for (const router of [null, '{"zone": 1}']) {
      const w = world({ ...ALL, [P.router]: router });
      expect(syncConfig(w.io)).toBe(1);
      expect(w.calls).toEqual([]);
      expect(w.said.join('')).toContain('Nothing was written');
    }
  });

  it('starts no apply when a secret could not be written', () => {
    const w = world(ALL, 'CF_SHARE_LINK_CONFIG');
    expect(syncConfig(w.io)).toBe(1);
    expect(w.calls.some((c) => c.args[0] === 'workflow')).toBe(false);
    expect(w.said.join('')).toContain('Already written: CF_ROUTER_CONFIG');
  });
});
