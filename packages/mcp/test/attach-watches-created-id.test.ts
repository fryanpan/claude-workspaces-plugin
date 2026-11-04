/**
 * An attach watches the doc it made by the id the server answered with.
 *
 * Before the create, the docId an attach names is an alias no doc holds yet.
 * A board token's watch set takes only keys on its board, so a walled lead's
 * pre-call watch on that alias was refused and its new doc was never saved
 * to its set. The attach tools now skip the pre-call watch and watch the
 * created doc's real id afterwards. All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import { ATTACH_THEN_WATCH_TOOLS, NO_AUTO_WATCH_TOOLS, maybeAutoWatch } from '../src/call-tool.ts';
import { type DocsToolContext, handleDocsTool } from '../src/tools/docs.ts';

function ctx(reply: unknown, watched: string[]): DocsToolContext {
  return {
    http: async () => reply,
    ok: (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] }),
    err: (m: string) => ({ isError: true, content: [{ type: 'text', text: m }] }),
    AUTHOR: { id: 'agent-harbor', name: 'Harbor', kind: 'agent', color: '#888888' },
    CWD: '/tmp/harbor',
    DEFAULT_WORKSPACE_ID: 'w-1',
    watchDoc: async (docId: string) => {
      watched.push(docId);
      return true;
    },
  } as unknown as DocsToolContext;
}

describe('an attach watches the doc it made', () => {
  it.each([
    ['attach_markdown', { path: '/tmp/harbor/plan.md' }],
    ['create_review_doc', { path: '/tmp/harbor/plan.md' }],
    ['attach_mockup', {}],
    ['bind_mock', {}],
  ])('%s watches the id the server returned, not the alias', async (name, extra) => {
    const watched: string[] = [];
    const res = await handleDocsTool(
      name,
      { workspaceId: 'w-1', docId: 'harbor-plan', ...extra },
      ctx({ docId: 'd-made' }, watched),
    );
    expect(res?.isError).not.toBe(true);
    expect(watched).toEqual(['d-made']);
  });

  it('falls back to the named docId when the server returns none', async () => {
    const watched: string[] = [];
    await handleDocsTool(
      'attach_mockup',
      { workspaceId: 'w-1', docId: 'harbor-sketch' },
      ctx({}, watched),
    );
    expect(watched).toEqual(['harbor-sketch']);
  });

  it('respects subscribe: false', async () => {
    const watched: string[] = [];
    await handleDocsTool(
      'attach_mockup',
      { workspaceId: 'w-1', docId: 'harbor-sketch', subscribe: false },
      ctx({ docId: 'd-made' }, watched),
    );
    expect(watched).toEqual([]);
  });

  it('watches nothing before the call for any of them', async () => {
    for (const name of ATTACH_THEN_WATCH_TOOLS) {
      expect(NO_AUTO_WATCH_TOOLS.has(name)).toBe(true);
      const seen: string[] = [];
      await maybeAutoWatch(async (d) => seen.push(d), name, { docId: 'harbor-plan' });
      expect(seen).toEqual([]);
    }
  });
});
