/**
 * The router's frame domain (infra/board-router-worker): a request to
 * `<project>.<frame domain>` reaches that project's origin and no other,
 * carries the frame cookie and nothing else, and a frame domain on the
 * board's own site routes nothing. Each refusal is paired with the request
 * that passes once the one thing it lacked is present.
 */
import { describe, expect, it } from 'bun:test';
import { frameCookies, handleBoardRequest } from '../../../infra/board-router-worker/worker.js';

const ONE_HOST = 'workspaces.harborlight.test';
const FRAME_DOMAIN = 'saltmarsh-frames.test';
const MAC = 'mac-origin.harborlight.test';
const RIVERBEND = 'riverbend-origin.harborlight.test';
const ENV: Record<string, string> = {
  ONE_ADDRESS: ONE_HOST,
  FRAME_DOMAIN,
  PROJECT_ORIGINS: JSON.stringify({ harborlight: MAC, riverbend: RIVERBEND }),
  BOARD_ORIGINS: JSON.stringify({ [MAC]: ['w-mac1'] }),
};

const send = async (url: string, init: RequestInit = {}, env = ENV) => {
  const calls: { request: Request; origin: string }[] = [];
  const res = await handleBoardRequest(new Request(url, init), env, async (request, i) => {
    calls.push({ request, origin: i.cf.resolveOverride });
    return new Response('ok');
  });
  return { res, calls };
};

const APP = '/workspaces/w-mac1/apps/d-door/door.js';

describe("a project's frame hostname reaches that project and no other", () => {
  it("sends the frame hostname to its project's origin, path and query kept", async () => {
    const { res, calls } = await send(`https://harborlight.${FRAME_DOMAIN}${APP}?v=2`);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.origin)).toEqual([MAC]);
    expect(new URL(calls[0]?.request.url ?? '').host).toBe(`harborlight.${FRAME_DOMAIN}`);
  });

  it("CONTROL: another project's frame hostname reaches its own origin", async () => {
    const { calls } = await send(`https://riverbend.${FRAME_DOMAIN}${APP}`);
    expect(calls.map((c) => c.origin)).toEqual([RIVERBEND]);
  });

  it('answers 404 for an unlisted project, a deeper name, and calls nothing', async () => {
    for (const host of [`saltmarsh.${FRAME_DOMAIN}`, `a.harborlight.${FRAME_DOMAIN}`]) {
      const { res, calls } = await send(`https://${host}${APP}`);
      expect(res.status).toBe(404);
      expect(calls).toEqual([]);
    }
  });

  it("routes no frame when the frame domain is on the board's own site", async () => {
    for (const domain of [ONE_HOST, `frames.${ONE_HOST}`, 'harborlight.test']) {
      const { res, calls } = await send(
        `https://harborlight.${domain}${APP}`,
        {},
        {
          ...ENV,
          FRAME_DOMAIN: domain,
        },
      );
      expect(res.status).toBe(404);
      expect(calls).toEqual([]);
    }
  });

  it('routes no frame at all when no frame domain is configured', async () => {
    const { FRAME_DOMAIN: _, ...without } = ENV;
    const { res, calls } = await send(`https://harborlight.${FRAME_DOMAIN}${APP}`, {}, without);
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('a frame hostname carries the frame cookie and nothing else', () => {
  it('keeps only cw_frame, every copy of it', () => {
    expect(frameCookies('cw_session=s; cw_frame=a.1; CF_Authorization=t; cw_frame=b.2')).toBe(
      'cw_frame=a.1; cw_frame=b.2',
    );
    expect(frameCookies('__Host-cw_session=s; lf_share=x')).toBeNull();
  });

  it("drops the board's session and share cookies on the way to the frame hostname", async () => {
    const { calls } = await send(`https://harborlight.${FRAME_DOMAIN}${APP}`, {
      headers: { cookie: '__Host-cw_session=s; lf_share=x; cw_frame=a.1' },
    });
    expect(calls[0]?.request.headers.get('cookie')).toBe('cw_frame=a.1');
  });

  it('CONTROL: the same cookies reach a board subdomain as they always did', async () => {
    const { calls } = await send(`https://harborlight.${ONE_HOST}/workspaces/w-mac1`, {
      headers: { cookie: '__Host-cw_session=s; lf_share=x; cw_frame=a.1' },
    });
    expect(calls[0]?.request.headers.get('cookie')).toBe('__Host-cw_session=s; lf_share=x');
  });
});
