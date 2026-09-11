/**
 * A server that is not the prod launchd service never reads prod's Claude
 * key — it spends the eval key or none — and the prod service still reads its
 * own with no configuration change.
 *
 * Every lookup goes through an injected reader or through
 * `readKeychainPassword`'s env override, so no real Keychain is touched, and
 * every value here is a fake.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  ACCESS_TOKEN_ENV,
  EVAL_KEYCHAIN_SERVICE,
  EVAL_KEY_ENV,
  KEYCHAIN_SERVICE,
  KEYCHAIN_SERVICE_LEGACY,
  LAUNCHD_JOB_ENV,
  PROD_SERVICE_LABEL,
  claudeKeyAddHint,
  describeClaudeKey,
  isProdService,
  withoutProdMarker,
} from '../src/claude-key-source.ts';
import { LAUNCHD_LABEL } from '../src/deploy.ts';
import { ThreadSummarizer, resolveCredentialFrom, resolveKeyFrom } from '../src/summarize.ts';

const PROD_ENV = { [LAUNCHD_JOB_ENV]: PROD_SERVICE_LABEL };

/** A keychain holding what the test says and recording what was asked for.
 *  A missing item throws, exactly as `readKeychainPassword` does. */
function keychain(items: Record<string, string>) {
  const asked: string[] = [];
  const read = (service: string): string => {
    asked.push(service);
    const value = items[service];
    if (value === undefined) throw new Error(`no such item: ${service}`);
    return value;
  };
  return { read, asked };
}

/** Both prod items present, so a refusal below is a refusal and not an absence. */
const PROD_ITEMS = {
  [KEYCHAIN_SERVICE]: 'fake-prod-key',
  [KEYCHAIN_SERVICE_LEGACY]: 'fake-legacy-prod-key',
};

describe('isProdService — only the launchd job named by the plist label', () => {
  it('is the job deploy.ts restarts', () => {
    expect(PROD_SERVICE_LABEL).toBe(LAUNCHD_LABEL);
    expect(isProdService(PROD_ENV)).toBe(true);
  });

  it('is false for everything a shell, staging, a test or CI carries', () => {
    for (const value of [
      undefined,
      '',
      '0',
      'application.com.apple.Terminal.fictional-session',
      `${PROD_SERVICE_LABEL}.staging`,
      ` ${PROD_SERVICE_LABEL}`,
      'com.fryanpan.live-feedback',
    ]) {
      expect(isProdService({ [LAUNCHD_JOB_ENV]: value })).toBe(false);
    }
    // CW_DATA_DIR is not the marker: pointing a run at prod's corpus is
    // something scripts do on purpose.
    expect(isProdService({ CW_DATA_DIR: '/fictional/prod/data' })).toBe(false);
  });
});

describe('resolveKeyFrom — the lookup every Claude adapter goes through', () => {
  it('outside prod, refuses prod’s key even when it is present', () => {
    const k = keychain(PROD_ITEMS);
    expect(resolveKeyFrom(undefined, k.read, {})).toBeNull();
    // Refused by never ASKING, not by asking and discarding.
    expect(k.asked).toEqual([EVAL_KEYCHAIN_SERVICE]);
  });

  it('outside prod, spends the eval key', () => {
    const k = keychain({ ...PROD_ITEMS, [EVAL_KEYCHAIN_SERVICE]: 'fake-eval-key' });
    expect(resolveKeyFrom(undefined, k.read, {})).toBe('fake-eval-key');
    expect(k.asked).toEqual([EVAL_KEYCHAIN_SERVICE]);
  });

  it('under the prod service’s marker, reads prod’s key and not the eval key', () => {
    const k = keychain({ ...PROD_ITEMS, [EVAL_KEYCHAIN_SERVICE]: 'fake-eval-key' });
    expect(resolveKeyFrom(undefined, k.read, PROD_ENV)).toBe('fake-prod-key');
    expect(k.asked).toEqual([KEYCHAIN_SERVICE]);
  });

  it('the credential form follows the same rule', () => {
    const k = keychain({ ...PROD_ITEMS, [EVAL_KEYCHAIN_SERVICE]: 'fake-eval-key' });
    expect(resolveCredentialFrom(undefined, k.read, {})).toEqual({
      kind: 'key',
      value: 'fake-eval-key',
    });
    expect(resolveCredentialFrom(undefined, k.read, PROD_ENV)).toEqual({
      kind: 'key',
      value: 'fake-prod-key',
    });
    const none = keychain(PROD_ITEMS);
    expect(resolveCredentialFrom(undefined, none.read, {})).toBeNull();
    expect(none.asked).toEqual([EVAL_KEYCHAIN_SERVICE]);
  });
});

