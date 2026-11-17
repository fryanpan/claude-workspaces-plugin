/**
 * The state bucket's credential when the person typed it into the board's
 * secret card instead of the `cloudflare-r2-tfstate` JSON entry
 * (`infra/cloudflare/credentials.ts`).
 *
 * Hermetic: the first half hands `stateCredentials` an in-memory Keychain;
 * the second puts a stand-in `security` first on PATH so the real readers in
 * `infra/project-machine/mac-ops.ts` run against it. The real Keychain is
 * never asked. Values are fixtures, and every error is checked for them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CredentialSources,
  STATE_CARD_ID_ENTRY,
  STATE_CARD_SECRET_ENTRY,
  STATE_ENTRY,
  stateCredentials,
  tfCredentials,
} from '../../../infra/cloudflare/credentials.ts';
import { keeperInput } from '../../../infra/cloudflare/keeper-wrapper.ts';
import { keychainHas, keychainRead } from '../../../infra/project-machine/mac-ops.ts';

const CARD_ID = 'Harborlight-state-key-id';
const CARD_SECRET = 'Riverbend-state-secret';
const JSON_ID = 'Saltmarsh-json-key-id';
const JSON_SECRET = 'Saltmarsh-json-secret';
const VALUES = [CARD_ID, CARD_SECRET, JSON_ID, JSON_SECRET];

function sources(entries: Record<string, string>): CredentialSources {
  return {
    env: {},
    keychainHas: (n) => n in entries,
    keychainRead: (n) => {
      const v = entries[n];
      if (v === undefined) throw new Error(`Keychain has no entry ${n}`);
      return v;
    },
  };
}

const CARD = { [STATE_CARD_ID_ENTRY]: CARD_ID, [STATE_CARD_SECRET_ENTRY]: CARD_SECRET };
const JSON_ENTRY = {
  [STATE_ENTRY]: JSON.stringify({ accessKeyId: JSON_ID, secretAccessKey: JSON_SECRET }),
};

/** The thrown message, checked to carry no fixture value. */
function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const msg = (err as Error).message;
    for (const v of VALUES) expect(msg).not.toContain(v);
    return msg;
  }
  throw new Error('expected a throw');
}

describe('stateCredentials from the secret card', () => {
  it('takes both card entries when the JSON entry is absent', () => {
    expect(stateCredentials(sources(CARD))).toEqual({
      AWS_ACCESS_KEY_ID: CARD_ID,
      AWS_SECRET_ACCESS_KEY: CARD_SECRET,
    });
  });

  it('keeps the JSON entry first when both exist', () => {
    expect(stateCredentials(sources({ ...CARD, ...JSON_ENTRY }))).toEqual({
      AWS_ACCESS_KEY_ID: JSON_ID,
      AWS_SECRET_ACCESS_KEY: JSON_SECRET,
    });
  });

  it('keeps the environment first over both', () => {
    const src = sources({ ...CARD, ...JSON_ENTRY });
    src.env = { AWS_ACCESS_KEY_ID: 'env-id', AWS_SECRET_ACCESS_KEY: 'env-secret' };
    expect(stateCredentials(src).AWS_ACCESS_KEY_ID).toBe('env-id');
  });

  it('trims what the card stored', () => {
    const src = sources({
      [STATE_CARD_ID_ENTRY]: ` ${CARD_ID}\n`,
      [STATE_CARD_SECRET_ENTRY]: `${CARD_SECRET}\n`,
    });
    expect(stateCredentials(src)).toEqual({
      AWS_ACCESS_KEY_ID: CARD_ID,
      AWS_SECRET_ACCESS_KEY: CARD_SECRET,
    });
  });

  it('names the one missing card entry, and reads no value', () => {
    for (const [present, absent] of [
      [STATE_CARD_ID_ENTRY, STATE_CARD_SECRET_ENTRY],
      [STATE_CARD_SECRET_ENTRY, STATE_CARD_ID_ENTRY],
    ] as const) {
      const reads: string[] = [];
      const src = sources({ [present]: CARD[present] });
      const read = src.keychainRead;
      src.keychainRead = (n) => {
        reads.push(n);
        return read(n);
      };
      const msg = errorOf(() => stateCredentials(src));
      expect(msg).toContain(absent);
      expect(msg).toContain(STATE_ENTRY);
      expect(msg).not.toContain(present);
      expect(reads).toEqual([]);
    }
  });

  it('names every source when nothing is set', () => {
    const msg = errorOf(() => stateCredentials(sources({})));
    for (const n of [
      'AWS_ACCESS_KEY_ID',
      STATE_ENTRY,
      STATE_CARD_ID_ENTRY,
      STATE_CARD_SECRET_ENTRY,
    ])
      expect(msg).toContain(n);
  });

  it('refuses an empty card entry by name', () => {
    const msg = errorOf(() =>
      stateCredentials(sources({ [STATE_CARD_ID_ENTRY]: CARD_ID, [STATE_CARD_SECRET_ENTRY]: ' ' })),
    );
    expect(msg).toContain(STATE_CARD_SECRET_ENTRY);
    expect(msg).not.toContain(STATE_CARD_ID_ENTRY);
  });

  it('reaches tfCredentials (cf:plan without the keeper, and the CI apply)', () => {
    const creds = tfCredentials(sources({ ...CARD, 'cloudflare-api-token': 'tok' }));
    expect(creds.env.AWS_ACCESS_KEY_ID).toBe(CARD_ID);
    expect(creds.env.AWS_SECRET_ACCESS_KEY).toBe(CARD_SECRET);
  });

  it('reaches the keeper request (cf:plan and cf:sync-config through the keeper)', () => {
    const src = sources(CARD);
    const input = keeperInput('prod', { ...src, read: () => null });
    expect(JSON.parse(input).state).toEqual({ accessKeyId: CARD_ID, secretAccessKey: CARD_SECRET });
  });
});

