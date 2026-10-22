/**
 * What a PROJECT server may spend, and which features it runs.
 *
 * A project server is one org's board server on its own machine. Each holds
 * only its own credentials and its org's Anthropic key. The Mac's prod and
 * every dev server on the Mac are not project servers, and nothing in this
 * module changes what they do.
 *
 * HOW ONE IS RECOGNISED. Fly sets `FLY_APP_NAME` in every machine it starts,
 * so a Fly machine is a project server with no setting of its own — the same
 * reasoning `claude-key-source.ts` gives for the launchd label. A machine
 * somewhere else says so with `CW_PROJECT_PROFILE`, which also names the
 * feature profile. Neither variable is set on the Mac.
 *
 * WHAT CHANGES ON ONE:
 *  - Claude calls spend `CW_ORG_ANTHROPIC_API_KEY` and nothing else. No
 *    Keychain item, no eval key, no `ANTHROPIC_API_KEY`, no access token.
 *    With no org key every Claude call is refused, and the boot log says so.
 *  - Every credential another org could own, and every gh login, is removed
 *    from the process environment at boot, so no child the server spawns
 *    inherits one (`scrubForeignCredentials`).
 *  - The profile turns features off. An off feature is not built even when
 *    its key is present, and the pages say it is off.
 *
 * Pure apart from `scrubForeignCredentials`, which edits the env it is given.
 */
import type { EnvLike } from '@claude-workspaces/core/env-names';

/** Names the feature profile, and marks a machine as a project server. */
export const PROJECT_PROFILE_ENV = 'CW_PROJECT_PROFILE';

/** Set by Fly in every machine it runs. */
export const FLY_APP_ENV = 'FLY_APP_NAME';

/** The one Claude credential a project server reads: its own org's key. */
export const ORG_KEY_ENV = 'CW_ORG_ANTHROPIC_API_KEY';

/** The features a profile can turn off. Claude is not one: the org key
 *  turns it on or off. */
export type ProjectFeature = 'transcription' | 'voice' | 'gemini';

export const PROJECT_FEATURES: readonly ProjectFeature[] = ['transcription', 'voice', 'gemini'];

/**
 * The profiles, by label. `standard` runs every feature whose key is present.
 * `claude-only` runs none of the three, for an org that holds no
 * transcription, ElevenLabs or Gemini key. A label names what the profile
 * does, never the org that runs it: this repo is public.
 */
export const PROJECT_PROFILES: Readonly<Record<string, readonly ProjectFeature[]>> = {
  standard: [],
  'claude-only': ['transcription', 'voice', 'gemini'],
};

/** The profile a Fly machine runs when it names none. */
export const DEFAULT_PROFILE = 'standard';

export interface ProjectProfile {
  /** The label, lowercased. An unknown label is kept so the log can name it. */
  readonly name: string;
  /** Whether the label is in `PROJECT_PROFILES`. */
  readonly known: boolean;
  readonly off: ReadonlySet<ProjectFeature>;
}

/** Is this process a project server? */
export function isProjectServer(env: EnvLike): boolean {
  return Boolean(env[PROJECT_PROFILE_ENV]?.trim() || env[FLY_APP_ENV]?.trim());
}

/**
 * This process's profile, or null on the Mac.
 *
 * An unknown label turns every feature off. A typo must not turn on a
 * feature that sends an org's words to a vendor the org has no key for.
 */
export function projectProfile(env: EnvLike): ProjectProfile | null {
  if (!isProjectServer(env)) return null;
  const name = (env[PROJECT_PROFILE_ENV]?.trim() || DEFAULT_PROFILE).toLowerCase();
  const listed = PROJECT_PROFILES[name];
  return {
    name,
    known: listed !== undefined,
    off: new Set(listed ?? PROJECT_FEATURES),
  };
}

/** Whether `feature` runs here. Always true on the Mac. */
export function featureOn(env: EnvLike, feature: ProjectFeature): boolean {
  return !projectProfile(env)?.off.has(feature);
}

/** What the pages say about the features a profile turned off. */
export interface FeaturesOff {
  /** The doc page's Record Audio button. */
  readonly transcription?: string;
  /** The board mic's spoken reply. */
  readonly spoken?: string;
}

export const TRANSCRIPTION_OFF_LINE =
  'Transcription is off on this server, so meetings cannot be recorded here.';

