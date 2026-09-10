/**
 * The Sentry projects an attaching session is told to watch.
 *
 * Two layers, because either alone proves nothing about the other: the pure
 * resolver (which slugs, and what a bad override does to them) and the same
 * answer read back off a real `POST /workspaces/<id>/agents` — the layer
 * that catches a field the module returns and the route silently drops.
 *
 * Every absence assertion here sits next to a positive control on the same
 * read: "no browser project" is worthless on a plan that carries no projects
 * at all.
 *
 * Fixtures are synthetic — invented board names, invented agent ids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SentryWatchPlan, sentryWatchPlan } from '../src/sentry-projects.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const slugs = (plan: SentryWatchPlan): string[] => plan.projects.map((p) => p.slug);

describe('sentryWatchPlan', () => {
  it('names both committed projects, and which half of the product raises into each', () => {
    const plan = sentryWatchPlan({});
    expect(slugs(plan)).toEqual(['workspaces-server', 'claude-workspaces']);
    expect(plan.projects.find((p) => p.slug === 'workspaces-server')?.raises).toBe('server');
    expect(plan.projects.find((p) => p.slug === 'claude-workspaces')?.raises).toBe('browser');
  });

  it('says what to do with the slugs, naming the call and the check', () => {
    // A bare array of slugs has been read as trivia. The remedy is the half
    // that makes the field actionable from a fresh context, so it is asserted
    // rather than left to a reviewer's eye.
    const { remedy } = sentryWatchPlan({});
    expect(remedy).toContain('sentry_watch_project');
    expect(remedy).toContain('sentry_list_my_watches');
  });

  it('lets an override REPLACE the default rather than add to it', () => {
    const plan = sentryWatchPlan({
      CW_SENTRY_PROJECTS: 'other-server:server,other-browser:browser',
    });
    expect(slugs(plan)).toEqual(['other-server', 'other-browser']);
    expect(plan.projects[1]?.raises).toBe('browser');
    // The point of "replace": a deployment that raises somewhere else must
    // not be told to watch this board's projects too.
    expect(slugs(plan)).not.toContain('workspaces-server');
  });

  it('reads a bare slug without a side, defaulting it to server', () => {
    expect(sentryWatchPlan({ CW_SENTRY_PROJECTS: 'lone-project' }).projects).toEqual([
      { slug: 'lone-project', raises: 'server' },
    ]);
  });

  it('falls back to the default for an override it cannot read, and never throws', () => {
    // This value rides a response that matters for other reasons. A typo in
    // it must not be able to take an attach down, and it must not half-apply.
    for (const bad of [
      'https://sentry.io/organizations/x/projects/y/',
      'good-one,bad slug here',
      'good-one:sideways',
      '   ',
      ',,,',
    ]) {
      const plan = sentryWatchPlan({ CW_SENTRY_PROJECTS: bad });
      expect(slugs(plan), `override ${JSON.stringify(bad)}`).toEqual([
        'workspaces-server',
        'claude-workspaces',
      ]);
    }
    // Positive control for the loop above: a READABLE override on the same
    // resolver does change the answer, so the equality is not vacuous.
    expect(slugs(sentryWatchPlan({ CW_SENTRY_PROJECTS: 'readable-one' }))).toEqual([
      'readable-one',
    ]);
  });

  it('hands back a fresh array, so a caller cannot mutate the committed default', () => {
    const first = sentryWatchPlan({});
    first.projects.push({ slug: 'injected', raises: 'server' });
    expect(slugs(sentryWatchPlan({}))).toEqual(['workspaces-server', 'claude-workspaces']);
  });
});

describe('attach_agent over the real route', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-sentry-projects-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    ws = await seedBoard(base, { name: 'Sentry attach board' });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('carries both project slugs and the remedy back to the attaching session', async () => {
    const res = await fetch(`${base}/workspaces/${ws}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-lamplighter',
        agentName: 'Lamplighter',
        runtime: 'claude-code-local',
      }),
    });
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    const body = (await res.json()) as {
      attachment?: { agentId?: string };
      sentry?: SentryWatchPlan;
    };
    // Positive control: this really is a successful attach, so an assertion
    // about one of its fields is an assertion about a response that happened.
    expect(body.attachment?.agentId).toBe('agent-lamplighter');
    expect(body.sentry?.projects.map((p) => p.slug)).toEqual([
      'workspaces-server',
      'claude-workspaces',
    ]);
    expect(body.sentry?.remedy).toContain('sentry_watch_project');
  });
});
