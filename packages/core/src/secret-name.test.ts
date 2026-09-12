import { describe, expect, it } from 'vitest';
import {
  SECRET_ACCOUNT,
  SECRET_SERVICE_PREFIX,
  secretReadCommand,
  storedSecretService,
} from './secret-name.ts';

/** Every name here is invented, and none of these is a value. */
describe('where a secret an item asked for is stored', () => {
  it('puts an asked-for name inside this feature own namespace', () => {
    // The point of the prefix: a name a filer chose can never be spelled the
    // way the server spells an entry it reads its own configuration from.
    expect(storedSecretService('saltmarsh-relay-signer')).toBe(
      `${SECRET_SERVICE_PREFIX}saltmarsh-relay-signer`,
    );
    expect(storedSecretService('saltmarsh-relay-signer').startsWith(SECRET_SERVICE_PREFIX)).toBe(
      true,
    );
    // The control: the bare name is NOT what lands in the store, which is the
    // whole claim. Without this the assertion above passes on a prefix of ''.
    expect(storedSecretService('saltmarsh-relay-signer')).not.toBe('saltmarsh-relay-signer');
  });

  it('hands an agent a command naming the entry the value is actually in', () => {
    const cmd = secretReadCommand('saltmarsh-relay-signer');
    expect(cmd).toContain(`-a ${SECRET_ACCOUNT}`);
    expect(cmd).toContain(`-s ${storedSecretService('saltmarsh-relay-signer')}`);
    // A command that named the bare name would find nothing, or — because the
    // reader falls back to any account — something else entirely.
    expect(cmd).not.toContain('-s saltmarsh-relay-signer ');
  });

  it('reads nothing back itself — it returns text, not a value', () => {
    // A verb that read the store would be a door with the secret on the wrong
    // side of it. This one is a formatter: same input, same string, no I/O.
    expect(secretReadCommand('saltmarsh-relay-signer')).toBe(
      secretReadCommand('saltmarsh-relay-signer'),
    );
    expect(typeof secretReadCommand('saltmarsh-relay-signer')).toBe('string');
  });
});
