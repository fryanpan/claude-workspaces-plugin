import { describe, expect, test } from 'bun:test';
import { secretValueFitsStore } from '@claude-workspaces/core/secret-line';
import {
  SECRET_ACCOUNT,
  SECRET_COMMAND_LINE_BUDGET,
  SECRET_SERVICE_PREFIX,
  SECRET_VALUE_MAX_CHARS,
  type SecretRunResult,
  type SecretRunner,
  type SecretWriteFailure,
  encodeSecretValue,
  secretReadCommand,
  secretValueFits,
  storeSecret,
} from '../src/secret-store.ts';

/** A placeholder that is deliberately not token-shaped — nothing here may
 *  look like a real value, in the source or in a failure message. */
const PLACEHOLDER = 'not-a-real-value-1';

/** A 200-character placeholder: past the 96 characters whose base64 still
 *  fit the old prompt's 128, and nothing like a real key. */
const LONG_PLACEHOLDER = 'not-a-real-value-'.repeat(12).slice(0, 200);

/** The longest service name a review item may declare. */
const LONGEST_SERVICE = `r${'x'.repeat(63)}`;

interface Call {
  file: string;
  args: string[];
  stdin: string;
}

/** The prompt reads at most this much of a line — measured 2026-09-14 with
 *  129, 144 and 200-character inputs, each stored as 128. */
const PROMPT_READ_MAX = 128;
/** `security -i` cuts a command line here and runs the rest as a command of
 *  its own — measured the same day. */
const INTERACTIVE_LINE_MAX = 4095;

/** Split one `security -i` command line into words the way the tool does for
 *  what this module sends: spaces separate, double quotes group, and a quote
 *  left open at a cut line runs to the end. */
function words(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let started = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (ch === ' ' && !quoted) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/**
 * A stand-in for `security` that behaves as the real one was MEASURED to.
 *
 * It is the whole point of the runner being injected: the thing worth
 * asserting is where the value went and what the store kept, and only
 * something standing in the command's place can see both. Both write paths
 * are modelled with their measured caps — the prompt's 128 characters, and
 * interactive mode's 4,095-character line with the remainder run as a command
 * — so the old prompt path, restored into this file, stores a cut key here
 * exactly as it did on the machine.
 */
function modelSecurity(
  overrides: { writeCode?: number; readCode?: number; readStdout?: string } = {},
): { run: SecretRunner; calls: Call[]; store: Map<string, string> } {
  const calls: Call[] = [];
  const store = new Map<string, string>();
  const add = (args: string[], password: string): number => {
    if (overrides.writeCode !== undefined && overrides.writeCode !== 0) return overrides.writeCode;
    store.set(flag(args, '-s') ?? '', password);
    return 0;
  };
  const run: SecretRunner = async (file, args, stdin): Promise<SecretRunResult> => {
    calls.push({ file, args, stdin });
    const [verb] = args;
    if (verb === '-i') {
      let code = 0;
      for (const whole of stdin.split('\n').filter((l) => l !== '')) {
        for (let at = 0; at < whole.length; at += INTERACTIVE_LINE_MAX) {
          const cmd = words(whole.slice(at, at + INTERACTIVE_LINE_MAX));
          if (cmd[0] !== 'add-generic-password') {
            code = 1;
            continue;
          }
          const w = flag(cmd, '-w');
          code = w === undefined ? 1 : add(cmd, w);
        }
      }
      return { code, stdout: '', stderr: '' };
    }
    if (verb === 'add-generic-password') {
      // Prompt mode: two reads, each cut at the prompt's cap. Disagreeing
      // reads store an empty password and still exit 0.
      const [first = '', second = ''] = stdin.split('\n');
      const a = first.slice(0, PROMPT_READ_MAX);
      const b = second.slice(0, PROMPT_READ_MAX);
      return { code: add(args, a === b ? a : ''), stdout: '', stderr: '' };
    }
    const service = flag(args, '-s') ?? '';
    if (verb === 'delete-generic-password') {
      return { code: store.delete(service) ? 0 : 44, stdout: '', stderr: '' };
    }
    const held = store.get(service);
    return {
      code: overrides.readCode ?? (held === undefined ? 44 : 0),
      stdout: overrides.readStdout ?? (held === undefined ? '' : `${held}\n`),
      stderr: '',
    };
  };
  return { run, calls, store };
}

const stored = (service: string) => `${SECRET_SERVICE_PREFIX}${service}`;

describe('the value goes on stdin and nowhere else', () => {
  test('never appears in any argument list, and did travel', async () => {
    const fake = modelSecurity();
    expect(await storeSecret('riverbend-weather-key', LONG_PLACEHOLDER, fake.run)).toEqual({
      ok: true,
    });
    const encoded = encodeSecretValue(LONG_PLACEHOLDER);
    for (const call of fake.calls) {
      for (const needle of [LONG_PLACEHOLDER, encoded]) {
        expect(call.args.join(' ')).not.toContain(needle);
        expect(call.file).not.toContain(needle);
      }
    }
    // The write's whole argument list is the mode switch: the command, and
    // the value in it, are on stdin.
    expect(fake.calls[0]?.args).toEqual(['-i']);
    // …and it did travel, so the assertions above are not passing vacuously
    // on a value that never reached the runner at all.
    expect(fake.calls[0]?.stdin).toContain(encoded);
  });

  test('a failed check deletes by name, still with no value in the arguments', async () => {
    const fake = modelSecurity({ readStdout: '\n' });
    await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run);
    const del = fake.calls.find((c) => c.args[0] === 'delete-generic-password');
    expect(del?.args).toEqual([
      'delete-generic-password',
      '-a',
      SECRET_ACCOUNT,
      '-s',
      stored('riverbend-weather-key'),
    ]);
    expect(del?.stdin).toBe('');
  });

  test('sends one command line whose only reader-supplied part is base64 in quotes', async () => {
    // A value whose encoding is long and uses every character base64 has
    // beyond letters — `+`, `/` and padding — so a quoting slip would show.
    const bytes = String.fromCharCode(...Array.from({ length: 200 }, (_, i) => 0xf8 + (i % 8)));
    const fake = modelSecurity();
    expect(await storeSecret('riverbend-weather-key', bytes, fake.run)).toEqual({ ok: true });
    const lines = (fake.calls[0]?.stdin ?? '').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');
    const encoded = encodeSecretValue(bytes);
    expect(encoded).toMatch(/[+/]/);
    expect(lines[0]).toBe(
      `add-generic-password -U -a ${SECRET_ACCOUNT} -s ${stored('riverbend-weather-key')} -w "${encoded}"`,
    );
    expect(fake.store.get(stored('riverbend-weather-key'))).toBe(encoded);
  });
});

