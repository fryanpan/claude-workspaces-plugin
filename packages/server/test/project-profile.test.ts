/**
 * A project server spends only its own org's Claude key, holds no other
 * org's credential, and runs the features its profile allows. Every key
 * here is a fake string; nothing reads a Keychain.
 */
import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_CALL_PATHS,
  claudeSlotTrace,
  resetClaudeSlotTrace,
} from '../src/claude-key-slot.ts';
import {
  ACCESS_TOKEN_ENV,
  EVAL_KEYCHAIN_SERVICE,
  EVAL_KEY_ENV,
  KEYCHAIN_SERVICE,
  KEYCHAIN_SERVICE_LEGACY,
  LAUNCHD_JOB_ENV,
  PROD_SERVICE_LABEL,
  claudeKeyServices,
  describeClaudeKey,
  isProdService,
} from '../src/claude-key-source.ts';
import {
  FEATURE_CREDENTIAL_ENV,
  FOREIGN_CREDENTIAL_ENV,
  ORG_KEY_ENV,
  SPOKEN_OFF_LINE,
  TRANSCRIPTION_OFF_LINE,
  featureOn,
  featuresOff,
  ghHostsPath,
  isProjectServer,
  projectProfile,
  scrubForeignCredentials,
  spokenOffLine,
} from '../src/project-profile.ts';
import { ENV_VAR as RECALL_ENV_VAR } from '../src/recall.ts';
import { keychainRunnerFor } from '../src/share/keychain.ts';
import { createSpokenEngines } from '../src/spoken-reply/engines.ts';
import {
  ELEVENLABS_AGENT_ID_ENV_VAR,
  ELEVENLABS_AGENT_LLM_ENV_VAR,
  ELEVENLABS_ENV_VAR,
  GEMINI_ENV_VAR,
} from '../src/spoken-reply/keys.ts';
import { availableSetups } from '../src/spoken-reply/session.ts';
import { resolveCredentialSlotFrom, resolveKeySlotFrom } from '../src/summarize.ts';
import { ENV_VAR as ASSEMBLYAI_ENV_VAR } from '../src/transcribe-assemblyai.ts';
import { SONIOX_ENV_VAR } from '../src/transcribe-soniox.ts';

/** Every other credential a careless deploy could hand a project server. */
const POLLUTED = {
  ANTHROPIC_API_KEY: 'fake-generic',
  [EVAL_KEY_ENV]: 'fake-eval',
  CLAUDE_WORKSPACES_SUMMARY_API_KEY: 'fake-prod',
  [ACCESS_TOKEN_ENV]: 'fake-token',
  GH_TOKEN: 'fake-gh',
  GITHUB_TOKEN: 'fake-gh2',
};

/** A reader that answers every Keychain item, and counts what it was asked. */
function greedyReader() {
  const asked: string[] = [];
  return {
    asked,
    read: (service: string) => {
      asked.push(service);
      return `fake-from-${service}`;
    },
  };
}

describe('which machine is a project server', () => {
  it('is a Fly machine, or one that names a profile, and never the Mac', () => {
    expect(isProjectServer({ FLY_APP_NAME: 'cw-harborlight' })).toBe(true);
    expect(isProjectServer({ CW_PROJECT_PROFILE: 'standard' })).toBe(true);
    expect(isProjectServer({ [LAUNCHD_JOB_ENV]: PROD_SERVICE_LABEL })).toBe(false);
    expect(isProjectServer({})).toBe(false);
  });

  it('is never the prod service, even with the launchd label in its environment', () => {
    expect(isProdService({ [LAUNCHD_JOB_ENV]: PROD_SERVICE_LABEL, FLY_APP_NAME: 'cw-x' })).toBe(
      false,
    );
  });
});

