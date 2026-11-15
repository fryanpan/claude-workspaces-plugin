/**
 * The mount tools call the server through Hono's typed client.
 *
 * Two halves. The cases drive each mount tool with a recording `http` and
 * assert the method, path and body that reached it — the same requests the
 * tools sent when they spelled the paths by hand — and that the tool hands
 * back what `http` answered.
 *
 * The other half is `typeProbes`, which never runs. `bun run typecheck`
 * compiles it, and each `@ts-expect-error` there fails the typecheck if the
 * line under it STOPS being an error. So a field renamed on the server's
 * route (`packages/server/src/routes/mounts-api.ts`) without the same rename
 * here, or a route that disappears, is a red typecheck rather than a
 * session's first failing call.
 */
import { describe, expect, it } from 'vitest';
import { mountsClient } from '../src/mounts-client.ts';
import { type WorkspaceToolContext, handleWorkspaceTool } from '../src/tools/workspace.ts';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function recording(answer: unknown = { ok: true, repoKey: 'git:harborlight' }) {
  const calls: Call[] = [];
  const http = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return answer;
  };
  const ctx = {
    http,
    ok: (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] }),
    err: (message: string) => ({
      isError: true,
      content: [{ type: 'text' as const, text: message }],
    }),
  } as unknown as WorkspaceToolContext;
  return { calls, ctx };
}

const textOf = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]?.text ?? 'null');

describe('the mount tools, through the typed client', () => {
  it('mount_folder posts the path and the privacy it was given', async () => {
    const { calls, ctx } = recording();
    const r = await handleWorkspaceTool(
      'mount_folder',
      { path: '/src/riverbend/docs', privacy: 'local-only' },
      ctx,
    );
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/mounts',
        body: { path: '/src/riverbend/docs', privacy: 'local-only' },
      },
    ]);
    expect(textOf(r)).toEqual({ ok: true, repoKey: 'git:harborlight' });
  });

  it('list_mounts reads the whole table, or one mount’s files when it names one', async () => {
    const { calls, ctx } = recording({ projects: [] });
    await handleWorkspaceTool('list_mounts', {}, ctx);
    await handleWorkspaceTool('list_mounts', { path: '/src/riverbend' }, ctx);
    await handleWorkspaceTool(
      'list_mounts',
      { path: '/src/riverbend', mountId: 'm-1', after: 'a.md', limit: 50 },
      ctx,
    );
    expect(calls).toEqual([
      { method: 'GET', path: '/api/mounts', body: undefined },
      { method: 'GET', path: '/api/mounts?path=%2Fsrc%2Friverbend', body: undefined },
      {
        method: 'GET',
        path: '/api/mounts/files?path=%2Fsrc%2Friverbend&mountId=m-1&after=a.md&limit=50',
        body: undefined,
      },
    ]);
  });

  it('unmount_folder, the privacy, conventions and meetings writes send their bodies', async () => {
    const { calls, ctx } = recording();
    await handleWorkspaceTool('unmount_folder', { path: '/src/riverbend', mountId: 'm-1' }, ctx);
    await handleWorkspaceTool(
      'set_project_privacy',
      { path: '/src/riverbend', privacy: 'workspace', mountId: 'm-1' },
      ctx,
    );
    await handleWorkspaceTool(
      'set_project_conventions',
      { path: '/src/riverbend', conventionsPath: 'docs/conventions.md' },
      ctx,
    );
    await handleWorkspaceTool(
      'set_project_meetings',
      { path: '/src/riverbend', meetingsPath: 'docs/meetings', gitignore: true },
      ctx,
    );
    expect(calls).toEqual([
      { method: 'DELETE', path: '/api/mounts', body: { path: '/src/riverbend', mountId: 'm-1' } },
      {
        method: 'PUT',
        path: '/api/mounts/privacy',
        body: { path: '/src/riverbend', privacy: 'workspace', mountId: 'm-1' },
      },
      {
        method: 'PUT',
        path: '/api/mounts/conventions',
        body: { path: '/src/riverbend', conventionsPath: 'docs/conventions.md' },
      },
      {
        method: 'PUT',
        path: '/api/mounts/meetings',
        body: { path: '/src/riverbend', meetingsPath: 'docs/meetings', gitignore: true },
      },
    ]);
  });

  it('read_project_conventions puts the path in the query', async () => {
    const { calls, ctx } = recording({ repoKey: 'git:harborlight', found: false });
    await handleWorkspaceTool('read_project_conventions', { path: '/src/riverbend' }, ctx);
    expect(calls).toEqual([
      { method: 'GET', path: '/api/mounts/conventions?path=%2Fsrc%2Friverbend', body: undefined },
    ]);
  });

  it('a refusal from http reaches the tool unchanged', async () => {
    const http = async (method: string, path: string) => {
      throw new Error(`${method} ${path} → 400: {"error":"not-a-repo"}`);
    };
    const client = mountsClient(http);
    await expect(
      client.api.mounts.conventions.$get({ query: { path: '/tmp/saltmarsh' } }),
    ).rejects.toThrow('GET /api/mounts/conventions?path=%2Ftmp%2Fsaltmarsh → 400');
  });
});

/** Compiled by `bun run typecheck`, never called. See the header. */
function typeProbes(client: ReturnType<typeof mountsClient>): void {
  // A field the route does not declare.
  // @ts-expect-error — the privacy route reads `privacy`, not `level`.
  void client.api.mounts.privacy.$put({ json: { path: '/x', level: 'workspace' } });
  // A field the route requires, left out.
  // @ts-expect-error — `conventionsPath` is required.
  void client.api.mounts.conventions.$put({ json: { path: '/x' } });
  // A route that does not exist.
  // @ts-expect-error — there is no `/api/mounts/privacies`.
  void client.api.mounts.privacies.$put({ json: { path: '/x', privacy: 'workspace' } });
  // A method the route does not take.
  // @ts-expect-error — `/api/mounts/privacy` takes PUT only.
  void client.api.mounts.privacy.$get();
  // The control: the same call, spelled as the route declares it, compiles.
  void client.api.mounts.privacy.$put({ json: { path: '/x', privacy: 'workspace' } });
}
void typeProbes;
