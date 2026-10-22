/**
 * The outbound guard: which addresses the server will connect to.
 *
 * Nothing here reaches the internet. Names resolve through an injected
 * resolver, and a request the guard lets through either goes to a recording
 * transport or to a stub on 127.0.0.1 that a test permits by name — so every
 * refusal has a public address beside it that the same instance accepts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type AddressRange,
  OutboundRefused,
  type ResolvedAddress,
  classifyAddress,
  configuredHostFetch,
  createPublicFetch,
  isVendorHost,
  loopbackFetch,
  publicFetch,
} from '../src/outbound-fetch.ts';

/** A public address: the positive control for every refused range. */
const PUBLIC_V4 = '8.8.8.8';

interface Recorded {
  url: string;
  host: string | null;
  redirect: RequestRedirect | undefined;
}

/** A public fetch whose names resolve from `table` and whose requests are recorded, not sent. */
function recording(
  table: Record<string, string[]>,
  reply: (url: string) => Response = () => new Response('ok'),
) {
  const sent: Recorded[] = [];
  const lookups: string[] = [];
  const guarded = createPublicFetch({
    resolve: async (host) => {
      lookups.push(host);
      return (table[host] ?? []).map(
        (address): ResolvedAddress => ({ address, family: address.includes(':') ? 6 : 4 }),
      );
    },
    transport: async (url, init) => {
      sent.push({
        url,
        host: new Headers(init.headers).get('host'),
        redirect: init.redirect,
      });
      return reply(url);
    },
  });
  return { guarded, sent, lookups };
}

async function refusal(p: Promise<unknown>): Promise<OutboundRefused> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OutboundRefused) return err;
    throw err;
  }
  throw new Error('expected the request to be refused');
}

