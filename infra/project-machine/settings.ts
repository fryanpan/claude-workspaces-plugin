/**
 * The per-project settings `machine:deploy` gives a project's server, so a
 * new board needs no hand-typed `fly secrets set`:
 *
 *   CW_OWNER_EMAIL            the Keychain's `cw-board-owner-email`
 *   CW_PUBLIC_BASE_URL        https:// and the project's first Access host
 *   CF_ACCESS_TEAM_DOMAIN     the account's Access organization (`auth_domain`)
 *   CF_ACCESS_AUD             the audience of the Access application `board <project>`
 *   CF_ACCESS_HOST_AUDS       each of the project's hosts, to that audience
 *   CW_PROXIED_TRUSTED_HOSTS  the project's hosts, so the owner is admitted on them
 *
 * And, for Better Auth sign-in (`packages/server/src/auth/board-signin.ts`),
 * the one Google client every machine shares, from the Keychain, plus this
 * machine's own sign-in origin:
 *
 *   CW_GOOGLE_CLIENT_ID       the Keychain's `cw-google-signin-client-id`
 *   CW_GOOGLE_CLIENT_SECRET   the Keychain's `cw-google-signin-client-secret`
 *   CW_SIGNIN_ORIGIN          https:// and the project's first host
 *
 * And for email and password beside Google (`board-signin-password.ts`),
 * all four from the Keychain or none:
 *
 *   CW_TURNSTILE_SITE_KEY     the Keychain's `cw-turnstile-site-key`
 *   CW_TURNSTILE_SECRET_KEY   the Keychain's `cw-turnstile-secret-key`
 *   CW_RESEND_API_KEY         the Keychain's `cw-resend-api-key` (send-only)
 *   CW_SIGNIN_MAIL_FROM       the Keychain's `cw-signin-mail-from`
 *
 * These do not switch sign-in on: `CW_SIGNIN` stays unset (Access) until the
 * owner switches it. Google sends a sign-in result only to a return address
 * the client lists, so a run that sets the client prints the one this
 * machine names (`notes`), for the owner to add in Google's console.
 *
 * All but the first come from the Terraform outputs (`infra/cloudflare/outputs.ts`),
 * so this asks Cloudflare nothing. The server admits the owner on a proxied
 * host only with all four Access settings and an owner address
 * (`packages/server/src/server-config.ts`). A setting whose source is missing
 * is skipped with a line saying why, never guessed: a project with no Access
 * application yet still gets the rest.
 *
 * Values are read into memory and handed to `fly secrets import` on stdin.
 * Nothing here prints one; a dry run prints names and sources.
 */
import { SIGNIN_BASE_PATH } from '../../packages/server/src/auth/board-signin.ts';
import type { TfOutputs } from '../cloudflare/outputs.ts';

export const OWNER_EMAIL_ENTRY = 'cw-board-owner-email';
export const GOOGLE_CLIENT_ID_ENTRY = 'cw-google-signin-client-id';
export const GOOGLE_CLIENT_SECRET_ENTRY = 'cw-google-signin-client-secret';

/** Each password sign-in setting, and the Keychain entry it comes from. */
export const PASSWORD_ENTRIES = {
  CW_TURNSTILE_SITE_KEY: 'cw-turnstile-site-key',
  CW_TURNSTILE_SECRET_KEY: 'cw-turnstile-secret-key',
  CW_RESEND_API_KEY: 'cw-resend-api-key',
  CW_SIGNIN_MAIL_FROM: 'cw-signin-mail-from',
} as const;

export const SETTING_NAMES = [
  'CW_OWNER_EMAIL',
  'CW_PUBLIC_BASE_URL',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_AUD',
  'CF_ACCESS_HOST_AUDS',
  'CW_PROXIED_TRUSTED_HOSTS',
] as const;

/**
 * The sign-in settings. Kept off `SETTING_NAMES`, which the wall-drift report
 * compares against a server's environment: a client secret is not a value
 * that report should read back.
 */
export const SIGNIN_SETTING_NAMES = [
  'CW_GOOGLE_CLIENT_ID',
  'CW_GOOGLE_CLIENT_SECRET',
  'CW_SIGNIN_ORIGIN',
  ...(Object.keys(PASSWORD_ENTRIES) as (keyof typeof PASSWORD_ENTRIES)[]),
] as const;

const ACCESS_NAMES =
  'CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, CF_ACCESS_HOST_AUDS and CW_PROXIED_TRUSTED_HOSTS';

export interface Setting {
  name: (typeof SETTING_NAMES)[number] | (typeof SIGNIN_SETTING_NAMES)[number];
  /** Where the value comes from, for the dry run. Never the value. */
  from: string;
  value: () => string;
}

export interface SettingsRead {
  settings: Setting[];
  /** One line per setting left unset, and why. */
  skipped: string[];
  /** Lines for the owner to act on: the Google return address to register. */
  notes: string[];
}