describe('the Claude key on a project server', () => {
  const project = { FLY_APP_NAME: 'cw-riverbend', ...POLLUTED };

  it('spends the org key, and asks no Keychain item for it', () => {
    resetClaudeSlotTrace();
    const r = greedyReader();
    const got = resolveKeySlotFrom('review-gate', undefined, r.read, {
      ...project,
      [ORG_KEY_ENV]: 'fake-org',
    });
    expect(got).toEqual({ key: 'fake-org', slot: { name: ORG_KEY_ENV, role: 'org' } });
    expect(r.asked).toEqual([]);
  });

  it('with no org key, refuses every call path, whatever else it holds', () => {
    resetClaudeSlotTrace();
    const r = greedyReader();
    for (const path of CLAUDE_CALL_PATHS) {
      expect(resolveKeySlotFrom(path, undefined, r.read, project)).toBeNull();
      expect(resolveCredentialSlotFrom(path, undefined, r.read, project)).toBeNull();
    }
    expect(r.asked).toEqual([]);
    expect(claudeSlotTrace().every((u) => u.slot === null)).toBe(true);
    expect(claudeSlotTrace()).toHaveLength(CLAUDE_CALL_PATHS.length);
  });

  it('says why in the boot line, naming the variable and never a value', () => {
    const line = describeClaudeKey(project, greedyReader().read);
    expect(line).toContain('every Claude call is refused');
    expect(line).toContain(ORG_KEY_ENV);
    expect(line).not.toContain('fake');
    expect(describeClaudeKey({ ...project, [ORG_KEY_ENV]: 'fake-org' }, () => null)).toContain(
      "this org's key",
    );
  });

  it('leaves the Mac as it was: prod reads prod items, everything else the eval item', () => {
    // The positive control: the same reader DOES answer off a project server.
    const prod = { [LAUNCHD_JOB_ENV]: PROD_SERVICE_LABEL };
    expect(claudeKeyServices(prod)).toEqual([KEYCHAIN_SERVICE, KEYCHAIN_SERVICE_LEGACY]);
    expect(claudeKeyServices({})).toEqual([EVAL_KEYCHAIN_SERVICE]);
    const r = greedyReader();
    expect(resolveKeySlotFrom('review-gate', undefined, r.read, prod)?.slot.role).toBe('prod');
    expect(resolveKeySlotFrom('review-gate', undefined, r.read, {})?.slot.role).toBe('eval');
    expect(r.asked).toEqual([KEYCHAIN_SERVICE, EVAL_KEYCHAIN_SERVICE]);
  });
});

