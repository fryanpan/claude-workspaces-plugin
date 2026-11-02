/**
 * The daily wall report (`infra/project-machine/wall-report.ts`) and the
 * probe it runs on each machine (`wall-probe.ts`).
 *
 * The probe's mint and verify run for real, with the real signing module,
 * on keys made here; only `fly ssh console` is faked, by a function that
 * runs the probe's own functions against the named machine's key. Nothing
 * here calls Fly or Cloudflare.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import {
  type Batch,
  WALL_TYPES,
  mintExpired,
  readServerKey,
  verifyBatch,
} from '../../../infra/project-machine/wall-probe.ts';
import {
  type MachineExec,
  PROBE,
  cloudflareRows,
  crossRows,
  report,
} from '../../../infra/project-machine/wall-report.ts';
import { appVoiceToken } from '../src/app-voice/token.ts';
import { tokenKey, verifyToken } from '../src/auth/signed-token.ts';

const KEYS: Record<string, string> = {
  harborlight: 'a1'.repeat(32),
  riverbend: 'b2'.repeat(32),
};

/** `fly ssh console` for a machine whose server holds `keys[project]`. */
function exec(keys: Record<string, string>, log: string[] = []): MachineExec {
  return (app, command) => {
    log.push(`${app}: ${command.slice(0, PROBE.length + 7)}`);
    const key = keys[app.replace(/^cw-/, '')];
    if (!key) throw new Error('fly ssh console failed: no such app');
    const [, , cmd, arg] = command.split(' ');
    const out =
      cmd === 'mint'
        ? mintExpired(key)
        : verifyBatch(key, JSON.parse(Buffer.from(arg ?? '', 'base64').toString()) as Batch);
    return `Connecting to fdaa::3... complete\n${JSON.stringify(out)}\n`;
  };
}

