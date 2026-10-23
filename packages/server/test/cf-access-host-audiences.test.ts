/**
 * `CF_ACCESS_HOST_AUDS`: a host named there is checked against its own Access
 * application's audience and no other. The parser, the verifier's choice of
 * audience per host, and the boot refusals for a value that would quietly
 * accept the wrong stamp.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createCfAccessVerifier, parseHostAudiences } from '../src/middleware/cf-access.ts';
import { resolveServerConfig } from '../src/server-config.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'host-aud-kid';
const ONE = 'workspaces.harborlight.test';
const SUB = `harborlight.${ONE}`;

describe('parseHostAudiences', () => {
  it('reads hostnames to audiences, and lets two names share one application', () => {
    const m = parseHostAudiences(JSON.stringify({ [SUB]: 'aud-a', [`board.${SUB}`]: 'aud-a' }));
    expect(m instanceof Map && [...m]).toEqual([
      [SUB, 'aud-a'],
      [`board.${SUB}`, 'aud-a'],
    ]);
  });

  it('refuses the whole value on any bad part', () => {
    for (const raw of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ 'Harborlight.Test': 'aud-a' }),
      JSON.stringify({ [`${SUB}:443`]: 'aud-a' }),
      JSON.stringify({ [SUB]: '' }),
      JSON.stringify({ [SUB]: 7 }),
      JSON.stringify({ [SUB]: 'aud a' }),
    ]) {
      expect(parseHostAudiences(raw) instanceof Map).toBe(false);
    }
  });
});

describe('createCfAccessVerifier with hostAudiences', () => {
  let jwks: JSONWebKeySet;
  let sign: (aud: string) => Promise<string>;
  const req = (host: string, token: string) =>
    new Request(`https://${host}/workspaces/w-1`, {
      headers: { host, 'cf-access-jwt-assertion': token },
    });

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = (await exportJWK(publicKey)) as JWK;
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    jwks = { keys: [jwk] };
    sign = (aud) =>
      new SignJWT({ email: 'owner@harborlight.test' })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .sign(privateKey);
  });

  it('checks a named host against its own audience only, port and case ignored', async () => {
    const verify = createCfAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: 'aud-one',
      hostAudiences: new Map([[SUB, 'aud-sub']]),
      jwks,
    });
    expect((await verify(req(SUB, await sign('aud-sub')))).ok).toBe(true);
    expect((await verify(req(`HARBORLIGHT.${ONE}:443`, await sign('aud-sub')))).ok).toBe(true);
    expect((await verify(req(SUB, await sign('aud-one')))).ok).toBe(false);
  });

  it('falls back to the static audience for a host it does not name', async () => {
    const verify = createCfAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: 'aud-one',
      hostAudiences: new Map([[SUB, 'aud-sub']]),
      jwks,
    });
    expect((await verify(req(ONE, await sign('aud-one')))).ok).toBe(true);
    expect((await verify(req(ONE, await sign('aud-sub')))).ok).toBe(false);
  });

  it('wins over a per-share resolver for the host it names', async () => {
    const verify = createCfAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: () => null,
      hostAudiences: new Map([[SUB, 'aud-sub']]),
      jwks,
    });
    expect((await verify(req(SUB, await sign('aud-sub')))).ok).toBe(true);
    expect((await verify(req(ONE, await sign('aud-sub')))).ok).toBe(false);
  });
});

describe('CF_ACCESS_HOST_AUDS in the server config', () => {
  it('rides on cfAccess as a map', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cw-host-auds-'));
    try {
      const cfg = resolveServerConfig({
        env: {
          CW_DATA_DIR: join(repoRoot, 'data'),
          CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
          CF_ACCESS_AUD: 'aud-one',
          CF_ACCESS_HOST_AUDS: JSON.stringify({ [SUB]: 'aud-sub' }),
        },
        repoRoot,
        arg: (_n, f) => f,
      });
      expect(cfg.cfAccess?.audience).toBe('aud-one');
      expect([...(cfg.cfAccess?.hostAudiences ?? [])]).toEqual([[SUB, 'aud-sub']]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  /** In a subprocess, because the refusal is `process.exit(1)`. */
  const boot = async (env: Record<string, string>) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        '-e',
        [
          "const m = await import('./packages/server/src/server-config.ts');",
          'm.resolveServerConfig({',
          "  env: { CW_DATA_DIR: '/tmp/cw-config-data', ...JSON.parse(process.env.CW_TEST_ENV_JSON) },",
          '  repoRoot: process.cwd(),',
          '  arg: (_n, f) => f,',
          '});',
          "console.log('booted');",
        ].join(''),
      ],
      {
        cwd: new URL('../../..', import.meta.url).pathname,
        env: { ...process.env, CW_TEST_ENV_JSON: JSON.stringify(env) },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  };
  const BASE = { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: 'aud-one' };

  it('refuses to start on a malformed value', async () => {
    const r = await boot({ ...BASE, CF_ACCESS_HOST_AUDS: '{"Not A Host": "aud-sub"}' });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('booted');
    expect(r.err).toContain('CF_ACCESS_HOST_AUDS');
  });

  it("refuses to start when a host's audience is the share application's", async () => {
    const r = await boot({
      ...BASE,
      CW_SHARE_LINK_HOSTS: 'share.harborlight.test',
      CF_ACCESS_SHARE_AUD: 'aud-share',
      CF_ACCESS_HOST_AUDS: JSON.stringify({ [SUB]: 'aud-share' }),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('CF_ACCESS_SHARE_AUD');
  });

  it('CONTROL: starts with a well-formed value beside a separate share application', async () => {
    const r = await boot({
      ...BASE,
      CW_SHARE_LINK_HOSTS: 'share.harborlight.test',
      CF_ACCESS_SHARE_AUD: 'aud-share',
      CF_ACCESS_HOST_AUDS: JSON.stringify({ [SUB]: 'aud-sub' }),
    });
    expect({ code: r.code, booted: r.out.includes('booted') }).toEqual({ code: 0, booted: true });
  });
});