export interface SettingsSources {
  /** The Terraform outputs; may throw when the state cannot be read. */
  outputs: () => TfOutputs;
  keychainHas: (name: string) => boolean;
  keychainRead: (name: string) => string;
}

/** A project machine's sign-in host: its Access application's first host. */
export function signInHost(outputs: TfOutputs, project: string): string | null {
  return outputs.access[project]?.hosts[0] ?? null;
}

/** Where Google returns a sign-in at `host`. */
export const googleRedirectUri = (host: string): string =>
  `https://${host}${SIGNIN_BASE_PATH}/callback/google`;

/** Read every source. Reads only: Keychain reads and the Terraform outputs. */
export function readSettings(project: string, src: SettingsSources): SettingsRead {
  const settings: Setting[] = [];
  const skipped: string[] = [];
  if (src.keychainHas(OWNER_EMAIL_ENTRY)) {
    settings.push({
      name: 'CW_OWNER_EMAIL',
      from: `Keychain ${OWNER_EMAIL_ENTRY}`,
      value: () => src.keychainRead(OWNER_EMAIL_ENTRY).trim(),
    });
  } else {
    skipped.push(`CW_OWNER_EMAIL: the Keychain has no ${OWNER_EMAIL_ENTRY}`);
  }
  const google = [GOOGLE_CLIENT_ID_ENTRY, GOOGLE_CLIENT_SECRET_ENTRY].every(src.keychainHas);
  if (google) {
    settings.push(
      {
        name: 'CW_GOOGLE_CLIENT_ID',
        from: `Keychain ${GOOGLE_CLIENT_ID_ENTRY}`,
        value: () => src.keychainRead(GOOGLE_CLIENT_ID_ENTRY).trim(),
      },
      {
        name: 'CW_GOOGLE_CLIENT_SECRET',
        from: `Keychain ${GOOGLE_CLIENT_SECRET_ENTRY}`,
        value: () => src.keychainRead(GOOGLE_CLIENT_SECRET_ENTRY).trim(),
      },
    );
  } else {
    skipped.push(
      `CW_GOOGLE_CLIENT_ID, CW_GOOGLE_CLIENT_SECRET, CW_SIGNIN_ORIGIN: the Keychain has no ${GOOGLE_CLIENT_ID_ENTRY} and ${GOOGLE_CLIENT_SECRET_ENTRY}`,
    );
  }
  const password = Object.entries(PASSWORD_ENTRIES) as [keyof typeof PASSWORD_ENTRIES, string][];
  if (password.every(([, entry]) => src.keychainHas(entry))) {
    for (const [name, entry] of password) {
      settings.push({
        name,
        from: `Keychain ${entry}`,
        value: () => src.keychainRead(entry).trim(),
      });
    }
  } else {
    skipped.push(
      `${password.map(([n]) => n).join(', ')}: the Keychain needs all of ${password.map(([, e]) => e).join(', ')}`,
    );
  }
  const notes: string[] = [];

  let outputs: TfOutputs;
  try {
    outputs = src.outputs();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    skipped.push(
      `CW_PUBLIC_BASE_URL, ${ACCESS_NAMES}: could not read the Terraform outputs (${why})`,
    );
    return { settings, skipped, notes };
  }
  const p = outputs.access[project];
  const host = signInHost(outputs, project);
  if (!p || !host) {
    skipped.push(
      `CW_PUBLIC_BASE_URL, ${ACCESS_NAMES}: the Terraform state has no Access application for ${project} (add it to access.local.json; bun run cf:sync-config)`,
    );
    return { settings, skipped, notes };
  }
  settings.push({
    name: 'CW_PUBLIC_BASE_URL',
    from: `Terraform output access, ${project}'s first host`,
    value: () => `https://${host}`,
  });
  if (google) {
    settings.push({
      name: 'CW_SIGNIN_ORIGIN',
      from: `Terraform output access, ${project}'s first host`,
      value: () => `https://${host}`,
    });
    notes.push(
      `Google sign-in returns to ${googleRedirectUri(host)}: add it to the shared client's authorized redirect URIs in Google's console`,
    );
  }
  const team = outputs.accessTeamDomain;
  if (!team) {
    skipped.push(`${ACCESS_NAMES}: the Terraform output access_team_domain is empty`);
    return { settings, skipped, notes };
  }
  const hostAuds = JSON.stringify(Object.fromEntries(p.hosts.map((h) => [h, p.aud])));
  const from = `Terraform output access, board ${project}`;
  settings.push(
    {
      name: 'CF_ACCESS_TEAM_DOMAIN',
      from: 'Terraform output access_team_domain',
      value: () => team,
    },
    { name: 'CF_ACCESS_AUD', from: `${from}'s audience`, value: () => p.aud },
    {
      name: 'CF_ACCESS_HOST_AUDS',
      from: `${from}'s hosts, each to its audience`,
      value: () => hostAuds,
    },
    { name: 'CW_PROXIED_TRUSTED_HOSTS', from: `${from}'s hosts`, value: () => p.hosts.join(',') },
  );
  return { settings, skipped, notes };
}
