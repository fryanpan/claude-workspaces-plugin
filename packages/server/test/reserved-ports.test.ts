/**
 * Pins the fleet's reserved-port list itself, not just the code that reads
 * it: a port added to `RESERVED_PORTS` without a matching case here has no
 * proof the refusal actually fires for it.
 */
import { describe, expect, test } from 'bun:test';
import {
  BOARD_SERVER_PORTS,
  RESERVED_PORTS,
  STAGING_PORTS,
  reservedPortError,
  reservedPortOwner,
  stagingPortError,
} from '../src/reserved-ports';

describe('reservedPortOwner', () => {
  test.each(RESERVED_PORTS.map((p) => [p.port, p.owner] as const))(
    'port %d is reserved for %s',
    (port, owner) => {
      expect(reservedPortOwner(port)).toBe(owner);
    },
  );

  // Positive control: a port nothing in this file claims must read as free,
  // so a "reserved" verdict is a fact about the port, not a default the
  // check would produce for anything you ask it about.
  test('a free port (8800) is not reserved', () => {
    expect(reservedPortOwner(8800)).toBeNull();
  });
});

describe('reservedPortError', () => {
  test('names the owner and suggests a free range', () => {
    const err = reservedPortError(8787);
    expect(err).toContain('8787');
    expect(err).toContain('prod');
    expect(err).toContain('8800');
  });

  test('is null for a free port', () => {
    expect(reservedPortError(9000)).toBeNull();
  });
});

describe('stagingPortError', () => {
  test('lets staging take each board-server port bar prod’s', () => {
    expect(STAGING_PORTS).toEqual([8788, 8789, 8790]);
    for (const port of STAGING_PORTS) expect(stagingPortError(port)).toBeNull();
    expect(BOARD_SERVER_PORTS[0]).toBe(8787);
  });

  test('refuses prod’s port, and names its owner', () => {
    expect(stagingPortError(8787)).toContain('prod');
  });

  test('refuses a port the lead wall does not cover, and names the ones it does', () => {
    const err = stagingPortError(8800);
    expect(err).toContain('8800');
    expect(err).toContain('8788, 8789, 8790');
  });
});
