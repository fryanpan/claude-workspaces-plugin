/**
 * The lead's CONNECT proxy (`infra/project-machine/lead-proxy*.ts`), the one
 * way out of the lead's network wall: it opens a connection only to a host on
 * lead-egress.allow, only when the TLS server name the client then sends is
 * that same host, and only to a public address.
 *
 * Hermetic: the proxy listens on port 0, and every name it is asked for
 * resolves to an upstream on loopback that records what reached it.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { type AddressInfo, type Server, type Socket, connect, createServer } from 'node:net';
import { parseAllowlist } from '../../../infra/project-machine/lead-egress-plan.ts';
import {
  clientHello,
  parseConnect,
  readHello,
} from '../../../infra/project-machine/lead-proxy-plan.ts';
import {
  type ProxyOptions,
  createProxy,
  rateLimitedLog,
} from '../../../infra/project-machine/lead-proxy.ts';
import { waitFor } from './wait-for.ts';

const ENTRIES = parseAllowlist(
  [
    'api.riverbend.test tcp/443 # the model',
    'cdn.riverbend.test tcp/443 # shares a CDN with the model',
    'git.harborlight.test tcp/443,tcp/22 # git',
  ].join('\n'),
);

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

const listen = (s: Server) =>
  new Promise<number>((done) => {
    servers.push(s);
    s.listen(0, '127.0.0.1', () => done((s.address() as AddressInfo).port));
  });

/** An upstream that keeps every byte it is sent and answers each chunk with "ok". */
async function upstream() {
  const got: Buffer[] = [];
  let accepted = 0;
  const port = await listen(
    createServer((s) => {
      accepted++;
      s.on('data', (d: Buffer) => {
        got.push(d);
        s.write('ok');
      });
      s.on('error', () => s.destroy());
    }),
  );
  return { port, got: () => Buffer.concat(got), accepted: () => accepted };
}

async function proxy(over: Partial<ProxyOptions> = {}) {
  const up = await upstream();
  const dialled: string[] = [];
  const logged: string[] = [];
  const port = await listen(
    createProxy({
      entries: ENTRIES,
      resolve: async () => ['127.0.0.1'],
      allowAddress: () => true,
      dial: (address, p) => {
        dialled.push(`${address}:${p}`);
        return connect({ host: '127.0.0.1', port: up.port });
      },
      log: (l) => logged.push(l),
      ...over,
    }),
  );
  return { port, up, dialled, logged };
}

interface Exchange {
  /** Everything the proxy sent back, as text. */
  text: () => string;
  closed: () => boolean;
  send: (b: Uint8Array | string) => void;
}

function open(port: number, request: string): Exchange {
  const s: Socket = connect({ host: '127.0.0.1', port });
  const chunks: Buffer[] = [];
  let closed = false;
  s.on('data', (d: Buffer) => chunks.push(d));
  s.on('close', () => {
    closed = true;
  });
  s.on('error', () => {});
  s.write(request);
  return {
    text: () => Buffer.concat(chunks).toString('latin1'),
    closed: () => closed,
    send: (b) => s.write(b),
  };
}

const connectTo = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
const ESTABLISHED = 'HTTP/1.1 200 Connection established\r\n\r\n';

