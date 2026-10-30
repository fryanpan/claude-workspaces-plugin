/**
 * No board server accepts a credential another board server issued.
 *
 * Two real servers, Harborlight and Riverbend, each on a fresh data dir, so
 * each makes its own `share-cookie.key`. For every credential type, in both
 * directions, four checks:
 *
 *  1. CONTROL: the issuer accepts what it issued, on the route the type is for.
 *  2. The other server refuses that same value on the same route.
 *  3. CONTROL: a copy of the other server's own genuine value, re-signed
 *     under the other server's own key, is accepted there. This proves the
 *     re-signing in 4 builds a real token, so 4 can fail only on the key.
 *  4. That copy re-signed under the issuer's key, so it carries exactly the
 *     claims the other server accepted (its board, its doc, its record id),
 *     is refused there. This is what a hostile server's operator can make
 *     with the key file they hold, and the case that isolates the key.
 *
 * Every credential type a server issues or accepts, and where each is
 * minted. "Covered here" means the four checks above run over HTTP.
 *
 * Signed with the server's key (`auth/signed-token.ts` formats):
 *  - Session cookie `v3`: `POST /api/auth/verify` (`auth/session.ts`).
 *    Presented to `GET /api/auth/session`. Covered here.
 *  - Widget board token `wt2`, session-bound: `POST /api/auth/widget-token`
 *    (`auth/widget-token.ts`). Presented to `GET /api/auth/widget-session`.
 *    Covered here.
 *  - Widget board token `wt2`, Access-minted (the tailnet door's branch of
 *    the same route): minted here with `mintBoardWidgetToken` and the key
 *    file, as that branch does, because the branch needs a tailnet host.
 *    Covered here.
 *  - Agent token `at1`: `POST /api/agents/:id/token` (`routes/agent-identity.ts`),
 *    which needs the calling process to be the agent's own Claude Code
 *    session, so it is minted here with `mintAgentToken` and the key file.
 *    Presented to `GET /api/agents/:id/watches`. Covered here.
 *  - Board agent token `at2`: `POST /api/board-tokens` (`routes/board-tokens.ts`).
 *    Presented to `POST /api/board-tokens/refresh`. Covered here, plus a
 *    third server holding a copy of the record file but its own key.
 *    The relay (`org-relay/`) and the bound-file sync (`bound-file-sync/`)
 *    hold `at2` values and mint none of their own.
 *  - GitHub push key `gp1`: `POST /api/github-push-keys` (`routes/github-hub.ts`).
 *    Presented to `GET /workspaces/:ws/github/subscriptions`. Covered here.
 *  - Voice API token `vk1`: `POST /api/voice/tokens` (`routes/voice-api.ts`).
 *    Presented to `GET /v1/models`. Covered here.
 *  - App voice token: written into a mock's or app's frame
 *    (`app-voice/token.ts`, `server.ts`); minted here through the handle's
 *    own `appVoice.mint`. Presented to the `/docs/:doc/app-voice` upgrade.
 *    Covered here.
 *  - Frame ticket `ft1`: written into the mock host page's frame address
 *    (`frame-host.ts`). Presented to the frame hostname. Covered here.
 *  - Frame cookie `fc1`: set when the frame hostname redeems a ticket.
 *    Presented to the frame hostname. Covered here.
 *  - Share link cookie `lf_share` (`share/link-session.ts`): retired. Nothing
 *    mints one and no route reads one, so it is checked against each
 *    server's key file only. Covered by key file, no route.
 *  - Widget popup token `wt1`: retired, refused on every server whoever
 *    signed it, so there is no acceptance to control against. Not covered.
 *
 * Kept as state, not signed:
 *  - Email login code (`auth/email-code.ts`), salted hash per server.
 *    Started on both servers for the same address; each code is presented
 *    to the other. Covered here.
 *
 * Signed or proved by someone other than the server, with a per-server
 * setting: the Access stamp for a person and for a service token (the home
 * feed and the relay's pulls), the share-link invitation, the
 * collaboration share, the Recall webhook signature and setup 4's
 * ElevenLabs secret. Those are `cross-server-walls-edge.test.ts`.
 *
 * Not a credential a server issues, so not covered: the keeper's enrolment
 * and request tokens (`keeper/`, a separate process holding Cloudflare and
 * Fly tokens, not a board server), a board's unix socket (a file
 * permission, `board-sockets.ts`), the loopback peer address, Web Push
 * subscriptions (the server signs outbound pushes and accepts none), and
 * the activity lock token (an in-process handle).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { emailIdentityId } from '@claude-workspaces/core';
import { appVoiceToken } from '../src/app-voice/token.ts';
import { agentToken, agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import { boardAgentToken, boardTokensPath } from '../src/auth/board-agent-token.ts';
import { githubPushKey } from '../src/auth/github-push-key.ts';
import { emailSessionToken } from '../src/auth/session.ts';
import { type TokenFormat, mintToken, tokenKey } from '../src/auth/signed-token.ts';
import {
  boardWidgetToken,
  mintBoardWidgetToken,
  widgetTokenKey,
} from '../src/auth/widget-token.ts';
import { FRAME_COOKIE, FRAME_TICKET_PARAM, frameCookie, frameTicket } from '../src/frame-ticket.ts';
import { signSession, verifySession } from '../src/share/link-session.ts';
import { voiceApiToken } from '../src/voice-api/tokens.ts';
import {
  AGENT,
  EMAIL,
  type Server,
  bootServer,
  captureLoginCodes,
  post,
  startCode,
  stopServer,
} from './cross-server-pair.ts';

const DEV_ORIGIN = 'http://127.0.0.1:5173';
const UPGRADE = {
  upgrade: 'websocket',
  connection: 'upgrade',
  'sec-websocket-version': '13',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
};

let harborlight: Server;
let riverbend: Server;
let restoreLog: () => void;

beforeAll(async () => {
  restoreLog = captureLoginCodes();
  harborlight = await bootServer('Harborlight');
  riverbend = await bootServer('Riverbend');
});

afterAll(async () => {
  restoreLog();
  await stopServer(harborlight);
  await stopServer(riverbend);
});

/**
 * `token`'s claims, signed again under `signer`'s key for this format: the
 * value a server holding `signer`'s key file could make.
 */
