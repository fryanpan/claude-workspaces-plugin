/**
 * `set_thread_progress` marks a comment in progress or done on the board's
 * progress route, as this agent, and leaves the thread open.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_LIST } from '../src/tool-schemas.ts';

const TOOLS = TOOL_LIST.tools;
import { handleDocsTool } from '../src/tools/docs.ts';

const WS = 'w-1';

function recorder() {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return { thread: { id: 't 1', status: 'open', progress: { state: 'done' } } };
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    AUTHOR: { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' },
    CWD: '/tmp/harborlight-site',
  };
  return { calls, ctx };
}

describe('set_thread_progress', () => {
  it("posts the state and this agent to the thread's progress route", async () => {
    const r = recorder();
    const out = await handleDocsTool(
      'set_thread_progress',
      { workspaceId: WS, docId: 'berths', threadId: 't 1', state: 'done' },
      r.ctx as never,
    );
    expect(r.calls).toEqual([
      [
        'POST',
        `/workspaces/${WS}/docs/berths/threads/t%201/progress`,
        {
          state: 'done',
          author: { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' },
        },
      ],
    ]);
    expect(JSON.stringify(out)).toContain('done');
  });

  it('refuses a state the board does not know, before any call', async () => {
    const r = recorder();
    const out = await handleDocsTool(
      'set_thread_progress',
      { workspaceId: WS, docId: 'berths', threadId: 't1', state: 'finished' },
      r.ctx as never,
    );
    expect(r.calls).toEqual([]);
    expect((out as { isError?: boolean }).isError).toBe(true);
  });

  it('is offered with the three states, and resolve_thread points at it', () => {
    const tool = TOOLS.find((t) => t.name === 'set_thread_progress');
    const props = tool?.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.state?.enum).toEqual(['working', 'done', 'open']);
    expect(TOOLS.find((t) => t.name === 'resolve_thread')?.description).toContain(
      'set_thread_progress',
    );
  });
});
