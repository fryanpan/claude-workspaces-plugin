import { describe, expect, test } from 'bun:test';
import {
  SECRET_ACCOUNT,
  SECRET_VALUE_MAX_CHARS,
  type SecretRunResult,
  type SecretRunner,
  type SecretWriteFailure,
  secretReadCommand,
  storeSecret,
} from '../src/secret-store.ts';

/** A placeholder that is deliberately not token-shaped — nothing here may
 *  look like a real value, in the source or in a failure message. */
const PLACEHOLDER = 'not-a-real-value-1';

interface Call {
  file: string;
  args: string[];
  stdin: string;
}

/**
 * A stand-in for `security` that RECORDS rather than stores.
 *
 * It is the whole point of the runner being injected: the thing worth
 * asserting is where the value went, and only something standing in the
 * command's place can see that. It answers a read-back with whatever the
 * write put in, so the happy path exercises the verification step for real.
 */
function fakeSecurity(
  overrides: { writeCode?: number; readCode?: number; readStdout?: string } = {},
): { run: SecretRunner; calls: Call[] } {
  const calls: Call[] = [];
  let stored: string | null = null;
  const run: SecretRunner = async (file, args, stdin): Promise<SecretRunResult> => {
    calls.push({ file, args, stdin });
    if (args[0] === 'add-generic-password') {
      const code = overrides.writeCode ?? 0;
      if (code === 0) stored = stdin.split('\n')[0] ?? '';
      return { code, stdout: '', stderr: '' };
    }
    return {
      code: overrides.readCode ?? 0,
      stdout: overrides.readStdout ?? `${stored ?? ''}\n`,
      stderr: '',
    };
  };
  return { run, calls };
}

describe('the value goes on stdin and nowhere else', () => {
  test('never appears in the argument list', async () => {
    const fake = fakeSecurity();
    expect(await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run)).toEqual({ ok: true });
    for (const call of fake.calls) {
      expect(call.args.join(' ')).not.toContain(PLACEHOLDER);
      expect(call.file).not.toContain(PLACEHOLDER);
    }
    // …and it did travel, so the assertion above is not passing vacuously on
    // a value that never reached the runner at all.
    expect(fake.calls[0]?.stdin).toContain(PLACEHOLDER);
  });

  test('is written twice, because one line stores an empty password', async () => {
    const fake = fakeSecurity();
    await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run);
    expect(fake.calls[0]?.stdin).toBe(`${PLACEHOLDER}\n${PLACEHOLDER}\n`);
  });

  test('passes -w last and with no argument, so the command prompts', async () => {
    const fake = fakeSecurity();
    await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run);
    const args = fake.calls[0]?.args ?? [];
    expect(args).toEqual([
      'add-generic-password',
      '-U',
      '-a',
      SECRET_ACCOUNT,
      '-s',
      'riverbend-weather-key',
      '-w',
    ]);
    expect(args[args.length - 1]).toBe('-w');
  });
});

describe('what it refuses before running anything', () => {
  test.each([
    ['a name that is not a legal service name', 'riverbend weather key', 'bad-service'],
    ['a name that would read as a flag', '-w', 'bad-service'],
  ] as Array<[string, string, SecretWriteFailure]>)('refuses %s', async (_why, service, error) => {
    const fake = fakeSecurity();
    expect(await storeSecret(service, PLACEHOLDER, fake.run)).toEqual({ ok: false, error });
    expect(fake.calls).toHaveLength(0);
  });

  test.each([
    ['an empty value', '', 'bad-value'],
    ['a value carrying a newline', 'line-one\nline-two', 'bad-value'],
    ['a value carrying a carriage return', 'line-one\rline-two', 'bad-value'],
  ] as Array<[string, string, SecretWriteFailure]>)('refuses %s', async (_why, value, error) => {
    const fake = fakeSecurity();
    expect(await storeSecret('riverbend-weather-key', value, fake.run)).toEqual({
      ok: false,
      error,
    });
    expect(fake.calls).toHaveLength(0);
  });

  test('refuses a value past the ceiling', async () => {
    const fake = fakeSecurity();
    const long = 'a'.repeat(SECRET_VALUE_MAX_CHARS + 1);
    expect(await storeSecret('riverbend-weather-key', long, fake.run)).toEqual({
      ok: false,
      error: 'value-too-long',
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('saved means read back, not exit 0', () => {
  test('reports a failure when the store kept something else', async () => {
    // The measured failure mode: the command exits 0 having stored an empty
    // password. Exit code alone would call this a success.
    const fake = fakeSecurity({ readStdout: '\n' });
    expect(await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run)).toEqual({
      ok: false,
      error: 'verify-failed',
    });
  });

  test('reports a failure when the read-back itself fails', async () => {
    const fake = fakeSecurity({ readCode: 44 });
    expect(await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run)).toEqual({
      ok: false,
      error: 'verify-failed',
    });
  });

  test('does not attempt a read-back when the write failed', async () => {
    const fake = fakeSecurity({ writeCode: 1 });
    expect(await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run)).toEqual({
      ok: false,
      error: 'write-failed',
    });
    expect(fake.calls).toHaveLength(1);
  });

  test('a failure tag carries no value', async () => {
    const fake = fakeSecurity({ readStdout: '\n' });
    const res = await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run);
    expect(JSON.stringify(res)).not.toContain(PLACEHOLDER);
  });
});

describe('the read-back command handed to an agent', () => {
  test('names the account and the service and asks for nothing else', () => {
    expect(secretReadCommand('riverbend-weather-key')).toBe(
      `security find-generic-password -a ${SECRET_ACCOUNT} -s riverbend-weather-key -w`,
    );
  });
});