describe('the proxy', () => {
  it('opens a listed host when its TLS hello names that host, and carries the bytes both ways', async () => {
    const p = await proxy();
    const c = open(p.port, connectTo('api.riverbend.test:443'));
    await waitFor(() => c.text().startsWith(ESTABLISHED), { describe: 'the 200' });
    const hello = clientHello('api.riverbend.test');
    c.send(hello);
    await waitFor(() => c.text().endsWith('ok'), { describe: 'the upstream answer' });
    // The hello reached the upstream unchanged, and what followed it did too.
    expect(p.up.got()).toEqual(Buffer.from(hello));
    c.send('application data');
    await waitFor(() => p.up.got().toString('latin1').endsWith('application data'), {
      describe: 'the next bytes',
    });
    expect(p.dialled).toEqual(['127.0.0.1:443']);
    expect(p.logged).toEqual([]);
  });

  it('refuses a name that is not on the list with a 403 and dials nothing', async () => {
    const p = await proxy();
    const c = open(p.port, connectTo('exfil.saltmarsh.test:443'));
    await waitFor(() => c.closed(), { describe: 'the refusal' });
    expect(c.text()).toStartWith('HTTP/1.1 403 it is not on lead-egress.allow');
    expect(p.dialled).toEqual([]);
    expect(p.up.accepted()).toBe(0);
    expect(p.logged).toEqual([
      '[lead-proxy] refused exfil.saltmarsh.test:443: it is not on lead-egress.allow',
    ]);
  });

  it('refuses a CONNECT to one listed host whose TLS hello names another, and dials nothing', async () => {
    const p = await proxy();
    // Both names are listed and share an edge: the client is asking the CDN
    // for cdn.riverbend.test under cover of api.riverbend.test.
    const c = open(p.port, connectTo('api.riverbend.test:443'));
    await waitFor(() => c.text() === ESTABLISHED, { describe: 'the 200' });
    c.send(clientHello('cdn.riverbend.test'));
    await waitFor(() => c.closed(), { describe: 'the refusal' });
    expect(c.text()).toBe(ESTABLISHED);
    expect(p.dialled).toEqual([]);
    expect(p.up.accepted()).toBe(0);
    expect(p.logged).toEqual([
      '[lead-proxy] refused api.riverbend.test:443: its TLS server name is cdn.riverbend.test',
    ]);
    // And an unlisted name in the hello is refused the same way.
    const d = open(p.port, connectTo('api.riverbend.test:443'));
    await waitFor(() => d.text() === ESTABLISHED, { describe: 'the second 200' });
    d.send(clientHello('exfil.saltmarsh.test'));
    await waitFor(() => d.closed(), { describe: 'the second refusal' });
    expect(p.dialled).toEqual([]);
  });

  it('reads a hello that arrives in pieces, and with the request in the same packet', async () => {
    const p = await proxy();
    const hello = clientHello('git.harborlight.test');
    const c = open(
      p.port,
      connectTo('git.harborlight.test:443') + Buffer.from(hello.subarray(0, 7)).toString('latin1'),
    );
    await waitFor(() => c.text() === ESTABLISHED, { describe: 'the 200' });
    expect(p.dialled).toEqual([]);
    c.send(hello.subarray(7));
    await waitFor(() => c.text().endsWith('ok'), { describe: 'the upstream answer' });
    expect(p.up.got()).toEqual(Buffer.from(hello));
  });

  it('refuses a hello with no server name, and anything but TLS on 443', async () => {
    const p = await proxy();
    const none = open(p.port, connectTo('api.riverbend.test:443'));
    await waitFor(() => none.text() === ESTABLISHED, { describe: 'the 200' });
    none.send(clientHello(null));
    await waitFor(() => none.closed(), { describe: 'the no-name refusal' });
    const plain = open(p.port, connectTo('api.riverbend.test:443'));
    await waitFor(() => plain.text() === ESTABLISHED, { describe: 'the 200' });
    plain.send('GET / HTTP/1.1\r\nHost: cdn.riverbend.test\r\n\r\n');
    await waitFor(() => plain.closed(), { describe: 'the plain-text refusal' });
    expect(p.dialled).toEqual([]);
    expect(p.logged).toEqual([
      '[lead-proxy] refused api.riverbend.test:443: its TLS hello names no server',
      '[lead-proxy] refused api.riverbend.test:443: it sent port 443 something that is not TLS',
    ]);
  });

  it('carries ssh to a host listed on 22, and refuses that host on a port it is not listed for', async () => {
    const p = await proxy();
    const ssh = open(p.port, connectTo('git.harborlight.test:22'));
    await waitFor(() => ssh.text() === ESTABLISHED, { describe: 'the 200' });
    ssh.send('SSH-2.0-OpenSSH_9.2\r\n');
    await waitFor(() => ssh.text().endsWith('ok'), { describe: 'the upstream answer' });
    expect(p.dialled).toEqual(['127.0.0.1:22']);
    const other = open(p.port, connectTo('git.harborlight.test:2222'));
    await waitFor(() => other.closed(), { describe: 'the refusal' });
    expect(other.text()).toStartWith('HTTP/1.1 403 ');
    const api22 = open(p.port, connectTo('api.riverbend.test:22'));
    await waitFor(() => api22.closed(), { describe: 'the refusal' });
    expect(api22.text()).toStartWith('HTTP/1.1 403 ');
    expect(p.dialled).toEqual(['127.0.0.1:22']);
  });

  it('serves CONNECT only: a plain proxied GET is refused with a 405', async () => {
    const p = await proxy();
    const c = open(
      p.port,
      'GET http://api.riverbend.test/ HTTP/1.1\r\nHost: api.riverbend.test\r\n\r\n',
    );
    await waitFor(() => c.closed(), { describe: 'the refusal' });
    expect(c.text()).toStartWith('HTTP/1.1 405 GET is not served');
    expect(p.dialled).toEqual([]);
  });

  it('dials no listed name that resolves to a loopback, private or link-local address', async () => {
    // The real address check, not the test's allow-everything one.
    const inward = ['127.0.0.1', '10.0.0.5', '169.254.169.254', 'fdaa::3', '::1'];
    for (const addr of inward) {
      const p = await proxy({ resolve: async () => [addr], allowAddress: undefined });
      const c = open(p.port, connectTo('api.riverbend.test:443'));
      await waitFor(() => c.text() === ESTABLISHED, { describe: 'the 200' });
      c.send(clientHello('api.riverbend.test'));
      await waitFor(() => c.closed(), { describe: `the refusal of ${addr}` });
      expect(p.dialled).toEqual([]);
      expect(p.logged).toEqual([
        '[lead-proxy] refused api.riverbend.test:443: it resolves to no public address',
      ]);
    }
    // POSITIVE CONTROL: a public address is dialled by the same check.
    const pub = await proxy({ resolve: async () => ['140.82.112.4'], allowAddress: undefined });
    const c = open(pub.port, connectTo('api.riverbend.test:443'));
    await waitFor(() => c.text() === ESTABLISHED, { describe: 'the 200' });
    c.send(clientHello('api.riverbend.test'));
    await waitFor(() => c.text().endsWith('ok'), { describe: 'the upstream answer' });
    expect(pub.dialled).toEqual(['140.82.112.4:443']);
  });

  it('logs a refusal once a minute per host and reason, not once per attempt', async () => {
    const p = await proxy();
    for (let i = 0; i < 3; i++) {
      const c = open(p.port, connectTo('exfil.saltmarsh.test:443'));
      await waitFor(() => c.closed(), { describe: 'the refusal' });
    }
    const other = open(p.port, connectTo('other.saltmarsh.test:443'));
    await waitFor(() => other.closed(), { describe: 'the refusal' });
    expect(p.logged).toHaveLength(2);
  });
});

