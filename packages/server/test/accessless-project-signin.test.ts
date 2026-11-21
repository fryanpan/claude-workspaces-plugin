/**
 * A project with no Access application, deployed with what `machine:deploy`
 * derives (`infra/project-machine/settings.ts`), serves a browser the sign-in
 * page on its router host. Before, it set no trusted host and no `CW_SIGNIN`,
 * and the host answered every browser 403 unknown_host.
 *
 * The settings go through `resolveServerConfig` and into a real server the
 * way bin.ts hands them over, reached the way the tunnel reaches it. The
 * Keychain and the Terraform outputs are stand-ins; Google is never called.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import {
  GOOGLE_CLIENT_ID_ENTRY,
  GOOGLE_CLIENT_SECRET_ENTRY,
  OWNER_EMAIL_ENTRY,
  readSettings,
} from '../../../infra/project-machine/settings.ts';
import { resolveServerConfig } from '../src/server-config.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const HOST = 'harborlight-workspaces.riverbend.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC', 'x-forwarded-proto': 'https' };
const outputs = (): TfOutputs => ({
  access: {},
  accessTeamDomain: 'riverbend.cloudflareaccess.test',
  tunnels: {},
  routerRoutes: { harborlight: `${HOST}/*` },
});
const OWNER = { [OWNER_EMAIL_ENTRY]: 'owner@riverbend.test' };
const CLIENT = {
  [GOOGLE_CLIENT_ID_ENTRY]: 'shared-client',
  [GOOGLE_CLIENT_SECRET_ENTRY]: 'stub-secret',
};

describe('a project with no Access application', () => {
  const dirs: string[] = [];
  const handles: ServerHandle[] = [];
  afterAll(async () => {
    for (const h of handles) await h.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** A server booted from what machine:deploy would set with this Keychain. */
  function deployed(entries: Record<string, string>): ServerHandle {
    const found = readSettings('harborlight', {
      outputs,
      keychainHas: (n) => n in entries,
      keychainRead: (n) => entries[n] ?? '',
    });
    const env = Object.fromEntries(found.settings.map((s) => [s.name, s.value()]));
    const repoRoot = mkdtempSync(join(tmpdir(), 'accessless-'));
    dirs.push(repoRoot);
    const dataDir = join(repoRoot, 'data');
    const cfg = resolveServerConfig({
      env: { CW_DATA_DIR: dataDir, ...env },
      repoRoot,
      arg: (_n, fallback) => fallback,
    });
    // As bin.ts passes them.
    const handle = createServer({
      port: 0,
      dataDir,
      proxiedTrustedHosts: cfg.proxiedTrustedReady ? cfg.proxiedTrustedHosts : [],
      proxiedTrustedEmails: cfg.proxiedTrustedEmails,
      ...(cfg.signIn ? { signIn: cfg.signIn } : {}),
    });
    handles.push(handle);
    return handle;
  }
  const pageLoad = (h: ServerHandle) =>
    fetch(`http://127.0.0.1:${h.port}/workspaces`, {
      redirect: 'manual',
      headers: { host: HOST, ...CF_RAY, accept: 'text/html' },
    });

  it('sends a browser on its router host to the sign-in page', async () => {
    const res = await pageLoad(deployed({ ...OWNER, ...CLIENT }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `/auth/sign-in?next=${encodeURIComponent('/workspaces')}`,
    );
  });

  it('CONTROL: deployed by a run without the Google client, it boots and still refuses', async () => {
    // fly-provision's state until the Mac's machine:deploy adds the client.
    const res = await pageLoad(deployed(OWNER));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'unknown_host' });
  });
});