describe('a real summarizer, resolving through the real Keychain reader', () => {
  // `readKeychainPassword` answers from an item's env override before it
  // shells out, so planting BOTH overrides keeps this off the real Keychain
  // while driving the production lookup end to end.
  const PROD_OVERRIDE = KEYCHAIN_SERVICE.toUpperCase().replace(/-/g, '_');
  const saved = {
    job: process.env[LAUNCHD_JOB_ENV],
    prod: process.env[PROD_OVERRIDE],
    evalKey: process.env[EVAL_KEY_ENV],
    flag: process.env.CW_SUMMARIES,
  };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  };
  afterEach(() => {
    restore(LAUNCHD_JOB_ENV, saved.job);
    restore(PROD_OVERRIDE, saved.prod);
    restore(EVAL_KEY_ENV, saved.evalKey);
    restore('CW_SUMMARIES', saved.flag);
  });

  /** Which key header one brief call went out with. */
  async function keySent(): Promise<string | null> {
    let sent: string | null = null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sent = new Headers(init?.headers).get('x-api-key');
      return new Response(
        JSON.stringify({ content: [{ text: 'a brief' }], stop_reason: 'end_turn' }),
      );
    }) as unknown as typeof fetch;
    const s = new ThreadSummarizer({ fetchImpl });
    await s.generateHomeBrief({ system: 's', user: 'u' });
    s.dispose();
    return sent;
  }

  it('a non-prod server sends the eval key, with prod’s key sitting right there', async () => {
    process.env.CW_SUMMARIES = '1';
    process.env[PROD_OVERRIDE] = 'fake-prod-key';
    process.env[EVAL_KEY_ENV] = 'fake-eval-key';
    Reflect.deleteProperty(process.env, LAUNCHD_JOB_ENV);
    expect(await keySent()).toBe('fake-eval-key');
  });

  it('the prod service sends prod’s key', async () => {
    process.env.CW_SUMMARIES = '1';
    process.env[PROD_OVERRIDE] = 'fake-prod-key';
    process.env[EVAL_KEY_ENV] = 'fake-eval-key';
    process.env[LAUNCHD_JOB_ENV] = PROD_SERVICE_LABEL;
    expect(await keySent()).toBe('fake-prod-key');
  });
});

describe('describeClaudeKey — the one boot line', () => {
  it('outside prod with no eval key: runs without Claude and says so, naming the eval item', () => {
    const k = keychain(PROD_ITEMS);
    const line = describeClaudeKey({}, k.read);
    expect(line).toContain('running without Claude');
    expect(line).toContain(EVAL_KEYCHAIN_SERVICE);
    expect(line).not.toContain(KEYCHAIN_SERVICE);
    expect(k.asked).toEqual([EVAL_KEYCHAIN_SERVICE]);
  });

  it('outside prod with an eval key: names the eval item and no value', () => {
    const line = describeClaudeKey({}, keychain({ [EVAL_KEYCHAIN_SERVICE]: 'fake-eval-key' }).read);
    expect(line).toContain(`the eval key (${EVAL_KEYCHAIN_SERVICE})`);
    expect(line).not.toContain('fake-eval-key');
  });

  it('a CI access token with no eval key: says notes spend the token, not "no Claude"', () => {
    const env = { [ACCESS_TOKEN_ENV]: 'fake-run-token' };
    const line = describeClaudeKey(env, keychain(PROD_ITEMS).read);
    expect(line).toContain(`meeting notes spend the access token in ${ACCESS_TOKEN_ENV}`);
    expect(line).not.toContain('running without Claude');
    expect(line).not.toContain('fake-run-token');
    // And the notes composer's own resolver agrees that the token is live.
    expect(resolveCredentialFrom(undefined, keychain({}).read, env)).toEqual({
      kind: 'token',
      value: 'fake-run-token',
    });
  });

  it('prod names prod’s item, and its hint when the item is missing', () => {
    expect(describeClaudeKey(PROD_ENV, keychain(PROD_ITEMS).read)).toContain(
      `prod's key (${KEYCHAIN_SERVICE})`,
    );
    expect(describeClaudeKey(PROD_ENV, keychain({}).read)).toContain(claudeKeyAddHint(PROD_ENV));
  });
});

describe('withoutProdMarker', () => {
  it('drops the marker and nothing else, without touching its input', () => {
    const env = { ...PROD_ENV, CW_SUMMARIES: '1' };
    expect(withoutProdMarker(env)).toEqual({ CW_SUMMARIES: '1' });
    expect(isProdService(env)).toBe(true);
  });
});