describe('a value of any real length is stored whole', () => {
  test('a 200-character value reads back identical', async () => {
    // The failure of 2026-09-14: a real key of about a hundred characters,
    // base64 past the prompt's 128, stored cut and reported as a failed save.
    const fake = modelSecurity();
    expect(await storeSecret('riverbend-weather-key', LONG_PLACEHOLDER, fake.run)).toEqual({
      ok: true,
    });
    const held = fake.store.get(stored('riverbend-weather-key')) ?? '';
    expect(Buffer.from(held, 'base64').toString('utf8')).toBe(LONG_PLACEHOLDER);
  });

  test('the longest value allowed, under the longest name, fits the line with room to spare', async () => {
    const value = 'n'.repeat(SECRET_VALUE_MAX_CHARS);
    expect(secretValueFits(LONGEST_SERVICE, value)).toBe(true);
    const fake = modelSecurity();
    expect(await storeSecret(LONGEST_SERVICE, value, fake.run)).toEqual({ ok: true });
    const line = (fake.calls[0]?.stdin ?? '').replace(/\n$/, '');
    expect(line.length).toBeLessThanOrEqual(SECRET_COMMAND_LINE_BUDGET);
    expect(SECRET_COMMAND_LINE_BUDGET).toBeLessThan(INTERACTIVE_LINE_MAX);
    expect(Buffer.from(fake.store.get(stored(LONGEST_SERVICE)) ?? '', 'base64').toString()).toBe(
      value,
    );
  });

  test('sends a MULTI-LINE value as one line, and stores it whole', async () => {
    // A three-line paste — an SSH key, a service-account file — is encoded,
    // so the store sees one line whatever the reader pasted.
    const threeLines = 'aaa-not-real-1\nbbb-not-real-2\nccc-not-real-3';
    const fake = modelSecurity();
    expect(await storeSecret('riverbend-weather-key', threeLines, fake.run)).toEqual({ ok: true });
    const held = fake.store.get(stored('riverbend-weather-key')) ?? '';
    expect(Buffer.from(held, 'base64').toString('utf8').split('\n')).toHaveLength(3);
    expect(Buffer.from(held, 'base64').toString('utf8')).toBe(threeLines);
  });
});

