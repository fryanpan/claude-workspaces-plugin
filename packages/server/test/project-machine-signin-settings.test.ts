/**
 * `machine:deploy` gives a project the one shared Google client and its own
 * sign-in origin, and names the return address to register at Google (plan
 * step 5). The Keychain and the Terraform outputs are stand-ins.
 */
import { describe, expect, it } from 'bun:test';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import {
  GOOGLE_CLIENT_ID_ENTRY,
  GOOGLE_CLIENT_SECRET_ENTRY,
  OWNER_EMAIL_ENTRY,
  PASSWORD_ENTRIES,
  SETTING_NAMES,
  readSettings,
} from '../../../infra/project-machine/settings.ts';
import { passwordSignInFromEnv } from '../src/auth/board-signin-password.ts';
import { signInFromEnv } from '../src/middleware/signin-door.ts';

const HOST = 'riverbend-workspaces.harborlight.test';
const outputs = (): TfOutputs => ({
  access: { riverbend: { aud: 'aud-riverbend', hosts: [HOST] } },
  accessTeamDomain: 'harborlight.cloudflareaccess.test',
  tunnels: {},
});
const keychain = (entries: Record<string, string>) => ({
  keychainHas: (name: string) => name in entries,
  keychainRead: (name: string) => {
    const v = entries[name];
    if (v === undefined) throw new Error(`no ${name}`);
    return v;
  },
});
const WITH_CLIENT = {
  [OWNER_EMAIL_ENTRY]: 'owner@harborlight.test',
  [GOOGLE_CLIENT_ID_ENTRY]: 'shared-client\n',
  [GOOGLE_CLIENT_SECRET_ENTRY]: 'stub-secret\n',
};

