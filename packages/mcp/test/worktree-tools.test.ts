/**
 * The three worktree verbs reach peers, and reach the routes the server
 * serves.
 *
 * Same two failures `plugin-refresh-tool.test.ts` covers, for the same
 * reason: a tool declared in source but missing from the committed bundle is
 * invisible to every session, and a handler pointed at the wrong verb or path
 * fails only inside somebody's session. The harness runs the built bundle as
 * a real MCP server against a recording stub, so what is asserted is the
 * declaration a client receives and the request the handler actually made.
 *
 * Fixtures are fictional paths.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

const CHECKOUT = '/Users/example/dev/widgets-worktrees/feature-x';

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle((req) => {
    if (req.method === 'GET') {
      return {
        repos: [
          {
            repoKey: 'git:github.com/example/widgets',
            mainRoot: '/Users/example/dev/widgets',
            checkouts: [{ root: CHECKOUT, registered: true }],
            live: ['/Users/example/dev/widgets', CHECKOUT],
          },
        ],
      };
    }
    if (req.method === 'DELETE')
      return { ok: true, repoKey: 'git:github.com/example/widgets', flushed: 2 };
    return { ok: true, repoKey: 'git:github.com/example/widgets', alreadyKnown: false };
  });
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('the worktree registry tools', () => {
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_agents')).toBeDefined();
    expect(mcp.tool('a_tool_that_was_never_declared')).toBeUndefined();
  });

  it('are declared, and ask for a path rather than a board', () => {
    // No workspaceId anywhere: a checkout is a fact about the machine, not
    // workspace content, and a verb that asked for a board would be claiming
    // otherwise.
    for (const name of ['register_worktree', 'list_worktrees', 'unregister_worktree']) {
      const decl = mcp.tool(name);
      expect(decl).toBeDefined();
      expect(Object.keys(decl?.inputSchema?.properties ?? {})).not.toContain('workspaceId');
    }
    expect(mcp.tool('register_worktree')?.inputSchema?.required).toEqual(['path']);
    expect(mcp.tool('unregister_worktree')?.inputSchema?.required).toEqual(['path']);
    expect(mcp.tool('list_worktrees')?.inputSchema?.properties ?? {}).toEqual({});
  });

  it('register posts the checkout to the route the server serves', async () => {
    const res = await mcp.call('register_worktree', { path: CHECKOUT });
    expect(res.isError).toBe(false);
    expect(res.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/repos/checkouts']);
    expect(res.sent[0]?.body).toEqual({ path: CHECKOUT });
    // The server's answer reaches the caller, not a bare ack — alreadyKnown
    // is the whole difference between a first registration and a repeat.
    expect(res.json).toMatchObject({ alreadyKnown: false });
  });

  it('list reads the registry', async () => {
    const res = await mcp.call('list_worktrees', {});
    expect(res.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/repos']);
    expect(res.json).toMatchObject({ repos: [{ live: expect.any(Array) }] });
  });

  it('unregister sends a DELETE and reports what was flushed', async () => {
    const res = await mcp.call('unregister_worktree', { path: CHECKOUT });
    expect(res.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['DELETE /api/repos/checkouts']);
    expect(res.sent[0]?.body).toEqual({ path: CHECKOUT });
    // How many docs were written out before the checkout goes away is the
    // reason to call this verb at all, so it has to reach the caller.
    expect(res.json).toMatchObject({ flushed: 2 });
  });
});