/** The spoken-reply line, naming whichever of voice and Gemini are off. */
export function spokenOffLine(off: ReadonlySet<ProjectFeature>): string | undefined {
  const names = [
    off.has('voice') ? 'ElevenLabs voices' : '',
    off.has('gemini') ? 'Gemini Live' : '',
  ].filter((s) => s);
  if (names.length === 0) return undefined;
  return `Spoken replies with ${names.join(' and ')} are off on this server.`;
}

/** The lines for this process, or an empty object on the Mac. */
export function featuresOff(env: EnvLike): FeaturesOff {
  const profile = projectProfile(env);
  if (!profile) return {};
  const spoken = spokenOffLine(profile.off);
  return {
    ...(profile.off.has('transcription') ? { transcription: TRANSCRIPTION_OFF_LINE } : {}),
    ...(spoken ? { spoken } : {}),
  };
}

/**
 * Credentials a project server never holds, whatever its profile: the Mac's
 * Claude items and their env overrides, the CI access token, and every gh
 * login. Each is the name `readKeychainPassword` or gh itself reads; the
 * project-profile test holds the Claude ones to their source constants.
 */
export const FOREIGN_CREDENTIAL_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_WORKSPACES_EVAL_API_KEY',
  'CLAUDE_WORKSPACES_SUMMARY_API_KEY',
  'LIVE_FEEDBACK_SUMMARY_API_KEY',
  'CW_SUMMARY_ACCESS_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

/** The keys an off feature would read. Removed too, so an off feature cannot
 *  be turned back on by a secret somebody set. */
export const FEATURE_CREDENTIAL_ENV: Readonly<Record<ProjectFeature, readonly string[]>> = {
  transcription: ['SONIOX_API_KEY', 'ASSEMBLYAI_API_KEY', 'CLAUDE_WORKSPACES_RECALL_API_KEY'],
  voice: ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'CW_ELEVENLABS_AGENT_LLM_SECRET'],
  gemini: ['GEMINI_API_KEY'],
};

/** The variables this process must not hold, given its profile. */
export function credentialsNotAllowed(profile: ProjectProfile): string[] {
  return [
    ...FOREIGN_CREDENTIAL_ENV,
    ...PROJECT_FEATURES.filter((f) => profile.off.has(f)).flatMap((f) => FEATURE_CREDENTIAL_ENV[f]),
  ];
}

/**
 * Remove every credential this project server must not hold from `env`, and
 * return the NAMES removed — never a value. Does nothing on the Mac.
 */
export function scrubForeignCredentials(env: EnvLike): string[] {
  const profile = projectProfile(env);
  if (!profile) return [];
  const removed: string[] = [];
  for (const name of credentialsNotAllowed(profile)) {
    if (env[name] === undefined) continue;
    Reflect.deleteProperty(env, name);
    removed.push(name);
  }
  return removed;
}

/**
 * Where gh keeps a login: `$GH_CONFIG_DIR/hosts.yml`, else
 * `$XDG_CONFIG_HOME/gh/hosts.yml`, else `~/.config/gh/hosts.yml`.
 */
export function ghHostsPath(env: EnvLike, home: string): string {
  const dir =
    env.GH_CONFIG_DIR?.trim() ||
    `${env.XDG_CONFIG_HOME?.trim() || `${home.replace(/\/+$/, '')}/.config`}/gh`;
  return `${dir.replace(/\/+$/, '')}/hosts.yml`;
}

/**
 * The boot's lines for a project server: which profile it runs, what it
 * removed, and whether a gh login file is on disk. Empty on the Mac. Names
 * only. A gh login on disk is reported, not deleted: it is a file a person
 * put there, and removing it is that person's call.
 */
export function describeProjectServer(
  env: EnvLike,
  removed: readonly string[],
  ghLoginOnDisk: string | null,
): string[] {
  const profile = projectProfile(env);
  if (!profile) return [];
  const off = PROJECT_FEATURES.filter((f) => profile.off.has(f));
  const lines = [
    `[project] project server, profile "${profile.name}"` +
      (profile.known ? '' : ' (unknown, so every optional feature is off)') +
      `: ${off.length > 0 ? `${off.join(', ')} off` : 'every feature on whose key is set'}.`,
  ];
  if (removed.length > 0) {
    lines.push(
      `[project] removed from this server's environment, because a project server holds no other org's key and no gh login: ${removed.join(', ')}.`,
    );
  }
  if (ghLoginOnDisk) {
    lines.push(
      `[project] ERROR: a gh login is on disk at ${ghLoginOnDisk}. A project server holds no gh login; remove it.`,
    );
  }
  return lines;
}