// biome-ignore lint/suspicious/noExplicitAny: one helper over every format's claims
function resign(format: TokenFormat<any>, token: string, signer: Server): string {
  const claims = format.decode(token.slice(0, token.lastIndexOf('.')));
  expect(claims).not.toBeNull();
  return mintToken(format, claims, tokenKey(signer.key, format));
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The frame address the board's mock host page hands its reader. */
async function frameSrc(s: Server): Promise<URL> {
  const html = await (await fetch(`${s.base}/workspaces/${s.board}/mockups/${s.mock}?v=1`)).text();
  const src = /data-src="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? '';
  return new URL(src);
}

/** The frame hostname's answer to a mock's frame address carrying `ticket`. */
const redeem = (s: Server, ticket: string) =>
  fetch(
    `${s.base}/workspaces/${s.board}/mockups/${s.mock}?v=1&cw-frame=1&${FRAME_TICKET_PARAM}=${encodeURIComponent(ticket)}`,
    { headers: { host: s.frameHost, 'sec-fetch-dest': 'iframe' }, redirect: 'manual' },
  );

interface Wall {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: the table holds every format
  format: TokenFormat<any>;
  /** A genuine value `s` issues for its own board, doc or record. */
  mint(s: Server): Promise<string>;
  /** Whether `s` accepts `token` on the route the type is for. */
  accepts(s: Server, token: string): Promise<boolean>;
}

const WALLS: Wall[] = [
  {
    name: 'session cookie (v3)',
    format: emailSessionToken,
    mint: async (s) => s.cookie.slice(s.cookie.indexOf('=') + 1),
    async accepts(s, token) {
      const res = await fetch(`${s.base}/api/auth/session`, {
        headers: { cookie: `cw_session=${token}` },
      });
      return ((await res.json()) as { authenticated: boolean }).authenticated;
    },
  },
  {
    name: 'widget board token (wt2) a session minted',
    format: boardWidgetToken,
    async mint(s) {
      const res = await post(
        s.base,
        '/api/auth/widget-token',
        { origin: DEV_ORIGIN, workspaceId: s.board },
        { cookie: s.cookie },
      );
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { token: string }).token;
    },
    accepts: async (s, token) =>
      (
        await fetch(`${s.base}/api/auth/widget-session`, {
          headers: { ...bearer(token), origin: DEV_ORIGIN },
        })
      ).status === 200,
  },
  {
    name: 'widget board token (wt2) Access minted',
    format: boardWidgetToken,
    mint: async (s) =>
      mintBoardWidgetToken(
        { identityId: emailIdentityId(EMAIL), workspaceId: s.board, origin: DEV_ORIGIN },
        widgetTokenKey(s.key),
      ),
    accepts: async (s, token) =>
      (
        await fetch(`${s.base}/api/auth/widget-session`, {
          headers: { ...bearer(token), origin: DEV_ORIGIN },
        })
      ).status === 200,
  },
  {
    name: 'agent token (at1)',
    format: agentToken,
    mint: async (s) => mintAgentToken(AGENT, agentTokenKey(s.key)),
    accepts: async (s, token) =>
      (await fetch(`${s.base}/api/agents/${AGENT}/watches`, { headers: bearer(token) })).status ===
      200,
  },
  {
    name: 'board agent token (at2)',
    format: boardAgentToken,
    async mint(s) {
      const res = await post(s.base, '/api/board-tokens', { agentId: AGENT, boardId: s.board });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { token: string }).token;
    },
    accepts: async (s, token) =>
      (
        await fetch(`${s.base}/api/board-tokens/refresh`, {
          method: 'POST',
          headers: bearer(token),
        })
      ).status === 200,
  },
  {
    name: 'GitHub push key (gp1)',
    format: githubPushKey,
    async mint(s) {
      const res = await post(s.base, '/api/github-push-keys', { workspaceId: s.board });
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { key: string }).key;
    },
    accepts: async (s, token) =>
      (
        await fetch(`${s.base}/workspaces/${s.board}/github/subscriptions`, {
          headers: bearer(token),
        })
      ).status === 200,
  },
  {
    name: 'voice API token (vk1)',
    format: voiceApiToken,
    async mint(s) {
      const res = await post(s.base, '/api/voice/tokens', { label: 'phone' });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { token: string }).token;
    },
    accepts: async (s, token) =>
      (await fetch(`${s.base}/v1/models`, { headers: bearer(token) })).status === 200,
  },
  {
    name: 'app voice token',
    format: appVoiceToken,
    mint: async (s) => s.handle.appVoice.mint(s.board, s.mock).token,
    accepts: async (s, token) =>
      (
        await fetch(
          `${s.base}/workspaces/${s.board}/docs/${s.mock}/app-voice?token=${encodeURIComponent(token)}`,
          { headers: { ...UPGRADE, origin: 'null' } },
        )
      ).status === 101,
  },
  {
    name: 'frame ticket (ft1)',
    format: frameTicket,
    async mint(s) {
      const ticket = (await frameSrc(s)).searchParams.get(FRAME_TICKET_PARAM);
      expect(ticket).toBeTruthy();
      return ticket ?? '';
    },
    accepts: async (s, token) => (await redeem(s, token)).status === 303,
  },
  {
    name: 'frame cookie (fc1)',
    format: frameCookie,
    async mint(s) {
      const ticket = (await frameSrc(s)).searchParams.get(FRAME_TICKET_PARAM) ?? '';
      const set = (await redeem(s, ticket)).headers.get('set-cookie') ?? '';
      expect(set.startsWith(`${FRAME_COOKIE}=`)).toBe(true);
      return set.slice(FRAME_COOKIE.length + 1).split(';')[0] ?? '';
    },
    accepts: async (s, token) =>
      (
        await fetch(`${s.base}/workspaces/${s.board}/mockups/${s.mock}?cw-frame=1`, {
          headers: {
            host: s.frameHost,
            'sec-fetch-dest': 'iframe',
            cookie: `${FRAME_COOKIE}=${token}`,
          },
        })
      ).status === 200,
  },
];

