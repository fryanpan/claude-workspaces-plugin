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
import type { TfOutputs } from '../cloudflare/outputs.ts';

export const OWNER_EMAIL_ENTRY = 'cw-board-owner-email';

export const SETTING_NAMES = [
  'CW_OWNER_EMAIL',
  'CW_PUBLIC_BASE_URL',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_AUD',
  'CF_ACCESS_HOST_AUDS',
  'CW_PROXIED_TRUSTED_HOSTS',
] as const;

const ACCESS_NAMES =
  'CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, CF_ACCESS_HOST_AUDS and CW_PROXIED_TRUSTED_HOSTS';

export interface Setting {
  name: (typeof SETTING_NAMES)[number];
  /** Where the value comes from, for the dry run. Never the value. */
  from: string;
  value: () => string;
}

export interface SettingsRead {
  settings: Setting[];
  /** One line per setting left unset, and why. */
  skipped: string[];
}

export interface SettingsSources {
  /** The Terraform outputs; may throw when the state cannot be read. */
  outputs: () => TfOutputs;
  keychainHas: (name: string) => boolean;
  keychainRead: (name: string) => string;
}

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

  let outputs: TfOutputs;
  try {
    outputs = src.outputs();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    skipped.push(
      `CW_PUBLIC_BASE_URL, ${ACCESS_NAMES}: could not read the Terraform outputs (${why})`,
    );
    return { settings, skipped };
  }
  const p = outputs.access[project];
  const host = p?.hosts[0];
  if (!p || !host) {
    skipped.push(
      `CW_PUBLIC_BASE_URL, ${ACCESS_NAMES}: the Terraform state has no Access application for ${project} (add it to access.local.json; bun run cf:apply)`,
    );
    return { settings, skipped };
  }
  settings.push({
    name: 'CW_PUBLIC_BASE_URL',
    from: `Terraform output access, ${project}'s first host`,
    value: () => `https://${host}`,
  });
  const team = outputs.accessTeamDomain;
  if (!team) {
    skipped.push(`${ACCESS_NAMES}: the Terraform output access_team_domain is empty`);
    return { settings, skipped };
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
  return { settings, skipped };
}
