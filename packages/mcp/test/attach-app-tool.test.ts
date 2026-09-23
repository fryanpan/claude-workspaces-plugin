/**
 * `attach_app` reaches the board's app route with every field the agent gave,
 * and passes the server's refusal through rather than judging the origin
 * itself.
 */
import { describe, expect, it } from 'vitest';
import { handleDocsTool } from '../src/tools/docs.ts';

const WS = 'w-1';

function recorder(answer: (path: string) => unknown) {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer(path);
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    AUTHOR: { id: 'a1', name: 'Tester', kind: 'agent' },
    CWD: '/tmp/harborlight-site',
  };
  return { calls, ctx };
}

describe('attach_app', () => {
  it("posts the name, origin, title and the agent's directory to the board's apps", async () => {
    const r = recorder(() => ({ docId: 'd-1', prefix: `/workspaces/${WS}/apps/d-1/` }));
    const out = await handleDocsTool(
      'attach_app',
      { workspaceId: WS, docId: 'site', origin: 'http://127.0.0.1:4321', title: 'Site' },
      r.ctx as never,
    );
    expect(r.calls).toEqual([
      [
        'POST',
        `/workspaces/${WS}/apps`,
        {
          docId: 'site',
          origin: 'http://127.0.0.1:4321',
          owner: '/tmp/harborlight-site',
          title: 'Site',
        },
      ],
    ]);
    expect(JSON.stringify(out)).toContain(`/workspaces/${WS}/apps/d-1/`);
  });

  it("surfaces the server's refusal of a non-loopback origin", async () => {
    const r = recorder(() => {
      throw new Error('POST /workspaces/w-1/apps → 400: origin_not_loopback');
    });
    await expect(
      handleDocsTool(
        'attach_app',
        { workspaceId: WS, docId: 'site', origin: 'http://example.com' },
        r.ctx as never,
      ),
    ).rejects.toThrow('origin_not_loopback');
  });
});
