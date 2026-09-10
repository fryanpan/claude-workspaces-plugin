/**
 * Which credential a call authenticates with, and what header it sends.
 *
 * There are two ways this repo may reach the API and they are not
 * interchangeable: an operator's long-lived key, and a short-lived access
 * token that CI mints from its own OIDC identity so no repository secret has
 * to exist. The failure this guards against is quiet in both directions — a
 * token sent in `x-api-key` is rejected as a bad key, and a key sent as a
 * bearer is rejected as a bad token, and either reads from the outside like
 * "the eval is broken" rather than "the wrong header went out".
 */
import { describe, expect, it } from 'bun:test';
import {
  ACCESS_TOKEN_ENV,
  type SummaryCredential,
  authHeader,
  resolveCredentialFrom,
} from '../src/summarize.ts';

/** A keychain that holds this, or holds nothing when given null. */
const keychain = (stored: string | null) => (): string | null => {
  if (stored === null) throw new Error('Keychain entry not found');
  return stored;
};

const noKeychain = keychain(null);

describe('which credential a call uses', () => {
  it('prefers an access token in the environment over the keychain', () => {
    // The only thing that sets this variable is a job that just minted a
    // token for this run, so it outranks a key that merely happens to be
    // sitting on the machine.
    const cred = resolveCredentialFrom(undefined, keychain('sk-from-keychain'), {
      [ACCESS_TOKEN_ENV]: 'tok-minted-for-this-run',
    });
    expect(cred).toEqual({ kind: 'token', value: 'tok-minted-for-this-run' });
  });

  it('uses the keychain key when no token was handed to the process', () => {
    const cred = resolveCredentialFrom(undefined, keychain('sk-from-keychain'), {});
    expect(cred).toEqual({ kind: 'key', value: 'sk-from-keychain' });
  });

  it('lets an explicit key beat a token in the environment', () => {
    // Somebody typed `--api-key` in this command. An ambient token must not
    // silently override a credential a person chose by hand, or a run aimed
    // at one account quietly bills another.
    const cred = resolveCredentialFrom('sk-typed-by-hand', noKeychain, {
      [ACCESS_TOKEN_ENV]: 'tok-minted-for-this-run',
    });
    expect(cred).toEqual({ kind: 'key', value: 'sk-typed-by-hand' });
  });

  it('keeps null as the explicit off state, token or no token', () => {
    // `null` is how a test and the server say "there is deliberately no
    // credential", which is the documented feature-off state rather than an
    // error. A token in the environment must not switch the feature back on.
    expect(resolveCredentialFrom(null, keychain('sk-from-keychain'), {})).toBeNull();
    expect(
      resolveCredentialFrom(null, noKeychain, { [ACCESS_TOKEN_ENV]: 'tok-minted' }),
    ).toBeNull();
  });

  it('is null when there is no token, no env key and no keychain entry', () => {
    expect(resolveCredentialFrom(undefined, noKeychain, {})).toBeNull();
  });

  it('ignores an access token that is only whitespace', () => {
    // An unset secret expands to the empty string in a shell, so a job that
    // failed to mint one hands the process a blank rather than nothing.
    const cred = resolveCredentialFrom(undefined, keychain('sk-from-keychain'), {
      [ACCESS_TOKEN_ENV]: '   ',
    });
    expect(cred).toEqual({ kind: 'key', value: 'sk-from-keychain' });
  });
});

describe('the header a credential sends', () => {
  const key: SummaryCredential = { kind: 'key', value: 'sk-abc' };
  const token: SummaryCredential = { kind: 'token', value: 'tok-abc' };

  it('sends a key as x-api-key and a token as a bearer', () => {
    expect(authHeader(key)).toEqual({ 'x-api-key': 'sk-abc' });
    expect(authHeader(token)).toEqual({ authorization: 'Bearer tok-abc' });
  });

  it('sends exactly one auth header, never both', () => {
    // Two optional fields on one object is how "either/or" turns into "both"
    // by accident. The API rejects a request carrying both.
    for (const cred of [key, token]) {
      const header = authHeader(cred);
      expect(Object.keys(header)).toHaveLength(1);
    }
    expect(authHeader(token)['x-api-key']).toBeUndefined();
    expect(authHeader(key).authorization).toBeUndefined();
  });
});
