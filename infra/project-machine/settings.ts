/**
 * The per-project settings `machine:deploy` gives a project's server, so a
 * new board needs no hand-typed `fly secrets set`:
 *
 *   CW_OWNER_EMAIL            the Keychain's `cw-board-owner-email`
 *   CW_PUBLIC_BASE_URL        https:// and the project's router host
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
 *   CW_SIGNIN_ORIGIN          https:// and the project's router host, set
 *                             with or without the client
 *
 * And for email and password beside Google (`board-signin-password.ts`),
 * all four from the Keychain or none:
 *
 *   CW_TURNSTILE_SITE_KEY     the Keychain's `cw-turnstile-site-key`
 *   CW_TURNSTILE_SECRET_KEY   the Keychain's `cw-turnstile-secret-key`
 *   CW_RESEND_API_KEY         the Keychain's `cw-resend-api-key` (send-only)
 *   CW_SIGNIN_MAIL_FROM       the Keychain's `cw-signin-mail-from`
 *
 * A project with an Access application keeps `CW_SIGNIN` unset (Access)
 * until the owner switches it. A project with none (every new one) has
 * nothing else in front of it, so it also gets
 *
 *   CW_PROXIED_TRUSTED_HOSTS  its router host, the CW_SIGNIN_ORIGIN host
 *   CW_SIGNIN                 `better-auth`, only when the run holds the
 *                             Google client (the server will not boot
 *                             without one)
 *
 * Google sends a sign-in result only to a return address
 * the client lists, so a run that sets the client prints the one this
 * machine names (`notes`), for the owner to add in Google's console.
 *
 * All but the first come from the Terraform outputs (`infra/cloudflare/outputs.ts`),
 * so this asks Cloudflare nothing. The server admits the owner on a proxied
 * host only with all four Access settings and an owner address
 * (`packages/server/src/server-config.ts`). A setting whose source is missing
 * is skipped with a line saying why, never guessed: a project with no Access
 * application still gets the rest.
 *
 * The router host is `projectHost(label, oneAddress)`, the name the board
 * router Worker routes for the project (`signInHost`). Sign-in is Better
 * Auth, so a new project gets no Access application; its address comes from
 * the routing Terraform already does, not from Access.
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
  'CW_SIGNIN',
  'CW_GOOGLE_CLIENT_ID',
  'CW_GOOGLE_CLIENT_SECRET',
  'CW_SIGNIN_ORIGIN',
  ...(Object.keys(PASSWORD_ENTRIES) as (keyof typeof PASSWORD_ENTRIES)[]),
] as const;

const ACCESS_ONLY_NAMES = 'CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD and CF_ACCESS_HOST_AUDS';
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

export type SignInHost = { host: string; from: string } | { error: string };

/**
 * A project machine's sign-in host: its router host, `projectHost(label,
 * oneAddress)` in `infra/cloudflare/vars.ts`. Terraform outputs it as the
 * project's tunnel `public_host` and as its router route (`<host>/*`).
 * A project whose route is not in the outputs keeps its Access application's
 * first host, the address it had before. Where both exist and differ, no host:
 * an existing project's address is never moved by a deploy.
 */
export function signInHost(outputs: TfOutputs, project: string): SignInHost {
  const route = outputs.routerRoutes?.[project];
  const routed =
    outputs.tunnels[project]?.public_host ?? (route?.endsWith('/*') ? route.slice(0, -2) : null);
  const access = outputs.access[project]?.hosts[0] ?? null;
  if (routed && access && routed !== access) {
    return {
      error: `${project}'s router host ${routed} and its Access host ${access} differ; set CW_SIGNIN_ORIGIN by hand`,
    };
  }
  if (routed) return { host: routed, from: `Terraform output, ${project}'s router host` };
  if (access) return { host: access, from: `Terraform output access, ${project}'s first host` };
  return {
    error: `the Terraform state routes no host for ${project} (add it to router.local.json; bun run cf:sync-config)`,
  };
}

/**
 * A project with no Access application: the server admits a browser on its
 * router host only behind Better Auth, so that host is trusted from the same
 * source as CW_SIGNIN_ORIGIN, and sign-in is turned on when this run holds
 * the Google client. Without the client CW_SIGNIN stays unset, because the
 * server refuses to boot on `better-auth` with no client; the Mac's next
 * `machine:deploy` sets both.
 */
function betterAuthSettings(
  signIn: SignInHost,
  google: boolean,
  settings: Setting[],
  skipped: string[],
): void {
  if ('error' in signIn) {
    skipped.push(`CW_PROXIED_TRUSTED_HOSTS, CW_SIGNIN: ${signIn.error}`);
    return;
  }
  const { host, from } = signIn;
  settings.push({ name: 'CW_PROXIED_TRUSTED_HOSTS', from, value: () => host });
  if (google) {
    settings.push({
      name: 'CW_SIGNIN',
      from: 'no Access application, and the Google client is set',
      value: () => 'better-auth',
    });
  } else {
    skipped.push(
      `CW_SIGNIN: better-auth needs ${GOOGLE_CLIENT_ID_ENTRY} and ${GOOGLE_CLIENT_SECRET_ENTRY}, which this run does not hold; the Mac's machine:deploy sets it`,
    );
  }
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
      `CW_GOOGLE_CLIENT_ID, CW_GOOGLE_CLIENT_SECRET: the Keychain has no ${GOOGLE_CLIENT_ID_ENTRY} and ${GOOGLE_CLIENT_SECRET_ENTRY}`,
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
      `CW_PUBLIC_BASE_URL, CW_SIGNIN_ORIGIN, CW_SIGNIN, ${ACCESS_NAMES}: could not read the Terraform outputs (${why})`,
    );
    return { settings, skipped, notes };
  }
  const signIn = signInHost(outputs, project);
  if ('error' in signIn) {
    skipped.push(`CW_PUBLIC_BASE_URL, CW_SIGNIN_ORIGIN: ${signIn.error}`);
  } else {
    const { host, from } = signIn;
    // The origin is set without the client: it is not a secret, password
    // sign-in needs it too, and fly-provision's sealing job reads no Keychain.
    settings.push(
      { name: 'CW_PUBLIC_BASE_URL', from, value: () => `https://${host}` },
      { name: 'CW_SIGNIN_ORIGIN', from, value: () => `https://${host}` },
    );
    if (google) {
      notes.push(
        `Google sign-in returns to ${googleRedirectUri(host)}: add it to the shared client's authorized redirect URIs in Google's console`,
      );
    }
  }
  const p = outputs.access[project];
  if (!p) {
    // Sign-in is Better Auth: a new project is given no Access application.
    skipped.push(
      `${ACCESS_ONLY_NAMES}: the Terraform state has no Access application for ${project}`,
    );
    betterAuthSettings(signIn, google, settings, skipped);
    return { settings, skipped, notes };
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
