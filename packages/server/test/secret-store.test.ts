import { describe, expect, test } from 'bun:test';
import {
  SECRET_ACCOUNT,
  SECRET_SERVICE_PREFIX,
  SECRET_VALUE_MAX_CHARS,
  type SecretRunResult,
  type SecretRunner,
  type SecretWriteFailure,
  encodeSecretValue,
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
    expect(fake.calls[0]?.stdin).toContain(encodeSecretValue(PLACEHOLDER));
  });

  test('is written twice, because one line stores an empty password', async () => {
    const fake = fakeSecurity();
    await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run);
    const encoded = encodeSecretValue(PLACEHOLDER);
    expect(fake.calls[0]?.stdin).toBe(`${encoded}\n${encoded}\n`);
  });

  test('sends a MULTI-LINE value as one line, and stores it whole', async () => {
    // The blocker the UX walk found (2026-09-12): a three-line paste — an SSH
    // key, a service-account file — arrived joined into one 52-character line
    // and the item said "Secrets saved". The browser input had stripped the
    // breaks before the server's newline refusal could fire.
    //
    // The value is encoded now, so the prompt sees one line whatever the
    // reader pasted. Measured on macOS 26.2 first: the raw three-line attempt
    // printed "passwords don't match" three times and exited 1 with nothing
    // stored, so joining was never the alternative to refusing — it was the
    // alternative to working.
    const threeLines = 'aaa-not-real-1\nbbb-not-real-2\nccc-not-real-3';
    const fake = fakeSecurity();
    expect(await storeSecret('riverbend-weather-key', threeLines, fake.run)).toEqual({ ok: true });
    // One line to the prompt, twice — the confirm read sees the same thing.
    const stdin = fake.calls[0]?.stdin ?? '';
    expect(stdin.split('\n').filter((l) => l !== '')).toHaveLength(2);
    // …and what went down it decodes back to every line the reader typed. The
    // read-back inside `storeSecret` already compared it; this says the value
    // survived rather than that two equal wrong things were compared.
    const sent = stdin.split('\n')[0] ?? '';
    expect(Buffer.from(sent, 'base64').toString('utf8')).toBe(threeLines);
    expect(Buffer.from(sent, 'base64').toString('utf8').split('\n')).toHaveLength(3);

    // CONTROL: the same runner with a store that hands back something else
    // refuses, so the pass above is the read-back agreeing and not the check
    // being absent.
    const wrong = fakeSecurity({ readStdout: 'c29tZXRoaW5nLWVsc2U=\n' });
    expect(await storeSecret('riverbend-weather-key', threeLines, wrong.run)).toEqual({
      ok: false,
      error: 'verify-failed',
    });
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
      `${SECRET_SERVICE_PREFIX}riverbend-weather-key`,
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
    // A NUL is still refused, and for a reason that is not the prompt's: it
    // cannot survive the shell pipeline an agent reads the value back
    // through, so storing one would be storing something nobody can use.
    ['a value carrying a NUL', 'line-one\u0000line-two', 'bad-value'],
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
  test('names the account and the service and decodes what it gets', () => {
    expect(secretReadCommand('riverbend-weather-key')).toBe(
      `security find-generic-password -a ${SECRET_ACCOUNT} -s ${SECRET_SERVICE_PREFIX}riverbend-weather-key -w | base64 --decode`,
    );
  });

  test('decodes exactly what the writer would have stored', () => {
    // The two halves have to agree or an agent reads a value that is not the
    // one the reader typed — which is the failure encoding could introduce if
    // only one end knew about it. Run the command's own decode over the
    // writer's own encode, on a value with newlines in it.
    const threeLines = 'aaa-not-real-1\nbbb-not-real-2\nccc-not-real-3';
    expect(secretReadCommand('riverbend-weather-key')).toContain('base64 --decode');
    expect(Buffer.from(encodeSecretValue(threeLines), 'base64').toString('utf8')).toBe(threeLines);
  });
});

describe('the namespace a stored name lands in', () => {
  /**
   * THE KEYCHAIN HAS NO FOLDERS. `share/keychain.ts` reads this server's own
   * configuration out of the same store by service name, and its lookup falls
   * back to any account — so an item asking for `cloudflare-api-token` would
   * otherwise write the entry the server later reads as its own. The prefix is
   * what makes that unreachable, and these cases are about the name that
   * actually reaches the command rather than the one the card showed.
   */
  test("a name that collides with the server's own configuration is stored elsewhere", async () => {
    const fake = fakeSecurity();
    await storeSecret('cloudflare-api-token', PLACEHOLDER, fake.run);
    const written = fake.calls[0]?.args ?? [];
    expect(written).toContain(`${SECRET_SERVICE_PREFIX}cloudflare-api-token`);
    // The bare name reaches no argument of either command, on its own.
    expect(written).not.toContain('cloudflare-api-token');
    expect(fake.calls[1]?.args ?? []).not.toContain('cloudflare-api-token');
  });

  test('the read-back reads the same entry the write wrote', async () => {
    const fake = fakeSecurity();
    await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run);
    const wroteAt = (fake.calls[0]?.args ?? []).indexOf('-s');
    const readAt = (fake.calls[1]?.args ?? []).indexOf('-s');
    expect(fake.calls[0]?.args[wroteAt + 1]).toBe(fake.calls[1]?.args[readAt + 1] ?? '');
    // And it is the namespaced one, not the bare name, on both.
    expect(fake.calls[0]?.args[wroteAt + 1]).toBe(`${SECRET_SERVICE_PREFIX}riverbend-weather-key`);
  });
});