describe('the Mac readers find the card entries', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cf-state-card-'));
  const bin = join(tmp, 'bin');
  const calls = join(tmp, 'calls');
  const names = [
    'PATH',
    'CW_SECRETS_FROM_ENV',
    'CW_SECRET_R2_TFSTATE_ACCESS_KEY_ID',
    'CW_SECRET_R2_TFSTATE_SECRET_ACCESS_KEY',
  ];
  const saved = names.map((n) => process.env[n]);
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  beforeAll(() => {
    mkdirSync(bin);
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    // Answers only the card's two services under the secret store's prefix
    // and account; anything else (the JSON entry included) is absent.
    const script = [
      '#!/bin/sh',
      `echo "$@" >> ${calls}`,
      '[ "$1" = find-generic-password ] && [ "$2" = -a ] && [ "$3" = claude-workspaces ] || exit 44',
      'case "$5" in',
      `  claude-workspaces-secret.${STATE_CARD_ID_ENTRY}) v=${b64(CARD_ID)} ;;`,
      `  claude-workspaces-secret.${STATE_CARD_SECRET_ENTRY}) v=${b64(CARD_SECRET)} ;;`,
      '  *) exit 44 ;;',
      'esac',
      '[ "$6" = -w ] && echo "$v"',
      'exit 0',
      '',
    ].join('\n');
    writeFileSync(join(bin, 'security'), script);
    chmodSync(join(bin, 'security'), 0o755);
    process.env.PATH = `${bin}:${saved[0] ?? ''}`;
    for (const n of names.slice(1)) restore(n, undefined);
  });

  afterAll(() => {
    names.forEach((n, i) => restore(n, saved[i]));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('decodes the card pair through mac-ops, and never puts a value in an argument', () => {
    expect(stateCredentials({ env: {}, keychainHas, keychainRead })).toEqual({
      AWS_ACCESS_KEY_ID: CARD_ID,
      AWS_SECRET_ACCESS_KEY: CARD_SECRET,
    });
    const log = readFileSync(calls, 'utf8');
    expect(log).toContain(`-s claude-workspaces-secret.${STATE_ENTRY}`);
    expect(log).toContain(`-s claude-workspaces-secret.${STATE_CARD_ID_ENTRY} -w`);
    expect(log).toContain(`-s claude-workspaces-secret.${STATE_CARD_SECRET_ENTRY} -w`);
    for (const v of VALUES) expect(log).not.toContain(v);
  });
});
