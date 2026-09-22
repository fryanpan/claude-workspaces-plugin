/**
 * The tailnet widget door's pure half: which requests it addresses, which page
 * origins a board token may be minted for, where a socket carries its token,
 * the `wt2` token itself, and the host classification that selects the door.
 *
 * The HTTP half — every refusal through a real server — is
 * `widget-door-http.test.ts`. Fixtures are fictional hosts; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { mintSession } from '../src/auth/session.ts';
import {
  BOARD_WIDGET_TOKEN_TTL_MS,
  mintBoardWidgetToken,
  mintWidgetToken,
  verifyBoardWidgetToken,
  verifyWidgetToken,
  widgetTokenKey,
} from '../src/auth/widget-token.ts';
import { classifyHost, isWidgetDoorHost } from '../src/middleware/host-guard.ts';
import {
  isWidgetDoorOrigin,
  widgetDoorRoute,
  widgetDoorSignInBody,
  widgetTokenFromProtocols,
} from '../src/middleware/widget-door.ts';

const DOOR = 'tailnet-host.test';
const PAGE = `http://${DOOR}:8994`;
const KEY = widgetTokenKey('test-cookie-key');

describe('widgetDoorRoute', () => {
  it('admits the bundle, the mic, the voice chunk and the two probes, by GET only', () => {
    for (const script of ['/widget.iife.js', '/widget/mic.js', '/widget/voice.js']) {
      expect(widgetDoorRoute(script, 'GET'), script).toEqual({ kind: 'bundle' });
      expect(widgetDoorRoute(script, 'POST'), script).toBeNull();
    }
    expect(widgetDoorRoute('/api/auth/session', 'GET')).toEqual({ kind: 'probe' });
    expect(widgetDoorRoute('/api/auth/widget-session', 'GET')).toEqual({ kind: 'probe' });
    expect(widgetDoorRoute('/api/auth/session', 'POST')).toBeNull();
  });

  it("admits one doc's sockets, thread list and thread verbs, each by its own method", () => {
    const doc = { kind: 'doc', workspaceId: 'w-riverbend', docId: 'page-1' } as const;
    for (const get of ['y', 'voice', 'voice-feedback/seg-3.wav']) {
      const path = `/workspaces/w-riverbend/docs/page-1/${get}`;
      expect(widgetDoorRoute(path, 'GET'), get).toEqual(doc);
      expect(widgetDoorRoute(path, 'POST'), get).toBeNull();
    }
    expect(widgetDoorRoute('/workspaces/w-riverbend/docs/page-1/threads', 'GET')).toEqual(doc);
    expect(widgetDoorRoute('/workspaces/w-riverbend/docs/page-1/threads', 'POST')).toEqual(doc);
    for (const verb of ['comments', 'answer', 'resolve', 'reopen', 'edit-comment', 'reanchor']) {
      const path = `/workspaces/w-riverbend/docs/page-1/threads/t1/${verb}`;
      expect(widgetDoorRoute(path, 'POST'), verb).toEqual(doc);
      expect(widgetDoorRoute(path, 'GET'), verb).toBeNull();
    }
    expect(widgetDoorRoute('/workspaces/w-riverbend/docs/page-1/threads', 'DELETE')).toBeNull();
  });

  it('admits a recording only under the name the store writes', () => {
    const doc = { kind: 'doc', workspaceId: 'w-riverbend', docId: 'page-1' } as const;
    const at = (rest: string) =>
      widgetDoorRoute(`/workspaces/w-riverbend/docs/page-1/${rest}`, 'GET');
    expect(at('voice-feedback/seg-999999.wav')).toEqual(doc);
    for (const rest of [
      'voice-feedback.md',
      'voice-feedback/',
      'voice-feedback/seg-3.mp3',
      'voice-feedback/seg-.wav',
      'voice-feedback/seg-1234567.wav',
      'voice-feedback/notes.wav',
      'voice-feedback/x/seg-3.wav',
    ]) {
      expect(at(rest), rest).toBeNull();
    }
  });

  it('decodes the path segments it hands on', () => {
    expect(widgetDoorRoute('/workspaces/w%2Dsaltmarsh/docs/a%20b/threads', 'GET')).toEqual({
      kind: 'doc',
      workspaceId: 'w-saltmarsh',
      docId: 'a b',
    });
  });

  it('refuses every other address on the server, whatever the method', () => {
    for (const path of [
      '/',
      '/widget-auth',
      '/api/auth/widget-token',
      '/api/deploy',
      '/api/plugin/refresh',
      '/api/share',
      '/api/agents/a1/token',
      '/events/agent/a1',
      '/workspaces',
      '/workspaces/w-riverbend',
      '/workspaces/w-riverbend/y',
      '/workspaces/w-riverbend/tasks',
      '/workspaces/w-riverbend/docs',
      '/workspaces/w-riverbend/docs/page-1',
      '/workspaces/w-riverbend/docs/page-1/audio',
      '/workspaces/w-riverbend/docs/page-1/events:stream',
      '/workspaces/w-riverbend/docs/page-1/threads/t1',
      '/workspaces/w-riverbend/docs/page-1/threads/t1/comments/extra',
      '/workspaces/w-riverbend/docs/page-1/y/extra',
      '/widget/widget.iife.js',
      '/widget/mockup-live.js',
      '/widget/voice.js.map',
    ]) {
      for (const method of ['GET', 'POST']) {
        expect(widgetDoorRoute(path, method), `${method} ${path}`).toBeNull();
      }
    }
  });
});

describe('isWidgetDoorOrigin', () => {
  it("accepts a page on the door's hostname, on any port and either scheme", () => {
    expect(isWidgetDoorOrigin(PAGE, [DOOR])).toBe(true);
    expect(isWidgetDoorOrigin(`https://${DOOR}`, [DOOR])).toBe(true);
    expect(isWidgetDoorOrigin(`http://${DOOR}:3000`, [DOOR])).toBe(true);
  });

  it('refuses a suffix, a prefix, another host, and anything a real Origin never is', () => {
    for (const origin of [
      `http://${DOOR}.evil.example`,
      `http://evil-${DOOR}`,
      `http://app.${DOOR}:8994`,
      'http://harborlight.test:8994',
      `${PAGE}/`,
      `${PAGE}/page`,
      `http://user@${DOOR}:8994`,
      `ftp://${DOOR}`,
      'null',
      '',
      'not a url',
    ]) {
      expect(isWidgetDoorOrigin(origin, [DOOR]), origin).toBe(false);
    }
  });

  it('refuses everything when the door has no hostname', () => {
    expect(isWidgetDoorOrigin(PAGE, [])).toBe(false);
    expect(isWidgetDoorOrigin('http://:8994', [''])).toBe(false);
  });
});

describe('widgetTokenFromProtocols', () => {
  it('reads our token out of the offered subprotocols and nothing else', () => {
    expect(widgetTokenFromProtocols('wt2.abc.sig')).toBe('wt2.abc.sig');
    expect(widgetTokenFromProtocols('chat, wt1.abc.sig')).toBe('wt1.abc.sig');
    expect(widgetTokenFromProtocols('chat, superchat')).toBeNull();
    expect(widgetTokenFromProtocols('wt3.abc')).toBeNull();
    expect(widgetTokenFromProtocols('')).toBeNull();
    expect(widgetTokenFromProtocols(null)).toBeNull();
  });
});

describe('widgetDoorSignInBody', () => {
  it('speaks the write gate’s vocabulary, plus where to sign in when known', () => {
    expect(widgetDoorSignInBody('https://operator.example.com')).toEqual({
      error: 'sign_in_required',
      signInToWrite: true,
      signInOrigin: 'https://operator.example.com',
    });
    expect(widgetDoorSignInBody(null)).toEqual({ error: 'sign_in_required', signInToWrite: true });
  });
});

describe('the board widget token (wt2)', () => {
  const now = 1_700_000_000_000;
  const grant = { identityId: 'user-abc123', workspaceId: 'w-riverbend', origin: PAGE };

  it('verifies with the board, the origin and a one-day life', () => {
    const token = mintBoardWidgetToken(grant, KEY, now);
    expect(verifyBoardWidgetToken(token, KEY, now)).toEqual({
      ...grant,
      issuedAt: now,
      expiresAt: now + BOARD_WIDGET_TOKEN_TTL_MS,
    });
    expect(BOARD_WIDGET_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('is dead past its expiry', () => {
    const token = mintBoardWidgetToken(grant, KEY, now);
    expect(verifyBoardWidgetToken(token, KEY, now + BOARD_WIDGET_TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(verifyBoardWidgetToken(token, KEY, now + BOARD_WIDGET_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it('refuses another key, a tampered board, and a session token in its place', () => {
    const token = mintBoardWidgetToken(grant, KEY, now);
    expect(verifyBoardWidgetToken(token, widgetTokenKey('other-cookie-key'), now)).toBeNull();
    const [payload, sig] = [
      token.slice(0, token.lastIndexOf('.')),
      token.slice(token.lastIndexOf('.')),
    ];
    const parts = payload.split('.');
    parts[4] = Buffer.from('w-saltmarsh').toString('base64url');
    expect(verifyBoardWidgetToken(`${parts.join('.')}${sig}`, KEY, now)).toBeNull();
    // The two tags never cross: same key, same scheme, different shapes.
    const session = mintWidgetToken(mintSession('user-abc123', now), PAGE, KEY, now) as string;
    expect(verifyBoardWidgetToken(session, KEY, now)).toBeNull();
    expect(verifyWidgetToken(token, KEY, now)).toBeNull();
  });

  it('keeps a workspace id or origin with dots whole', () => {
    const dotted = { identityId: 'user-abc123', workspaceId: 'w.a.b', origin: 'http://a.b.c:1' };
    const token = mintBoardWidgetToken(dotted, KEY, now);
    expect(verifyBoardWidgetToken(token, KEY, now)).toMatchObject(dotted);
  });
});

describe('isWidgetDoorHost and classifyHost', () => {
  const base = { lookupShare: () => null, widgetDoorHosts: [DOOR] };

  it('classifies the door by exact hostname, port ignored', () => {
    expect(isWidgetDoorHost(`${DOOR}:8960`, base)).toBe(true);
    expect(classifyHost(DOOR, base)).toEqual({ kind: 'widget-door' });
    expect(classifyHost(`evil.${DOOR}`, base)).toEqual({ kind: 'deny', reason: 'unknown_host' });
  });

  it('never through the Cloudflare edge', () => {
    expect(isWidgetDoorHost(DOOR, { ...base, viaProxy: true })).toBe(false);
    expect(classifyHost(DOOR, { ...base, viaProxy: true }).kind).toBe('deny');
  });

  it('grants nothing where the name is already this machine’s own', () => {
    // Access-only off: the tailnet name is `local`, the whole product, exactly
    // as before the door existed.
    expect(classifyHost(DOOR, { ...base, lanHosts: [DOOR] })).toEqual({ kind: 'local' });
  });

  it('does not exist when no hostname is named', () => {
    expect(classifyHost(DOOR, { lookupShare: () => null }).kind).toBe('deny');
    expect(isWidgetDoorHost(DOOR, { widgetDoorHosts: [''] })).toBe(false);
  });
});