const pairs = (): [Server, Server][] => [
  [harborlight, riverbend],
  [riverbend, harborlight],
];

describe('each server makes its own key', () => {
  it('different on Harborlight and Riverbend', () => {
    expect(harborlight.key).not.toBe(riverbend.key);
  });
});

for (const wall of WALLS) {
  describe(wall.name, () => {
    for (const forward of [true, false]) {
      const direction = forward ? 'Harborlight → Riverbend' : 'Riverbend → Harborlight';
      it(`issued by one, refused by the other: ${direction}`, async () => {
        const [issuer, other] = forward ? [harborlight, riverbend] : [riverbend, harborlight];
        const issued = await wall.mint(issuer);
        expect(await wall.accepts(issuer, issued)).toBe(true);
        expect(await wall.accepts(other, issued)).toBe(false);

        const own = await wall.mint(other);
        expect(await wall.accepts(other, resign(wall.format, own, other))).toBe(true);
        expect(await wall.accepts(other, resign(wall.format, own, issuer))).toBe(false);
      });
    }
  });
}

describe('board agent token (at2) on a copied data dir', () => {
  it('a third server holding the record but its own key refuses the value', async () => {
    const res = await post(harborlight.base, '/api/board-tokens', {
      agentId: AGENT,
      boardId: harborlight.board,
    });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    const copy = await bootServer('Saltmarsh', {
      beforeStart: (dir) =>
        copyFileSync(boardTokensPath(harborlight.dataDir), boardTokensPath(dir)),
    });
    try {
      const refresh = (s: Server) =>
        fetch(`${s.base}/api/board-tokens/refresh`, { method: 'POST', headers: bearer(token) });
      expect((await refresh(harborlight)).status).toBe(200);
      expect((await refresh(copy)).status).toBe(401);
    } finally {
      await stopServer(copy);
    }
  });
});

