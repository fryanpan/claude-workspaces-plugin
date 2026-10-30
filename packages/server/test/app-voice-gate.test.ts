/**
 * Who is handed an app voice token, and who may open the socket with one.
 *
 * The socket's refusals of a share visitor and of a signed-in person who is
 * not the owner are driven through the upgrade route itself with each kind of
 * caller, as `spoken-reply-route.test.ts` does: a whole share-link or sign-in
 * flow would be testing the share or the sign-in instead. Each refusal is
 * paired with the same request from the owner, which opens.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_VOICE_SEED_ATTR } from '@claude-workspaces/core/app-voice';
import { mayMintAppVoice, refuseAppVoice } from '../src/app-voice/gate.ts';
import { withAppVoiceSeed } from '../src/app-voice/seed.ts';
import { appVoiceTokenKey, checkAppVoiceToken, mintAppVoiceToken } from '../src/app-voice/token.ts';
import type { ShareTarget } from '../src/middleware/host-guard.ts';
import { createUpgradeStream } from '../src/routes/upgrade-stream.ts';
import { createServer } from '../src/server.ts';
import type { UpgradeData } from '../src/socket-handlers.ts';

const KEY = appVoiceTokenKey('a-test-cookie-key');
const OWNER_SPEAKS = {
  visitor: false,
  ownerProven: true,
  anyoneProven: true,
  mustSignIn: false,
  frameGrant: false,
};

describe('who is handed a token with the frame', () => {
  it('the owner, signed in, and a local page where nobody has to sign in', () => {
    expect(mayMintAppVoice(OWNER_SPEAKS)).toBe(true);
    expect(
      mayMintAppVoice({
        visitor: false,
        ownerProven: false,
        anyoneProven: false,
        mustSignIn: false,
        frameGrant: false,
      }),
    ).toBe(true);
  });

  it('never a share or collab visitor, a non-owner, or nobody where sign-in is on', () => {
    expect(mayMintAppVoice({ ...OWNER_SPEAKS, visitor: true })).toBe(false);
    expect(mayMintAppVoice({ ...OWNER_SPEAKS, ownerProven: false })).toBe(false);
    expect(
      mayMintAppVoice({
        visitor: false,
        ownerProven: false,
        anyoneProven: false,
        mustSignIn: true,
        frameGrant: false,
      }),
    ).toBe(false);
  });

  it("a frame on the frame hostname whose host page's reader was given one", () => {
    const framed = {
      visitor: false,
      ownerProven: false,
      anyoneProven: false,
      mustSignIn: true,
      frameGrant: true,
    };
    expect(mayMintAppVoice(framed)).toBe(true);
    // A person proof on the frame request itself still decides first.
    expect(mayMintAppVoice({ ...framed, visitor: true })).toBe(false);
    expect(mayMintAppVoice({ ...framed, anyoneProven: true })).toBe(false);
  });

  it('writes the seed only into a page that loads the client', () => {
    const seed = { socket: '/workspaces/w/docs/d/app-voice', token: 't</script>', expiresAt: 1 };
    const loads = '<html><head><script src="/widget/app-voice.js"></script></head></html>';
    const out = withAppVoiceSeed(loads, () => seed);
    expect(out).toContain(`<script type="application/json" ${APP_VOICE_SEED_ATTR}>`);
    // A value cannot end the element early.
    expect(out).not.toContain('t</script>');
    expect(withAppVoiceSeed('<html><head></head></html>', () => seed)).toBe(
      '<html><head></head></html>',
    );
    expect(withAppVoiceSeed(loads, () => null)).toBe(loads);
  });
});

describe('the token', () => {
  it('opens its own doc on its own board until it expires', () => {
    const now = 1_800_000_000_000;
    const { token, expiresAt } = mintAppVoiceToken(KEY, 'w-harbor', 'd.river.bend', now);
    expect(checkAppVoiceToken(KEY, token, 'w-harbor', 'd.river.bend', now)).toEqual({ ok: true });
    expect(checkAppVoiceToken(KEY, token, 'w-harbor', 'd-saltmarsh', now)).toEqual({
      ok: false,
      reason: 'other_doc',
    });
    expect(checkAppVoiceToken(KEY, token, 'w-other', 'd.river.bend', now)).toEqual({
      ok: false,
      reason: 'other_doc',
    });
    expect(checkAppVoiceToken(KEY, token, 'w-harbor', 'd.river.bend', expiresAt)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(
      checkAppVoiceToken(appVoiceTokenKey('another-key'), token, 'w-harbor', 'd.river.bend', now),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    expect(checkAppVoiceToken(KEY, null, 'w-harbor', 'd.river.bend', now)).toEqual({
      ok: false,
      reason: 'absent',
    });
  });
});

describe('who may open the socket', () => {
  const base = {
    visitor: false,
    ownerProven: false,
    anyoneProven: false,
    origin: 'null',
    originAllowed: false,
    frameOrigin: null,
    token: { ok: true as const },
  };

  it('a sandboxed frame, a page on this server, and the frame hostname, each with a token', () => {
    expect(refuseAppVoice(base)).toBeNull();
    expect(refuseAppVoice({ ...base, origin: null })).toBeNull();
    expect(
      refuseAppVoice({ ...base, origin: 'https://board.test', originAllowed: true }),
    ).toBeNull();
    expect(
      refuseAppVoice({
        ...base,
        origin: 'https://frames.board.test',
        frameOrigin: 'https://frames.board.test',
      }),
    ).toBeNull();
  });

  it('nobody without a good token, and no page on another site with one', () => {
    expect(refuseAppVoice({ ...base, token: { ok: false, reason: 'absent' } })?.status).toBe(401);
    expect(refuseAppVoice({ ...base, origin: 'https://elsewhere.example.com' })?.status).toBe(403);
  });
});

describe('the upgrade, with a valid token', () => {
  const run = (who: {
    visitor?: ShareTarget | null;
    ownerProven?: boolean;
    anyoneProven?: boolean;
  }): { status: number | 'upgraded'; data?: UpgradeData } => {
    let data: UpgradeData | undefined;
    const stream = createUpgradeStream({
      server: {
        upgrade: (_req: Request, o: { data: UpgradeData }) => {
          data = o.data;
          return true;
        },
      },
      docStore: { get: (id: string) => ({ docId: id }) },
      isValidDocId: () => true,
      workspacesOfMember: () => ['w-harbor'],
      policyFor: () => ({ allowedOrigins: [] }),
      j: (status: number, body: unknown) => Response.json(body, { status }),
      appVoiceToken: (token: string | null, ws: string, doc: string) =>
        checkAppVoiceToken(KEY, token, ws, doc),
      frameOrigin: null,
    } as never);
    const { token } = mintAppVoiceToken(KEY, 'w-harbor', 'd-riverbend');
    const url = new URL(
      `http://localhost/workspaces/w-harbor/docs/d-riverbend/app-voice?token=${encodeURIComponent(token)}`,
    );
    const out = stream.serveUpgradeAndStreamRoutes({
      req: new Request(url, { headers: { origin: 'null' } }),
      url,
      pathname: url.pathname,
      visitor: who.visitor ?? null,
      visitorShareId: who.visitor ? 's1' : null,
      visitorMemberKey: null,
      ownerProven: () => who.ownerProven === true,
      anyoneProven: () => who.anyoneProven === true,
      browserProvedNobody: () => who.anyoneProven !== true,
      provenAuthor: () => null,
      widgetDoorGrant: null,
      widgetTokenProved: false,
    });
    if (out?.kind === 'upgraded') return { status: 'upgraded', ...(data ? { data } : {}) };
    return { status: out?.kind === 'response' ? out.response.status : 0 };
  };

  it('opens for the owner, and for a frame that proves nobody', () => {
    const owner = run({ ownerProven: true, anyoneProven: true });
    expect(owner.status).toBe('upgraded');
    expect(owner.data).toMatchObject({
      kind: 'app-voice',
      docId: 'd-riverbend',
      workspaceId: 'w-harbor',
    });
    expect(run({}).status).toBe('upgraded');
  });

  it('refuses a share visitor', () => {
    expect(run({ visitor: { workspaceId: 'w-harbor' } as ShareTarget }).status).toBe(403);
  });

  it('refuses a signed-in person who is not the owner', () => {
    expect(run({ anyoneProven: true }).status).toBe(403);
  });

  it("serves no token in an app's frame to a browser that proved nobody where sign-in is on", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-app-voice-strict-'));
    const strict = createServer({ port: 0, dataDir, requireSignInToWrite: true });
    const page = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(
          '<!doctype html><html><head><script src="/widget/app-voice.js"></script></head></html>',
          { headers: { 'content-type': 'text/html' } },
        ),
    });
    try {
      const at = `http://127.0.0.1:${strict.port}`;
      const made = await fetch(`${at}/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Harborlight' }),
      });
      const board = ((await made.json()) as { workspace: { id: string } }).workspace.id;
      const attached = await fetch(`${at}/workspaces/${board}/apps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'riverbend-pilot', origin: `http://127.0.0.1:${page.port}` }),
      });
      const doc = ((await attached.json()) as { docId: string }).docId;
      const frame = `${at}/workspaces/${board}/apps/${doc}/?cw-frame=1`;
      const browser = await fetch(frame, { headers: { 'sec-fetch-dest': 'iframe' } });
      expect(await browser.text()).not.toContain(APP_VOICE_SEED_ATTR);
      // The positive control: the same frame for a caller on this machine
      // that is not a browser carries one.
      expect(await (await fetch(frame)).text()).toContain(APP_VOICE_SEED_ATTR);
    } finally {
      await strict.stop();
      page.stop(true);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
