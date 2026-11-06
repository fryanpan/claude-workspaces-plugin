/**
 * The refused-write line: when it is written, and what it may never carry.
 * The line as a running server writes it is in `widget-door-http.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import type { OriginPolicy } from '../src/middleware/browser-origin.ts';
import { refusedWriteLine } from '../src/middleware/refused-write-log.ts';

const SERVER = 'https://riverbend-host.tailnet-name.test';
const PAGE = `${SERVER}:10000`;
const policy = (): OriginPolicy => ({
  requestOrigin: SERVER,
  localHostnames: [],
  allowedOrigins: [],
});
const refusal = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status });
const post = (origin: string | null, extra: Record<string, string> = {}) =>
  new Request(`${SERVER}/workspaces/w-1/docs/d-1/threads`, {
    method: 'POST',
    headers: { ...(origin ? { origin } : {}), ...extra },
  });

describe('the refused-write line', () => {
  it('names the method, the status and the gate for a page on another origin', async () => {
    const line = await refusedWriteLine(post(PAGE), refusal(403, 'out_of_widget_scope'), policy);
    expect(line).toBe('[refused-write] POST status=403 gate=out_of_widget_scope');
  });

  it('reads a refused socket, which is a GET', async () => {
    const req = new Request(`${SERVER}/workspaces/w-1/docs/d-1/y`, {
      headers: { origin: PAGE, upgrade: 'websocket' },
    });
    expect(await refusedWriteLine(req, refusal(401, 'sign_in_required'), policy)).toBe(
      '[refused-write] SOCKET status=401 gate=sign_in_required',
    );
  });

  it('is silent for an answer that is not a refusal of a page on another origin', async () => {
    const read = new Request(`${SERVER}/api/auth/session`, { headers: { origin: PAGE } });
    const cases: Array<[Request, Response]> = [
      [post(PAGE), new Response('{}', { status: 200 })],
      [post(PAGE), refusal(500, 'boom')],
      [post(SERVER), refusal(403, 'forbidden')],
      [post(null), refusal(403, 'forbidden')],
      [read, refusal(401, 'sign_in_required')],
    ];
    for (const [req, res] of cases) {
      expect(await refusedWriteLine(req, res, policy)).toBeNull();
    }
  });

  it('prints no error text that could spell a person, a path or a token', async () => {
    const secrets = [
      'alice@example.com may not comment',
      '/Users/harborlight/notes.md is missing',
      'wt2.user-1.17.18.d29yaw.b3JpZw is dead',
      `Alice's token`,
      'x'.repeat(41),
    ];
    for (const error of secrets) {
      const line = await refusedWriteLine(
        post(PAGE, { authorization: 'Bearer wt2.secret' }),
        refusal(403, error),
        policy,
      );
      expect(line).toBe('[refused-write] POST status=403 gate=unnamed');
    }
  });

  it('survives a refusal whose body is not JSON, and leaves it readable', async () => {
    const res = new Response('nope', { status: 404 });
    expect(await refusedWriteLine(post(PAGE), res, policy)).toBe(
      '[refused-write] POST status=404 gate=unnamed',
    );
    expect(await res.text()).toBe('nope');
  });
});
