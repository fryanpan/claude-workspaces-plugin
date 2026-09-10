/**
 * The Sentry watch list has to survive the trip through the MCP child.
 *
 * The server names the projects (packages/server/src/sentry-projects.ts) and
 * the session is the thing that must act on them — so what has to hold is
 * that the field the route sends is a field the caller RECEIVES. A tool
 * handler that assembles a response field-by-field is exactly where a new
 * field gets silently dropped, and the drop is invisible: the attach still
 * succeeds and the board still looks ordinary.
 *
 * Driven through the committed bundle — the artifact a peer loads — with a
 * stub server standing in for the board, rather than read out of the source.
 *
 * All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

const PLAN = {
  projects: [
    { slug: 'stub-server-project', raises: 'server' },
    { slug: 'stub-browser-project', raises: 'browser' },
  ],
  remedy: 'Call sentry_watch_project on each slug. Check with sentry_list_my_watches.',
};

/** A board that names its Sentry projects, as a current server does. */
let telling: BundleHarness;
/** A board that says nothing about Sentry, as an older server does. */
let silent: BundleHarness;

beforeAll(async () => {
  telling = await startBundle((r) =>
    r.method === 'POST' && r.path.endsWith('/agents')
      ? { ok: true, attachment: { agentId: 'agent-harness' }, watching: 1, sentry: PLAN }
      : {},
  );
  silent = await startBundle((r) =>
    r.method === 'POST' && r.path.endsWith('/agents')
      ? { ok: true, attachment: { agentId: 'agent-harness' }, watching: 1 }
      : {},
  );
}, 60_000);

afterAll(async () => {
  await telling?.stop();
  await silent?.stop();
});

describe('attach_agent hands the Sentry watch list to the session', () => {
  it('carries every slug and the remedy out of the tool result', async () => {
    const res = await telling.call('attach_agent', { workspaceId: 'w-stub' });
    const body = res.json as { sentry?: typeof PLAN; agentId?: string };
    // Positive control: this is a real attach result, so an assertion about
    // one of its fields is an assertion about a response that happened.
    expect(body.agentId).toBe('agent-harness');
    expect(body.sentry?.projects.map((p) => p.slug)).toEqual([
      'stub-server-project',
      'stub-browser-project',
    ]);
    expect(body.sentry?.projects.map((p) => p.raises)).toEqual(['server', 'browser']);
    expect(body.sentry?.remedy).toContain('sentry_watch_project');
  });

  it('omits the field entirely against a server that does not send one', async () => {
    // Not an empty list: an empty list reads as "watch nothing", which is a
    // claim this bundle has no basis for making about an older board.
    const res = await silent.call('attach_agent', { workspaceId: 'w-stub' });
    const body = res.json as { sentry?: unknown; agentId?: string };
    expect(body.agentId).toBe('agent-harness');
    expect(body.sentry).toBeUndefined();
  });

  it('tells the caller what to do with it, in the declaration a client reads', async () => {
    // The field is useless if the reader does not know the call. This is the
    // text every session is handed at tools/list, not a source literal.
    const decl = telling.tool('attach_agent');
    expect(decl?.description).toContain('sentry_watch_project');
    expect(decl?.description).toContain('sentry_list_my_watches');
  });
});