describe('the wall probe', () => {
  it('mints values that are already expired, so none is a live credential', () => {
    const now = Date.UTC(2026, 10, 2, 12);
    const b = mintExpired(KEYS.harborlight ?? '', now);
    expect(b.at).toBeLessThan(now - 3_500_000);
    // At the time it was made, the issuer's own verifier refuses it as expired.
    const live = verifyToken(
      appVoiceToken,
      b.tokens['app-voice'],
      tokenKey(KEYS.harborlight ?? '', appVoiceToken),
      now,
    );
    expect(live).toEqual({ ok: false, reason: 'expired' });
  });

  it('the issuer accepts its own values and another key refuses each for its signature', () => {
    const b = mintExpired(KEYS.harborlight ?? '');
    expect(verifyBatch(KEYS.harborlight ?? '', b)).toEqual({
      wt2: 'accepted',
      ft1: 'accepted',
      fc1: 'accepted',
      'app-voice': 'accepted',
    });
    expect(Object.values(verifyBatch(KEYS.riverbend ?? '', b))).toEqual(
      WALL_TYPES.map(() => 'bad_signature'),
    );
  });

  it('reads the key file and never makes one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wall-probe-'));
    try {
      expect(() => readServerKey(dir)).toThrow('no share-cookie.key');
      writeFileSync(join(dir, 'share-cookie.key'), `${KEYS.riverbend}\n`);
      expect(readServerKey(dir)).toBe(KEYS.riverbend ?? '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cross-project refusals', () => {
  it('passes when each server accepts only its own values', () => {
    const log: string[] = [];
    const rows = crossRows(['harborlight', 'riverbend'], exec(KEYS, log));
    expect(rows).toHaveLength(2 * 2 * WALL_TYPES.length);
    expect(rows.every((r) => r.ok)).toBe(true);
    const cross = rows.filter((r) => r.issuer !== r.presentedTo);
    expect(cross.every((r) => r.answer === 'bad_signature')).toBe(true);
    expect(log.filter((l) => l.includes(' mint'))).toEqual([
      `cw-harborlight: ${PROBE} mint`,
      `cw-riverbend: ${PROBE} mint`,
    ]);
    expect(report(['harborlight', 'riverbend'], rows, []).ok).toBe(true);
  });

  it('fails when two servers share a key', () => {
    const shared = { harborlight: KEYS.harborlight ?? '', riverbend: KEYS.harborlight ?? '' };
    const rows = crossRows(['harborlight', 'riverbend'], exec(shared));
    const cross = rows.filter((r) => r.issuer !== r.presentedTo);
    expect(cross.every((r) => !r.ok && r.answer === 'accepted')).toBe(true);
    const r = report(['harborlight', 'riverbend'], rows, []);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('8 cross-project value(s) were not refused for the signature');
  });

  it('fails the run when a machine cannot be probed, rather than reading it as a refusal', () => {
    const rows = crossRows(['harborlight', 'saltmarsh'], exec(KEYS));
    const fromSaltmarsh = rows.filter((r) => r.issuer === 'saltmarsh');
    expect(fromSaltmarsh.every((r) => r.answer === 'mint-failed' && !r.ok)).toBe(true);
    const toSaltmarsh = rows.filter(
      (r) => r.issuer === 'harborlight' && r.presentedTo === 'saltmarsh',
    );
    expect(toSaltmarsh.every((r) => r.answer === 'probe-error' && !r.ok)).toBe(true);
    const r = report(['harborlight', 'saltmarsh'], rows, []);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('did not accept its own value');
  });

  it('fails with fewer than two project machines, since nothing was compared', () => {
    const rows = crossRows(['harborlight'], exec(KEYS));
    const r = report(['harborlight'], rows, []);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('a cross-project refusal needs two');
  });
});

const tunnel = (p: string, publicHost: string) => ({
  account_id: 'f'.repeat(32),
  id: '11111111-2222-4333-8444-555555555555',
  name: `cw-${p}`,
  origin: `${p}-origin.harborlight.test`,
  public_host: publicHost,
});

const OUTPUTS: TfOutputs = {
  access: {
    harborlight: { aud: 'aud-h', hosts: ['harborlight.harborlight.test'] },
    riverbend: { aud: 'aud-r', hosts: ['riverbend.harborlight.test'] },
  },
  accessTeamDomain: 'harborlight.cloudflareaccess.com',
  tunnels: {
    harborlight: tunnel('harborlight', 'harborlight.harborlight.test'),
    riverbend: tunnel('riverbend', 'riverbend.harborlight.test'),
  },
  routerRoutes: {
    harborlight: 'harborlight.harborlight.test/*',
    riverbend: 'riverbend.harborlight.test/*',
  },
};

const failing = (o: TfOutputs) =>
  cloudflareRows(o, ['harborlight', 'riverbend'])
    .filter((r) => !r.ok)
    .map((r) => `${r.project}: ${r.check}: ${r.answer}`);

describe("Cloudflare's config", () => {
  it('passes when each project has its own Access app, tunnel and route', () => {
    const rows = cloudflareRows(OUTPUTS, ['harborlight', 'riverbend']);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
    expect(rows.map((r) => `${r.project}: ${r.check}`)).toContain(
      'riverbend: tunnel host behind its own Access app',
    );
    // The audience is compared, never printed.
    expect(JSON.stringify(rows)).not.toContain('aud-r');
  });

  it('fails a shared audience and a host under two applications', () => {
    expect(
      failing({
        ...OUTPUTS,
        access: {
          harborlight: { aud: 'aud-h', hosts: ['harborlight.harborlight.test'] },
          riverbend: {
            aud: 'aud-h',
            hosts: ['riverbend.harborlight.test', 'harborlight.harborlight.test'],
          },
        },
      }),
    ).toEqual([
      'harborlight: audience is its own: shared with riverbend',
      'harborlight: hosts are its own: also under another project: harborlight.harborlight.test',
      'riverbend: audience is its own: shared with harborlight',
      'riverbend: hosts are its own: also under another project: harborlight.harborlight.test',
    ]);
  });

  it('fails a tunnel or route whose host its own Access app does not gate', () => {
    expect(
      failing({
        ...OUTPUTS,
        tunnels: {
          ...OUTPUTS.tunnels,
          riverbend: tunnel('riverbend', 'harborlight.harborlight.test'),
        },
        routerRoutes: { ...OUTPUTS.routerRoutes, harborlight: 'riverbend.harborlight.test/*' },
      }),
    ).toEqual([
      'harborlight: router route behind its own Access app: riverbend.harborlight.test/*',
      'riverbend: tunnel host behind its own Access app: harborlight.harborlight.test is not one of its hosts',
    ]);
  });

  it("fails a checked project with no tunnel, no Access app, or another project's tunnel name", () => {
    expect(
      failing({
        access: { riverbend: OUTPUTS.access.riverbend ?? { aud: '', hosts: [] } },
        accessTeamDomain: null,
        tunnels: {
          riverbend: {
            ...tunnel('riverbend', 'riverbend.harborlight.test'),
            name: 'cw-harborlight',
          },
        },
      }),
    ).toEqual([
      '(all): Access team domain: none in the outputs',
      'harborlight: Access application: none',
      'harborlight: tunnel: none in the outputs',
      'riverbend: tunnel: cw-harborlight -> riverbend-origin.harborlight.test',
    ]);
  });

  it('the report fails when a Cloudflare check fails', () => {
    const rows = crossRows(['harborlight', 'riverbend'], exec(KEYS));
    const r = report(['harborlight', 'riverbend'], rows, [
      { project: 'riverbend', check: 'Access application', answer: 'none', ok: false },
    ]);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('1 Cloudflare check(s) failed');
  });
});
