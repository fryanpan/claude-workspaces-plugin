/**
 * Incoming Messages as a registered feature (routes/inbox-feature.ts and
 * routes/features.ts), driven directly rather than through a server: its
 * routes claim `/inbox/` and nothing else, the peer address it is handed is
 * the one its post gate reads, and its stop ends the watcher.
 *
 * The full post, read and tap flows run through the real server in
 * inbox-routes.test.ts and inbox-reply-routes.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeatureRequest } from '../src/feature-module.ts';
import type { Identities } from '../src/identities.ts';
import type { LandingPart } from '../src/landing-changes.ts';
import type { FeatureDeps } from '../src/routes/feature-routes-context.ts';
import { startServerFeatures } from '../src/routes/features.ts';
import { inboxFeature } from '../src/routes/inbox-feature.ts';
import { TaskStore } from '../src/tasks.ts';

let dir: string;
let taskStore: TaskStore;
let address: string;
let notified: LandingPart[];

const j = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const deps = (): FeatureDeps => ({
  dataDir: dir,
  opts: {},
  taskStore,
  identities: { displayNameFor: () => null } as unknown as Identities,
  notifyLanding: (part) => notified.push(part),
  requestAddress: () => address,
  agentTokenKey: () => 'k'.repeat(64),
  j,
  safeJson: async (req) => {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
});

const rq = (pathname: string, init?: RequestInit): FeatureRequest => ({
  req: new Request(`http://localhost${pathname}`, init),
  pathname,
  visitor: null,
  ownerProven: () => false,
  requestOrigin: () => undefined,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inbox-feature-'));
  taskStore = new TaskStore({ dataDir: dir });
  address = '127.0.0.1';
  notified = [];
});
afterEach(() => {
  taskStore.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('inboxFeature', () => {
  it('declines an address outside /inbox/, so the chain goes on', async () => {
    const inbox = inboxFeature.start(deps());
    try {
      expect(await inbox.routes?.(rq('/coach/goals'))).toBeFalsy();
    } finally {
      inbox.stop?.();
    }
  });

  it('answers its own paths', async () => {
    const inbox = inboxFeature.start(deps());
    try {
      const res = await inbox.routes?.(rq('/inbox/rows'));
      expect(res?.status).toBe(405);
    } finally {
      inbox.stop?.();
    }
  });

  it('refuses a post from an address that is not this machine, read through the deps', async () => {
    const inbox = inboxFeature.start(deps());
    try {
      const post = () => rq('/inbox/rows', { method: 'POST', body: '{}' });
      address = '203.0.113.9';
      expect((await inbox.routes?.(post()))?.status).toBe(403);
      // The same request from loopback gets past the address gate to the body check.
      address = '127.0.0.1';
      expect((await inbox.routes?.(post()))?.status).toBe(400);
    } finally {
      inbox.stop?.();
    }
  });

  it('draws no front-page section while there is no inbox', () => {
    const inbox = inboxFeature.start(deps());
    try {
      expect(inbox.landingSection(new Map())).toBe('');
    } finally {
      inbox.stop?.();
    }
  });
});

describe('startServerFeatures', () => {
  it('routes to the inbox at the registered position and stops it', async () => {
    const features = startServerFeatures(deps());
    expect((await features.routes(rq('/inbox/rows')))?.status).toBe(405);
    expect(await features.routes(rq('/settings/prompts'))).toBeNull();
    expect(features.inbox.landingSection(new Map())).toBe('');
    // Stopping is synchronous and does not throw; a second registry over the
    // same directory starts cleanly after it.
    features.stop();
    const again = startServerFeatures(deps());
    again.stop();
  });
});