describe('the Keychain on a project server', () => {
  it('is never run', () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: 'fake' };
    };
    expect(keychainRunnerFor({ FLY_APP_NAME: 'cw-x' }, run)(['find-generic-password'])).toEqual({
      status: 1,
      stdout: '',
    });
    expect(calls).toEqual([]);
    expect(keychainRunnerFor({}, run)(['find-generic-password']).status).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe('a project server holds no other org’s key and no gh login', () => {
  it('removes them from its environment and names what it removed', () => {
    const env: Record<string, string | undefined> = {
      FLY_APP_NAME: 'cw-saltmarsh',
      [ORG_KEY_ENV]: 'fake-org',
      ...POLLUTED,
    };
    const removed = scrubForeignCredentials(env);
    expect(removed.sort()).toEqual(Object.keys(POLLUTED).sort());
    for (const name of FOREIGN_CREDENTIAL_ENV) expect(env[name]).toBeUndefined();
    expect(env[ORG_KEY_ENV]).toBe('fake-org');
  });

  it('removes nothing on the Mac', () => {
    const env: Record<string, string | undefined> = { ...POLLUTED };
    expect(scrubForeignCredentials(env)).toEqual([]);
    expect(env).toEqual(POLLUTED);
  });

  it('lists the names the Claude and vendor readers actually read', () => {
    expect(FOREIGN_CREDENTIAL_ENV).toContain(EVAL_KEY_ENV);
    expect(FOREIGN_CREDENTIAL_ENV).toContain(ACCESS_TOKEN_ENV);
    const prodOverride = (s: string) => s.toUpperCase().replace(/-/g, '_');
    expect(FOREIGN_CREDENTIAL_ENV).toContain(prodOverride(KEYCHAIN_SERVICE));
    expect(FOREIGN_CREDENTIAL_ENV).toContain(prodOverride(KEYCHAIN_SERVICE_LEGACY));
    expect(FEATURE_CREDENTIAL_ENV.transcription).toEqual([
      SONIOX_ENV_VAR,
      ASSEMBLYAI_ENV_VAR,
      RECALL_ENV_VAR,
    ]);
    expect(FEATURE_CREDENTIAL_ENV.voice).toEqual([
      ELEVENLABS_ENV_VAR,
      ELEVENLABS_AGENT_ID_ENV_VAR,
      ELEVENLABS_AGENT_LLM_ENV_VAR,
    ]);
    expect(FEATURE_CREDENTIAL_ENV.gemini).toEqual([GEMINI_ENV_VAR]);
  });

  it('finds gh’s login file where gh would', () => {
    expect(ghHostsPath({}, '/home/cw')).toBe('/home/cw/.config/gh/hosts.yml');
    expect(ghHostsPath({ XDG_CONFIG_HOME: '/x' }, '/home/cw')).toBe('/x/gh/hosts.yml');
    expect(ghHostsPath({ GH_CONFIG_DIR: '/g/' }, '/home/cw')).toBe('/g/hosts.yml');
  });
});

describe('the claude-only profile', () => {
  const env = { FLY_APP_NAME: 'cw-x', CW_PROJECT_PROFILE: 'Claude-Only' };

  it('turns transcription, voice and Gemini off, and the pages get a line for each', () => {
    expect(projectProfile(env)?.name).toBe('claude-only');
    for (const f of ['transcription', 'voice', 'gemini'] as const) {
      expect(featureOn(env, f)).toBe(false);
    }
    const off = featuresOff(env);
    expect(off.transcription).toBe(TRANSCRIPTION_OFF_LINE);
    expect(off.spoken).toBe(SPOKEN_OFF_LINE);
    expect(spokenOffLine(new Set(['gemini']))).toBe('Gemini Live is off on this server.');
    expect(spokenOffLine(new Set())).toBeUndefined();
  });

  it('builds no spoken setup even with every key present, and reads none of them', () => {
    const cards: string[][] = [];
    const engines = createSpokenEngines(null, () => {}, {
      env: {
        [SONIOX_ENV_VAR]: 'fake-s',
        [ELEVENLABS_ENV_VAR]: 'fake-e',
        [GEMINI_ENV_VAR]: 'fake-g',
        CW_ELEVENLABS_TRAINING_OFF: '1',
      },
      readSoniox: () => 'fake-s',
      readCard: (args) => {
        cards.push(args);
        return { status: 1, stdout: '' };
      },
      off: { transcription: true, voice: true, gemini: true },
    });
    expect(availableSetups(engines)).toEqual([]);
    expect(engines.held).toBeUndefined();
    expect(cards).toEqual([]);
  });

  it('is the control: the same keys with nothing off do build setups', () => {
    const engines = createSpokenEngines(null, () => {}, {
      env: {
        [SONIOX_ENV_VAR]: 'fake-s',
        [ELEVENLABS_ENV_VAR]: 'fake-e',
        [GEMINI_ENV_VAR]: 'fake-g',
        CW_ELEVENLABS_TRAINING_OFF: '1',
      },
      readSoniox: () => 'fake-s',
      readCard: () => ({ status: 1, stdout: '' }),
    });
    expect(availableSetups(engines).length).toBeGreaterThan(0);
  });

  it('turns everything off for a label nobody wrote down, and nothing on the Mac', () => {
    const typo = { FLY_APP_NAME: 'cw-x', CW_PROJECT_PROFILE: 'standrad' };
    expect(projectProfile(typo)?.known).toBe(false);
    expect(featureOn(typo, 'transcription')).toBe(false);
    expect(featureOn({ FLY_APP_NAME: 'cw-x' }, 'transcription')).toBe(true);
    expect(featureOn({}, 'gemini')).toBe(true);
    expect(featuresOff({})).toEqual({});
  });
});
