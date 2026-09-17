/**
 * The `liveness` field: is THIS server bound and discoverable, as opposed to
 * did the last deploy come up.
 *
 * The distinction is the whole point of the field — `deploy.verification` read
 * `healthy` through the seven minutes prod was unreachable on 16 September —
 * so most of what is asserted here is that `ok` goes FALSE in the states a
 * reader would otherwise take for alive.
 *
 * Driven through `describeLiveness` directly; the route that serves it is
 * `deploy-routes.test.ts`. Fixtures are synthetic.
 */
import { describe, expect, it } from 'bun:test';
import {
  type DiscoveryClaim,
  cacheDiscoveryReads,
  describeLiveness,
  discoveryOwnership,
} from '../src/liveness.ts';

const OURS: DiscoveryClaim = { port: 8787, pid: 4242 };
const BOUND = { boundPort: 8787, boundAt: 1_700_000_000_000, pid: 4242 };

describe('describeLiveness', () => {
  it('is ok only when the port is bound AND the slot is ours', () => {
    const live = describeLiveness({ ...BOUND, discovery: OURS });
    expect(live.ok).toBe(true);
    expect(live.port).toBe(8787);
    expect(live.boundAt).toBe(1_700_000_000_000);
    expect(live.discovery).toBe('ours');
  });

  it('is NOT ok before the port is bound, however good the slot looks', () => {
    const live = describeLiveness({
      boundPort: null,
      boundAt: null,
      pid: 4242,
      discovery: OURS,
    });
    expect(live.ok).toBe(false);
    expect(live.discovery).toBe('another-server');
    expect(live.detail).toContain('not bound a port yet');
  });

  it('is NOT ok when another server owns the slot — staging, bound and unreachable', () => {
    // `bun run staging` binds 8788 and DECLINES the slot while prod holds it.
    // It is up, and no local agent resolves it. A reader who took the deploy
    // verdict for liveness here would be wrong in the other direction.
    const live = describeLiveness({
      boundPort: 8788,
      boundAt: 1_700_000_000_000,
      pid: 5555,
      discovery: OURS,
    });
    expect(live.ok).toBe(false);
    expect(live.discovery).toBe('another-server');
    expect(live.detail).toContain('another server owns the discovery slot');
  });

  it('is NOT ok when nothing owns the slot', () => {
    const live = describeLiveness({ ...BOUND, discovery: null });
    expect(live.ok).toBe(false);
    expect(live.discovery).toBe('missing');
    expect(live.detail).toContain('nothing owns the discovery slot');
  });

  it('points a reader at the deploy verdict rather than letting them conflate it', () => {
    // The failure this field exists for was a reading failure, so the line it
    // carries when everything is fine has to name the other claim.
    expect(describeLiveness({ ...BOUND, discovery: OURS }).detail).toContain('deploy.verification');
  });
});

describe('discoveryOwnership', () => {
  it('needs both the pid and the port to match', () => {
    // A stale entry with our pid and a port we no longer hold is a slot no
    // peer can reach us through, so it is not ours in the sense that counts.
    expect(discoveryOwnership({ ...BOUND, discovery: { port: 8788, pid: 4242 } })).toBe(
      'another-server',
    );
    expect(discoveryOwnership({ ...BOUND, discovery: { port: 8787, pid: 9 } })).toBe(
      'another-server',
    );
    expect(discoveryOwnership({ ...BOUND, discovery: OURS })).toBe('ours');
  });
});

describe('cacheDiscoveryReads', () => {
  it('reads at most once per window, however many callers ask', () => {
    // The supervisor probes this route every 30s and `readDiscovery` is
    // synchronous, so the number of opens must be a constant rather than a
    // function of traffic.
    let reads = 0;
    let clock = 0;
    const read = cacheDiscoveryReads(
      () => {
        reads += 1;
        return OURS;
      },
      { now: () => clock, ttlMs: 1_000 },
    );
    for (let i = 0; i < 50; i++) expect(read()).toEqual(OURS);
    expect(reads).toBe(1);
    clock = 999;
    read();
    expect(reads).toBe(1);
    clock = 1_000;
    read();
    expect(reads).toBe(2);
  });

  it('caches a null answer too, so a missing file is not re-opened per request', () => {
    let reads = 0;
    const clock = 0;
    const read = cacheDiscoveryReads(
      () => {
        reads += 1;
        return null;
      },
      { now: () => clock, ttlMs: 1_000 },
    );
    expect(read()).toBeNull();
    expect(read()).toBeNull();
    expect(reads).toBe(1);
  });

  it('sees the slot change hands on the next window', () => {
    let current: DiscoveryClaim | null = null;
    let clock = 0;
    const read = cacheDiscoveryReads(() => current, { now: () => clock, ttlMs: 1_000 });
    expect(read()).toBeNull();
    current = OURS;
    expect(read()).toBeNull();
    clock = 1_000;
    expect(read()).toEqual(OURS);
  });

  it('keeps answering the last good reading when the reader throws', () => {
    // Driven against a reader MADE to throw: the real `readDiscovery` catches
    // its own read and parse, so pointing this at it would assert nothing.
    // Without the catch a single fault gives the route two behaviours — one
    // throw out of `GET /api/deploy`, then 15s of a stale value served as if
    // it had just been read — and the second is the dangerous one, because it
    // is indistinguishable from a healthy cached answer.
    let mode: 'ok' | 'throw' = 'ok';
    let reads = 0;
    let clock = 0;
    const read = cacheDiscoveryReads(
      () => {
        reads += 1;
        if (mode === 'throw') throw new Error('discovery slot unreadable');
        return OURS;
      },
      { now: () => clock, ttlMs: 1_000 },
    );
    expect(read()).toEqual(OURS);

    mode = 'throw';
    clock = 1_000;
    expect(read()).toEqual(OURS);
    // And the failed attempt still spent the window, so a reader that throws
    // every time is attempted once per window rather than once per request.
    expect(reads).toBe(2);
    clock = 1_500;
    expect(read()).toEqual(OURS);
    expect(reads).toBe(2);
  });

  it('answers null when the very first read throws, claiming no slot', () => {
    // The safe direction: no reading is "nothing owns the slot", never "this
    // server does".
    const read = cacheDiscoveryReads(
      () => {
        throw new Error('discovery slot unreadable');
      },
      { now: () => 0, ttlMs: 1_000 },
    );
    expect(read()).toBeNull();
  });
});