describe('email login code', () => {
  it("each server's code is refused by the other, and accepted by its own", async () => {
    let fromHarborlight = await startCode(harborlight.base);
    let fromRiverbend = await startCode(riverbend.base);
    // Two six-digit codes match one time in a million; start again if so.
    while (fromHarborlight === fromRiverbend) {
      fromHarborlight = await startCode(harborlight.base);
      fromRiverbend = await startCode(riverbend.base);
    }
    const verify = (s: Server, code: string) =>
      post(s.base, '/api/auth/verify', { email: EMAIL, code }).then((r) => r.status);
    expect(await verify(riverbend, fromHarborlight)).not.toBe(200);
    expect(await verify(harborlight, fromRiverbend)).not.toBe(200);
    expect(await verify(harborlight, fromHarborlight)).toBe(200);
    expect(await verify(riverbend, fromRiverbend)).toBe(200);
  });
});

describe('share link cookie (retired, no route reads it)', () => {
  it("verifies only under its signer's key file", () => {
    for (const [issuer, other] of pairs()) {
      const cookie = signSession(`sh-${issuer.name.toLowerCase()}`, issuer.key);
      expect(verifySession(cookie, issuer.key)).toBe(`sh-${issuer.name.toLowerCase()}`);
      expect(verifySession(cookie, other.key)).toBeNull();
    }
  });
});