describe('the sign-in settings machine:deploy derives', () => {
  it('sets the shared client and this machine’s own origin, from where they live', () => {
    const found = readSettings('riverbend', { outputs, ...keychain(WITH_CLIENT) });
    const byName = new Map(found.settings.map((s) => [s.name, s]));
    expect(byName.get('CW_GOOGLE_CLIENT_ID')?.value()).toBe('shared-client');
    expect(byName.get('CW_GOOGLE_CLIENT_SECRET')?.value()).toBe('stub-secret');
    expect(byName.get('CW_SIGNIN_ORIGIN')?.value()).toBe(`https://${HOST}`);
    expect(byName.get('CW_GOOGLE_CLIENT_SECRET')?.from).toBe(
      `Keychain ${GOOGLE_CLIENT_SECRET_ENTRY}`,
    );
  });

  it('names the return address to add in Google’s console', () => {
    const found = readSettings('riverbend', { outputs, ...keychain(WITH_CLIENT) });
    expect(found.notes).toEqual([
      expect.stringContaining(`https://${HOST}/api/auth/callback/google`),
    ]);
  });

  it('what it sets is a complete sign-in, once the owner switches CW_SIGNIN', () => {
    const found = readSettings('riverbend', { outputs, ...keychain(WITH_CLIENT) });
    const env = Object.fromEntries(found.settings.map((s) => [s.name, s.value()]));
    // Not switched: deploying the client changes nothing about who signs in.
    expect(signInFromEnv(env)).toEqual({ setting: null });
    expect(signInFromEnv({ ...env, CW_SIGNIN: 'better-auth' })).toEqual({
      setting: {
        mode: 'better-auth',
        origin: `https://${HOST}`,
        google: { clientId: 'shared-client', clientSecret: 'stub-secret' },
      },
    });
  });

  it('skips the client, saying why, when the Keychain has none, and still sets the origin', () => {
    const found = readSettings('riverbend', {
      outputs,
      ...keychain({ [OWNER_EMAIL_ENTRY]: 'owner@harborlight.test' }),
    });
    const names = found.settings.map((s) => s.name);
    expect(names).not.toContain('CW_GOOGLE_CLIENT_ID');
    // The origin is no secret, and the sealing job that reads no Keychain needs it.
    expect(names).toContain('CW_SIGNIN_ORIGIN');
    expect(found.notes).toEqual([]);
    expect(found.skipped).toContainEqual(expect.stringContaining(GOOGLE_CLIENT_ID_ENTRY));
    // CONTROL: the Access settings are still all there.
    expect(names).toContain('CF_ACCESS_AUD');
  });

  describe('the sign-in address is the router address, not an Access host', () => {
    const SALTMARSH = 'saltmarsh-workspaces.harborlight.test';
    const tunnel = (label: string, host: string) => ({
      account_id: 'acct',
      id: `tunnel-${label}`,
      name: `cw-${label}`,
      origin: `${label}-origin.harborlight.test`,
      public_host: host,
    });
    const env = (found: ReturnType<typeof readSettings>) =>
      Object.fromEntries(found.settings.map((s) => [s.name, s.value()]));

    it('a new project with no Access application signs in at its router host', () => {
      const newProject = (): TfOutputs => ({
        ...outputs(),
        tunnels: { saltmarsh: tunnel('saltmarsh', SALTMARSH) },
      });
      const found = readSettings('saltmarsh', { outputs: newProject, ...keychain(WITH_CLIENT) });
      expect(env(found).CW_SIGNIN_ORIGIN).toBe(`https://${SALTMARSH}`);
      expect(env(found).CW_PUBLIC_BASE_URL).toBe(`https://${SALTMARSH}`);
      expect(found.notes).toEqual([
        expect.stringContaining(`https://${SALTMARSH}/api/auth/callback/google`),
      ]);
      // No Access application, so no Access settings, and the run says so.
      expect(found.settings.map((s) => s.name)).not.toContain('CF_ACCESS_AUD');
      expect(found.skipped).toContainEqual(
        expect.stringContaining('no Access application for saltmarsh'),
      );
    });

    it('a project routed by the Worker alone, with no tunnel, signs in there too', () => {
      const macProject = (): TfOutputs => ({
        ...outputs(),
        routerRoutes: { saltmarsh: `${SALTMARSH}/*` },
      });
      const found = readSettings('saltmarsh', { outputs: macProject, ...keychain(WITH_CLIENT) });
      expect(env(found).CW_SIGNIN_ORIGIN).toBe(`https://${SALTMARSH}`);
    });

    it('an existing project keeps the address it has today', () => {
      const existing = (): TfOutputs => ({
        ...outputs(),
        tunnels: { riverbend: tunnel('riverbend', HOST) },
        routerRoutes: { riverbend: `${HOST}/*` },
      });
      const found = readSettings('riverbend', { outputs: existing, ...keychain(WITH_CLIENT) });
      expect(env(found).CW_SIGNIN_ORIGIN).toBe(`https://${HOST}`);
      expect(env(found).CW_PUBLIC_BASE_URL).toBe(`https://${HOST}`);
      // CONTROL: its Access settings are untouched.
      expect(env(found).CF_ACCESS_AUD).toBe('aud-riverbend');
    });

    it('sets no address, and says why, when the Access host and the router host differ', () => {
      const moved = (): TfOutputs => ({
        ...outputs(),
        tunnels: { riverbend: tunnel('riverbend', SALTMARSH) },
      });
      const found = readSettings('riverbend', { outputs: moved, ...keychain(WITH_CLIENT) });
      const names = found.settings.map((s) => s.name);
      expect(names).not.toContain('CW_SIGNIN_ORIGIN');
      expect(names).not.toContain('CW_PUBLIC_BASE_URL');
      expect(found.skipped).toContainEqual(expect.stringContaining('differ'));
      // CONTROL: the Access settings are still set.
      expect(names).toContain('CF_ACCESS_AUD');
    });

    it('sets no address, and says why, for a project nothing routes', () => {
      const found = readSettings('saltmarsh', { outputs, ...keychain(WITH_CLIENT) });
      expect(found.settings.map((s) => s.name)).not.toContain('CW_SIGNIN_ORIGIN');
      expect(found.skipped).toContainEqual(expect.stringContaining('router.local.json'));
    });
  });

  it('keeps the client off the list the wall-drift report reads back', () => {
    expect<readonly string[]>(SETTING_NAMES).not.toContain('CW_GOOGLE_CLIENT_SECRET');
    expect<readonly string[]>(SETTING_NAMES).not.toContain('CW_TURNSTILE_SECRET_KEY');
  });

  it('sets password sign-in from the Keychain, and what it sets turns it on', () => {
    const found = readSettings('riverbend', {
      outputs,
      ...keychain({
        ...WITH_CLIENT,
        [PASSWORD_ENTRIES.CW_TURNSTILE_SITE_KEY]: 'site-key\n',
        [PASSWORD_ENTRIES.CW_TURNSTILE_SECRET_KEY]: 'stub-turnstile-secret\n',
        [PASSWORD_ENTRIES.CW_RESEND_API_KEY]: 'stub-resend-key\n',
        [PASSWORD_ENTRIES.CW_SIGNIN_MAIL_FROM]: 'sign-in@harborlight.test\n',
      }),
    });
    const env = Object.fromEntries(found.settings.map((s) => [s.name, s.value()]));
    expect(env.CW_TURNSTILE_SITE_KEY).toBe('site-key');
    expect(found.settings.find((s) => s.name === 'CW_RESEND_API_KEY')?.from).toBe(
      `Keychain ${PASSWORD_ENTRIES.CW_RESEND_API_KEY}`,
    );
    const password = passwordSignInFromEnv(env);
    if ('error' in password) throw new Error(password.error);
    expect(password.setting?.turnstile.siteKey).toBe('site-key');
  });

  it('skips password sign-in, saying why, unless the Keychain has all four', () => {
    const found = readSettings('riverbend', {
      outputs,
      ...keychain({ ...WITH_CLIENT, [PASSWORD_ENTRIES.CW_TURNSTILE_SITE_KEY]: 'site-key' }),
    });
    const names = found.settings.map((s) => s.name);
    expect(names).not.toContain('CW_TURNSTILE_SITE_KEY');
    expect(found.skipped).toContainEqual(
      expect.stringContaining(PASSWORD_ENTRIES.CW_RESEND_API_KEY),
    );
    // CONTROL: Google sign-in is still set.
    expect(names).toContain('CW_GOOGLE_CLIENT_ID');
  });
});
