/**
 * The pure half of an attached app: which origins may be bound, which
 * proxied paths stay inside the app, and which headers cross the proxy.
 */
import { describe, expect, it } from 'bun:test';
import {
  LOOPBACK_RULE,
  appPrefix,
  isHtmlResponse,
  parseLoopbackOrigin,
  relayedLocation,
  relayedResponseHeaders,
  upstreamRequestHeaders,
  upstreamUrl,
} from '../src/app-proxy.ts';

const ORIGIN = 'http://127.0.0.1:4321';
const PREFIX = '/workspaces/w-1/apps/d-1/';

describe('parseLoopbackOrigin', () => {
  it('accepts both loopback spellings with a port, normalised', () => {
    expect(parseLoopbackOrigin('http://127.0.0.1:4321')).toEqual({ ok: true, origin: ORIGIN });
    expect(parseLoopbackOrigin(' http://localhost:5173/ ')).toEqual({
      ok: true,
      origin: 'http://localhost:5173',
    });
  });

  it('refuses everything else with the rule in words', () => {
    for (const bad of [
      undefined,
      '',
      'not a url',
      'https://127.0.0.1:4321',
      'http://example.com:4321',
      'http://10.0.0.5:4321',
      'http://[::1]:4321',
      'http://0.0.0.0:4321',
      'http://127.0.0.2:4321',
      'http://127.0.0.1',
      'http://127.0.0.1:4321/app',
      'http://127.0.0.1:4321/?q=1',
      'http://127.0.0.1:4321/#x',
      'http://user:pw@127.0.0.1:4321',
      'file:///etc/passwd',
    ]) {
      expect(parseLoopbackOrigin(bad)).toEqual({ ok: false, error: LOOPBACK_RULE });
    }
  });

  it("refuses this server's own port", () => {
    const r = parseLoopbackOrigin('http://localhost:8787', 8787);
    expect(r.ok).toBe(false);
    expect(parseLoopbackOrigin('http://localhost:8788', 8787).ok).toBe(true);
  });
});

describe('appPrefix', () => {
  it('ends in a slash and encodes both ids', () => {
    expect(appPrefix('w-1', 'd-1')).toBe(PREFIX);
    expect(appPrefix('w 1', 'd/1')).toBe('/workspaces/w%201/apps/d%2F1/');
  });
});

describe('upstreamUrl', () => {
  it('maps the tail onto the bound origin and keeps the query minus the frame flag', () => {
    expect(upstreamUrl(ORIGIN, '', '')?.href).toBe(`${ORIGIN}/`);
    expect(upstreamUrl(ORIGIN, 'events/2026/', '?a=1&cw-frame=1')?.href).toBe(
      `${ORIGIN}/events/2026/?a=1`,
    );
    expect(upstreamUrl(ORIGIN, '__reload', '?cw-frame=1')?.href).toBe(`${ORIGIN}/__reload`);
  });

  it('refuses any tail that could name another host or climb out', () => {
    for (const tail of [
      '/evil.example/x',
      '//evil.example',
      'a\\b',
      '..',
      'a/../b',
      '%2e%2e/x',
      'a/%2E',
      'a%2Fb',
      'a%5Cb',
      'a%00b',
      '%zz',
    ]) {
      expect(upstreamUrl(ORIGIN, tail, '')).toBeNull();
    }
  });
});

describe('upstreamRequestHeaders', () => {
  it('forwards negotiation and resume headers, never who the reader is', () => {
    const out = upstreamRequestHeaders(
      new Headers({
        accept: 'text/event-stream',
        'last-event-id': '7',
        cookie: 'cw_session=secret',
        authorization: 'Bearer x',
        'cf-access-jwt-assertion': 'jwt',
        'accept-encoding': 'gzip, br',
        host: 'board.example',
      }),
    );
    expect(Object.fromEntries(out)).toEqual({
      accept: 'text/event-stream',
      'last-event-id': '7',
      'accept-encoding': 'identity',
    });
  });
});

describe('relayedResponseHeaders', () => {
  it('drops hop-by-hop, declared, cookie, length, encoding and framing headers', () => {
    const from = new Headers([
      ['content-type', 'text/css'],
      ['etag', '"abc"'],
      ['connection', 'keep-alive, x-private'],
      ['keep-alive', 'timeout=5'],
      ['x-private', 'yes'],
      ['transfer-encoding', 'chunked'],
      ['set-cookie', 'a=1'],
      ['content-length', '10'],
      ['content-encoding', 'gzip'],
      ['content-security-policy', "default-src 'self'"],
      ['x-frame-options', 'DENY'],
      ['strict-transport-security', 'max-age=1'],
    ]);
    const out = relayedResponseHeaders(from, ORIGIN, PREFIX);
    expect(Object.fromEntries(out)).toEqual({
      'content-type': 'text/css',
      etag: '"abc"',
      'x-content-type-options': 'nosniff',
    });
  });

  it('moves a redirect on the bound origin under the prefix', () => {
    const out = relayedResponseHeaders(new Headers({ location: '/about/' }), ORIGIN, PREFIX);
    expect(out.get('location')).toBe(`${PREFIX}about/`);
  });
});

describe('relayedLocation', () => {
  it('keeps the app inside its prefix, and leaves a foreign host alone', () => {
    expect(relayedLocation(`${ORIGIN}/a?b=1#c`, ORIGIN, PREFIX)).toBe(`${PREFIX}a?b=1#c`);
    expect(relayedLocation(`${PREFIX}a`, ORIGIN, PREFIX)).toBe(`${PREFIX}a`);
    expect(relayedLocation('https://other.example/x', ORIGIN, PREFIX)).toBe(
      'https://other.example/x',
    );
  });
});

describe('isHtmlResponse', () => {
  it('reads the media type, not the parameters', () => {
    expect(isHtmlResponse(new Headers({ 'content-type': 'text/html; charset=utf-8' }))).toBe(true);
    expect(isHtmlResponse(new Headers({ 'content-type': 'application/xhtml+xml' }))).toBe(true);
    expect(isHtmlResponse(new Headers({ 'content-type': 'text/event-stream' }))).toBe(false);
    expect(isHtmlResponse(new Headers())).toBe(false);
  });
});
