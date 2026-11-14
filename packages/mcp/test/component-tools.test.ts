/**
 * The component tools reach peers, and reach the routes the server serves.
 * The harness runs the committed bundle as a real MCP server against a
 * recording stub, so what is asserted is the declaration a client receives
 * and the request the handler actually made. Every write carries the
 * session's author, because the server attributes it.
 *
 * All fixtures synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle(() => ({ ok: true, components: [] }));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

/** The requests a call made to the doc, leaving out the auto-watch a docId
 *  argument starts (`POST /api/agents/<id>/watches`). */
const sent = async (name: string, args: Record<string, unknown>) => {
  const res = await mcp.call(name, args);
  return res.sent
    .filter((r) => r.path.startsWith('/workspaces/'))
    .map((r) => ({ method: r.method, path: r.url, body: r.body }));
};
const DOC = { workspaceId: 'w-1', docId: 'd-1' };
const BASE = '/workspaces/w-1/docs/d-1';

describe('the component tools', () => {
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_agents')).toBeDefined();
    expect(mcp.tool('a_tool_that_was_never_declared')).toBeUndefined();
  });

  it('are declared, each addressed to a board and a doc', () => {
    for (const name of [
      'list_components',
      'get_component_state',
      'set_component_state',
      'place_component',
      'request_component_grant',
    ]) {
      expect(mcp.tool(name)?.inputSchema?.required, name).toEqual(
        expect.arrayContaining(['workspaceId', 'docId']),
      );
    }
  });

  it('read through the agent routes', async () => {
    expect(await sent('list_components', DOC)).toContainEqual({
      method: 'GET',
      path: `${BASE}/agent-components`,
      body: undefined,
    });
    expect(
      await sent('get_component_state', { ...DOC, componentId: 'ferry', path: 'pins.a' }),
    ).toContainEqual({
      method: 'GET',
      path: `${BASE}/agent-components/ferry/state?path=pins.a`,
      body: undefined,
    });
  });

  it('write with the session as author', async () => {
    const ops = [{ op: 'set', path: 'zoom', value: 12 }];
    const [state] = await sent('set_component_state', { ...DOC, componentId: 'ferry', ops });
    expect(state).toMatchObject({
      method: 'POST',
      path: `${BASE}/agent-components/ferry/state`,
      body: { ops },
    });
    expect((state?.body as { author?: { id?: string } }).author?.id).toBeTruthy();

    const [placed] = await sent('place_component', {
      ...DOC,
      importPath: './components/pin.tsx',
      props: { id: 'pier' },
      headingId: 'h-1',
    });
    expect(placed).toMatchObject({
      method: 'POST',
      path: `${BASE}/agent-components/place`,
      body: { importPath: './components/pin.tsx', props: { id: 'pier' }, headingId: 'h-1' },
    });
    expect((placed?.body as { author?: { id?: string } }).author?.id).toBeTruthy();

    const [grant] = await sent('request_component_grant', {
      ...DOC,
      folder: 'private',
      taskId: 't-1',
      why: 'The tide chart.',
    });
    expect(grant).toMatchObject({
      method: 'POST',
      path: `${BASE}/component-grants`,
      body: { folder: 'private', taskId: 't-1', why: 'The tide chart.' },
    });
  });

  it('refuse a call with no component id before any request', async () => {
    expect(await sent('set_component_state', { ...DOC, ops: [] })).toEqual([]);
  });
});
