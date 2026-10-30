/**
 * The per-project settings `machine:deploy` gives a project's server, so a
 * new board needs no hand-typed `fly secrets set`:
 *
 *   CW_OWNER_EMAIL            the Keychain's `cw-board-owner-email`
 *   CW_PUBLIC_BASE_URL        https:// and the project's first host in access.local.json
 *   CF_ACCESS_TEAM_DOMAIN     the account's Access organization (`auth_domain`)
 *   CF_ACCESS_AUD             the audience of the Access application `board <project>`
 *   CF_ACCESS_HOST_AUDS       each of the project's hosts, to that audience
 *   CW_PROXIED_TRUSTED_HOSTS  the project's hosts, so the owner is admitted on them
 *
 * The server admits the owner on a proxied host only with all four Access
 * settings and an owner address (`packages/server/src/server-config.ts`). A
 * setting whose source is missing is skipped with a line saying why, never
 * guessed: a project with no Access application yet still gets the rest.
 *
 * Values are read into memory and handed to `fly secrets import` on stdin.
 * Nothing here prints one; a dry run prints names and sources.
 */
import { readFileSync } from 'node:fs';
import { hostAudiencesFor, parseAccessConfig } from '../access-apps/access-plan.ts';
import type { CloudflareApi } from './cloudflare.ts';

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
  /** `infra/access-apps/access.local.json`, or another file of its shape. */
  accessConfigPath: string;
  /** Made only when the project is in the access config. */
  cloudflare: () => CloudflareApi;
  keychainHas: (name: string) => boolean;
  keychainRead: (name: string) => string;
}

interface AccessApp {
  id: string;
  name: string;
  aud?: string;
}

/** Read every source. Reads only: Cloudflare GETs, Keychain reads, one file. */
export async function readSettings(project: string, src: SettingsSources): Promise<SettingsRead> {
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

  let raw: string | null = null;
  try {
    raw = readFileSync(src.accessConfigPath, 'utf8');
  } catch {
    raw = null;
  }
  const access = raw === null ? null : parseAccessConfig(raw);
  const p = access?.projects[project];
  if (!access || !p) {
    const why = access ? `has no project ${project}` : 'does not exist';
    skipped.push(`CW_PUBLIC_BASE_URL, ${ACCESS_NAMES}: ${src.accessConfigPath} ${why}`);
    return { settings, skipped };
  }
  const host = p.hosts[0] as string;
  settings.push({
    name: 'CW_PUBLIC_BASE_URL',
    from: `access.local.json, ${project}'s first host`,
    value: () => `https://${host}`,
  });

  const api = src.cloudflare();
  const accounts = await api.all<{ id: string }>('/accounts');
  const account = accounts[0];
  if (accounts.length !== 1 || !account) {
    throw new Error(`the Cloudflare token sees ${accounts.length} accounts; it must see one`);
  }
  const name = `board ${project}`;
  const apps = (await api.all<AccessApp>(`/accounts/${account.id}/access/apps`)).filter(
    (a) => a.name === name,
  );
  if (apps.length === 0) {
    skipped.push(
      `${ACCESS_NAMES}: Cloudflare has no Access application "${name}" yet (bun run access:apply --apply)`,
    );
    return { settings, skipped };
  }
  if (apps.length > 1) throw new Error(`two Access applications are named "${name}"`);
  const aud = apps[0]?.aud;
  if (!aud) throw new Error(`the Access application "${name}" has no aud`);
  const org = await api<{ auth_domain?: string }>(
    'GET',
    `/accounts/${account.id}/access/organizations`,
  );
  const team = org.auth_domain;
  if (!team) throw new Error("the account's Access organization has no auth_domain");
  const hostAuds = JSON.stringify(hostAudiencesFor(access, [project], () => aud));
  settings.push(
    {
      name: 'CF_ACCESS_TEAM_DOMAIN',
      from: "Cloudflare, the account's Access organization",
      value: () => team,
    },
    { name: 'CF_ACCESS_AUD', from: `Cloudflare, Access application "${name}"`, value: () => aud },
    {
      name: 'CF_ACCESS_HOST_AUDS',
      from: `access.local.json's hosts of ${project}, each to the aud of "${name}"`,
      value: () => hostAuds,
    },
    {
      name: 'CW_PROXIED_TRUSTED_HOSTS',
      from: `access.local.json's hosts of ${project}`,
      value: () => p.hosts.join(','),
    },
  );
  return { settings, skipped };
}