describe('classifyAddress', () => {
  const cases: [string, AddressRange][] = [
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['::1', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.254', 'cgnat'],
    ['169.254.169.254', 'link-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fdaa:0:1::3', 'fly-internal'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['ff02::1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    // IPv4 carried inside IPv6 is judged as the IPv4 address it carries.
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:8.8.8.8', 'public'],
    ['64:ff9b::a9fe:a9fe', 'link-local'],
    ['2002:c0a8:0101::1', 'private'],
    ['2002:0808:0808::1', 'public'],
    ['not-an-ip', 'reserved'],
  ];
  for (const [address, range] of cases) {
    it(`${address} is ${range}`, () => {
      expect(classifyAddress(address)).toBe(range);
    });
  }
});

describe('publicFetch refuses every non-public range', () => {
  const refused: [string, string, Exclude<AddressRange, 'public'>][] = [
    ['loopback', '127.0.0.1', 'loopback'],
    ['RFC 1918 10/8', '10.1.2.3', 'private'],
    ['RFC 1918 172.16/12', '172.20.0.5', 'private'],
    ['RFC 1918 192.168/16', '192.168.0.10', 'private'],
    ['CGNAT and the tailnet', '100.100.1.1', 'cgnat'],
    ['cloud metadata (link-local)', '169.254.169.254', 'link-local'],
    ['IPv6 link-local', 'fe80::abcd', 'link-local'],
    ['ULA', 'fd00::5', 'unique-local'],
    ['Fly private network', 'fdaa:0:3b9::2', 'fly-internal'],
    ['unspecified', '0.0.0.0', 'unspecified'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1', 'loopback'],
  ];
  for (const [label, address, range] of refused) {
    it(`${label}: ${address} is refused, a public address is not`, async () => {
      const { guarded, sent } = recording({
        'riverbend.test': [address],
        'harborlight.test': [PUBLIC_V4],
      });
      const err = await refusal(guarded('http://riverbend.test/hook'));
      expect(err.range).toBe(range);
      expect(sent).toHaveLength(0);

      const res = await guarded('http://harborlight.test/hook');
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
    });
  }

  it('refuses a Fly-internal name without resolving it', async () => {
    const { guarded, sent, lookups } = recording({ 'harborlight.test': [PUBLIC_V4] });
    const err = await refusal(guarded('http://riverbend.internal/'));
    expect(err.range).toBe('fly-internal');
    expect(lookups).toEqual([]);
    await guarded('http://harborlight.test/');
    expect(sent.map((s) => s.host)).toEqual(['harborlight.test']);
  });

  it('refuses localhost by name, and an IP literal without a lookup', async () => {
    const { guarded, lookups } = recording({});
    expect((await refusal(guarded('http://localhost:8787/'))).range).toBe('loopback');
    expect((await refusal(guarded('http://app.localhost/'))).range).toBe('loopback');
    expect((await refusal(guarded('http://127.0.0.1:8787/'))).range).toBe('loopback');
    expect((await refusal(guarded('http://[::1]/'))).range).toBe('loopback');
    // The URL parser folds the decimal spelling of 127.0.0.1 back to dotted.
    expect((await refusal(guarded('http://2130706433/'))).range).toBe('loopback');
    expect((await refusal(guarded('http://169.254.169.254/latest/meta-data/'))).range).toBe(
      'link-local',
    );
    expect(lookups).toEqual([]);
  });

  it('refuses a name with one private record among public ones', async () => {
    const { guarded, sent } = recording({ 'riverbend.test': [PUBLIC_V4, '10.0.0.7'] });
    expect((await refusal(guarded('https://riverbend.test/'))).range).toBe('private');
    expect(sent).toHaveLength(0);
  });

  it('refuses schemes other than http and https', async () => {
    const { guarded } = recording({});
    expect((await refusal(guarded('file:///etc/hosts'))).range).toBe('scheme');
    expect((await refusal(guarded('data:text/plain,hi'))).range).toBe('scheme');
  });

  it('refuses a Request, whose method and body it would have to copy', async () => {
    const { guarded } = recording({ 'harborlight.test': [PUBLIC_V4] });
    await expect(guarded(new Request('http://harborlight.test/'))).rejects.toThrow(TypeError);
  });

  it('the production instance refuses loopback too', async () => {
    expect((await refusal(publicFetch('http://127.0.0.1:1/'))).range).toBe('loopback');
  });
});

describe('publicFetch pins the address it checked', () => {
  it('connects to the checked address and names the host in the Host header', async () => {
    const { guarded, sent } = recording({ 'harborlight.test': [PUBLIC_V4] });
    await guarded('http://harborlight.test:8080/a?b=1', { headers: { 'x-probe': '1' } });
    expect(sent).toEqual([
      { url: `http://${PUBLIC_V4}:8080/a?b=1`, host: 'harborlight.test:8080', redirect: 'manual' },
    ]);
  });

  it('resolves once, so a name that rebinds after the check is never re-resolved', async () => {
    const answers = [[PUBLIC_V4], ['127.0.0.1']];
    let calls = 0;
    const sent: string[] = [];
    const guarded = createPublicFetch({
      resolve: async () => (answers[calls++] ?? []).map((address) => ({ address, family: 4 })),
      transport: async (url) => {
        sent.push(url);
        return new Response('ok');
      },
    });
    await guarded('http://riverbend.test/');
    expect(calls).toBe(1);
    expect(sent).toEqual([`http://${PUBLIC_V4}/`]);
  });

  it('brackets an IPv6 address', async () => {
    const { guarded, sent } = recording({ 'harborlight.test': ['2606:4700:4700::1111'] });
    await guarded('https://harborlight.test/');
    expect(sent[0]?.url).toBe('https://[2606:4700:4700::1111]/');
  });
});

describe('publicFetch and redirects', () => {
  it('refuses a redirect from a public address to a private one', async () => {
    const { guarded, sent } = recording(
      { 'harborlight.test': [PUBLIC_V4], 'riverbend.test': ['10.0.0.9'] },
      () => new Response(null, { status: 302, headers: { location: 'http://riverbend.test/' } }),
    );
    const err = await refusal(guarded('http://harborlight.test/'));
    expect(err.range).toBe('private');
    expect(sent).toHaveLength(1);
  });

  it('refuses a redirect to the cloud metadata address', async () => {
    const { guarded } = recording(
      { 'harborlight.test': [PUBLIC_V4] },
      () =>
        new Response(null, {
          status: 307,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
    );
    expect((await refusal(guarded('http://harborlight.test/'))).range).toBe('link-local');
  });

  it('hands a redirect to a public address back without following it', async () => {
    const { guarded, sent } = recording(
      { 'harborlight.test': [PUBLIC_V4], 'saltmarsh.test': ['1.1.1.1'] },
      () => new Response(null, { status: 302, headers: { location: 'http://saltmarsh.test/' } }),
    );
    const res = await guarded('http://harborlight.test/');
    expect(res.status).toBe(302);
    expect(sent).toHaveLength(1);
  });
});

describe('against a real socket', () => {
  let stub: ReturnType<typeof Bun.serve>;
  let seen: { host: string | null; path: string }[] = [];
  beforeAll(() => {
    stub = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        seen.push({ host: req.headers.get('host'), path: url.pathname });
        if (url.pathname === '/to-metadata') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          });
        }
        if (url.pathname === '/to-self') {
          return new Response(null, { status: 302, headers: { location: '/landed' } });
        }
        return new Response('stub');
      },
    });
  });
  afterAll(() => {
    stub.stop(true);
  });

  const toStub = (): Promise<ResolvedAddress[]> =>
    Promise.resolve([{ address: '127.0.0.1', family: 4 }]);

  it('reaches the pinned address with the original Host when loopback is permitted', async () => {
    seen = [];
    const guarded = createPublicFetch({ resolve: toStub, permit: new Set(['loopback']) });
    const res = await guarded(`http://harborlight.test:${stub.port}/hello`);
    expect(await res.text()).toBe('stub');
    expect(seen).toEqual([{ host: `harborlight.test:${stub.port}`, path: '/hello' }]);
  });

  it('the same name is refused when loopback is not permitted', async () => {
    seen = [];
    const guarded = createPublicFetch({ resolve: toStub });
    expect((await refusal(guarded(`http://harborlight.test:${stub.port}/`))).range).toBe(
      'loopback',
    );
    expect(seen).toEqual([]);
  });

  it('refuses a real redirect to the metadata address', async () => {
    const guarded = createPublicFetch({ resolve: toStub, permit: new Set(['loopback']) });
    expect((await refusal(guarded(`http://harborlight.test:${stub.port}/to-metadata`))).range).toBe(
      'link-local',
    );
  });

  it('loopbackFetch reaches a loopback origin and does not follow its redirect', async () => {
    seen = [];
    const res = await loopbackFetch('attached-app')(`http://127.0.0.1:${stub.port}/to-self`);
    expect(res.status).toBe(302);
    expect(seen.map((s) => s.path)).toEqual(['/to-self']);
  });

  it('loopbackFetch refuses anything not written as loopback', async () => {
    const own = loopbackFetch('own-server');
    expect((await refusal(own('http://harborlight.test/'))).range).toBe('host');
    expect((await refusal(own(`https://127.0.0.1:${stub.port}/`))).range).toBe('host');
    expect((await refusal(own('http://10.0.0.1/'))).range).toBe('host');
  });

  it('configuredHostFetch reaches a configured origin and refuses any other', async () => {
    const configured = configuredHostFetch([`http://127.0.0.1:${stub.port}`]);
    const res = await configured(`http://127.0.0.1:${stub.port}/feed`);
    expect(await res.text()).toBe('stub');
    expect((await refusal(configured(`http://127.0.0.1:${(stub.port ?? 0) + 1}/feed`))).range).toBe(
      'host',
    );
    expect((await refusal(configured('https://riverbend.test/feed'))).range).toBe('host');
  });
});

describe('vendor hosts', () => {
  it('admits the vendors and their named subdomains only', () => {
    expect(isVendorHost('api.anthropic.com')).toBe(true);
    expect(isVendorHost('us-east-1.recall.ai')).toBe(true);
    expect(isVendorHost('recall.ai')).toBe(false);
    expect(isVendorHost('evilrecall.ai')).toBe(false);
    expect(isVendorHost('api.anthropic.com.riverbend.test')).toBe(false);
    expect(isVendorHost('localhost')).toBe(false);
  });
});