describe('the refusal log', () => {
  it('holds back past its per-minute budget, keeps no key past the minute, and says how many it held', () => {
    const lines: string[] = [];
    let t = 0;
    const log = rateLimitedLog(
      (l) => lines.push(l),
      60_000,
      3,
      () => t,
    );
    for (let i = 0; i < 10; i++) log(`h${i}`, `refused h${i}`);
    log('h0', 'refused h0');
    expect(lines).toEqual(['refused h0', 'refused h1', 'refused h2']);
    t = 60_000;
    log('h0', 'refused h0');
    expect(lines.slice(3)).toEqual([
      '[lead-proxy] 7 more refusals in the last minute were not logged',
      'refused h0',
    ]);
  });
});

describe('reading a request and a hello', () => {
  it('takes CONNECT host:port only, lower-cased and without a trailing dot', () => {
    expect(parseConnect('CONNECT API.Riverbend.test.:443 HTTP/1.1\r\nHost: x')).toEqual({
      ok: true,
      host: 'api.riverbend.test',
      port: 443,
    });
    expect(parseConnect('CONNECT 203.0.113.9:443 HTTP/1.1')).toMatchObject({ ok: true });
    for (const bad of [
      'CONNECT api.riverbend.test HTTP/1.1',
      'CONNECT api.riverbend.test:0 HTTP/1.1',
      'CONNECT api.riverbend.test:99999 HTTP/1.1',
      'CONNECT user@api.riverbend.test:443 HTTP/1.1',
      'CONNECT [::1]:443 HTTP/1.1',
      'garbage',
    ]) {
      expect(parseConnect(bad)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it('finds the server name in a ClientHello, and says when there is none or it cannot tell', () => {
    const hello = clientHello('Git.Harborlight.test');
    expect(readHello(hello)).toEqual({ kind: 'sni', name: 'git.harborlight.test' });
    expect(readHello(hello.subarray(0, hello.length - 1))).toEqual({ kind: 'incomplete' });
    expect(readHello(clientHello(null))).toEqual({ kind: 'no-sni' });
    expect(readHello(new TextEncoder().encode('SSH-2.0-x'))).toEqual({ kind: 'not-tls' });
    // A record header longer than any TLS record, and a record that is not a ClientHello.
    expect(readHello(new Uint8Array([0x16, 3, 1, 0xff, 0xff]))).toEqual({ kind: 'bad' });
    const notHello = Uint8Array.from(hello);
    notHello[5] = 0x02;
    expect(readHello(notHello)).toEqual({ kind: 'bad' });
    // A handshake that claims more bytes than its record holds.
    const split = Uint8Array.from(hello);
    split[8] = 0xff;
    expect(readHello(split)).toEqual({ kind: 'bad' });
  });
});