describe('what it refuses before running anything', () => {
  test.each([
    ['a name that is not a legal service name', 'riverbend weather key', 'bad-service'],
    ['a name that would read as a flag', '-w', 'bad-service'],
  ] as Array<[string, string, SecretWriteFailure]>)('refuses %s', async (_why, service, error) => {
    const fake = modelSecurity();
    expect(await storeSecret(service, PLACEHOLDER, fake.run)).toEqual({ ok: false, error });
    expect(fake.calls).toHaveLength(0);
  });

  test.each([
    ['an empty value', '', 'bad-value'],
    // A NUL is still refused: it cannot survive the shell pipeline an agent
    // reads the value back through.
    ['a value carrying a NUL', 'line-one\u0000line-two', 'bad-value'],
    [
      'a value past the character ceiling',
      'a'.repeat(SECRET_VALUE_MAX_CHARS + 1),
      'value-too-long',
    ],
    // Within the character count, past the line: each of these encodes to
    // four bytes of base64 per character.
    ['a value of wide characters too long for one line', '\u{1F511}'.repeat(900), 'value-too-long'],
  ] as Array<[string, string, SecretWriteFailure]>)('refuses %s', async (_why, value, error) => {
    const fake = modelSecurity();
    expect(await storeSecret('riverbend-weather-key', value, fake.run)).toEqual({
      ok: false,
      error,
    });
    expect(fake.calls).toHaveLength(0);
  });

  test("the card's check gives the writer's answer on each side of the line's edge", () => {
    // The board refuses with `secretValueFitsStore` from core, which never
    // encodes; this module encodes. Walk every width of character past the
    // point where the line fills, under the shortest and longest names, and
    // hold the two to one answer — including a lone surrogate, which both
    // encoders write as the three bytes of U+FFFD.
    let seen = { fits: 0, refused: 0 };
    for (const service of ['r', LONGEST_SERVICE]) {
      for (const unit of ['a', '\u00e9', '\u20ac', '\u{1F511}', '\ud800']) {
        for (let n = 1; n <= 1100; n++) {
          const value = unit.repeat(n);
          const writer = secretValueFits(service, value);
          expect(secretValueFitsStore(service, value)).toBe(writer);
          seen = writer ? { ...seen, fits: seen.fits + 1 } : { ...seen, refused: seen.refused + 1 };
        }
      }
    }
    // Both answers occur, so the agreement is not two functions that always say yes.
    expect(seen.fits).toBeGreaterThan(0);
    expect(seen.refused).toBeGreaterThan(0);
  });

  test('the ceiling is exact: one character under stores', async () => {
    const fake = modelSecurity();
    const atCeiling = 'a'.repeat(SECRET_VALUE_MAX_CHARS);
    expect(await storeSecret('riverbend-weather-key', atCeiling, fake.run)).toEqual({ ok: true });
  });
});

describe('saved means read back, not exit 0', () => {
  test('a store that kept something else is a failure, and keeps nothing', async () => {
    // The measured failure mode: the command exits 0 having stored a value
    // that is not the reader's. Exit code alone would call this a success —
    // and the entry left behind would be read by an agent as the key.
    const fake = modelSecurity({ readStdout: 'c29tZXRoaW5nLWVsc2U=\n' });
    expect(await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run)).toEqual({
      ok: false,
      error: 'verify-failed',
    });
    expect(fake.store.has(stored('riverbend-weather-key'))).toBe(false);
  });

  test('a failed read-back is a failure, and keeps nothing', async () => {
    const fake = modelSecurity({ readCode: 44 });
    expect(await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run)).toEqual({
      ok: false,
      error: 'verify-failed',
    });
    expect(fake.store.has(stored('riverbend-weather-key'))).toBe(false);
  });

  test('a store that confirms leaves the entry in place', async () => {
    // CONTROL for the two above: the delete is the failed check's, not a
    // step every write takes.
    const fake = modelSecurity();
    expect(await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run)).toEqual({ ok: true });
    expect(fake.store.has(stored('riverbend-weather-key'))).toBe(true);
    expect(fake.calls.some((c) => c.args[0] === 'delete-generic-password')).toBe(false);
  });

  test('does not attempt a read-back when the write failed', async () => {
    const fake = modelSecurity({ writeCode: 1 });
    expect(await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run)).toEqual({
      ok: false,
      error: 'write-failed',
    });
    expect(fake.calls).toHaveLength(1);
  });

  test('a failure tag carries no value', async () => {
    const fake = modelSecurity({ readStdout: '\n' });
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
    const fake = modelSecurity();
    await storeSecret('cloudflare-api-token', PLACEHOLDER, fake.run);
    expect([...fake.store.keys()]).toEqual([stored('cloudflare-api-token')]);
    // The bare name reaches no word of either command, on its own.
    expect(words(fake.calls[0]?.stdin.trim() ?? '')).not.toContain('cloudflare-api-token');
    expect(fake.calls[1]?.args ?? []).not.toContain('cloudflare-api-token');
  });

  test('the read-back reads the same entry the write wrote', async () => {
    const fake = modelSecurity();
    await storeSecret('riverbend-weather-key', PLACEHOLDER, fake.run);
    const wrote = flag(words(fake.calls[0]?.stdin.trim() ?? ''), '-s');
    expect(wrote).toBe(stored('riverbend-weather-key'));
    expect(flag(fake.calls[1]?.args ?? [], '-s')).toBe(wrote ?? '');
  });
});
