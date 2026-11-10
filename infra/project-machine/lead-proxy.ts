#!/usr/bin/env bun
/**
 * The one way out for the lead and the dev server (`entrypoint.sh`).
 *
 *   bun lead-proxy.ts serve                 as cwproxy: the CONNECT proxy on
 *                                           127.0.0.1:3128 (lead-egress-plan.ts)
 *   bun lead-proxy.ts connect <host> <port> as the lead: one CONNECT through it,
 *                                           then stdin and stdout are the
 *                                           connection (ssh's ProxyCommand)
 *
 * A connection is opened only when all of these hold, in this order:
 *
 *   1. The request is `CONNECT host:port`. Plain-HTTP proxying is not served.
 *   2. host is on lead-egress.allow, on that port. Otherwise 403.
 *   3. The client's first bytes, read after the 200: a TLS ClientHello whose
 *      server name is that same host, or, on a port other than 443, bytes that
 *      are not TLS at all (ssh). A ClientHello naming another host, or none,
 *      is refused, so a client cannot name a listed host to the proxy and
 *      another to a CDN that serves both (domain fronting by SNI).
 *   4. host resolves, here, to a public address: never loopback, private,
 *      link-local or Fly's own network (`classifyAddress`), so a listed name
 *      that resolves inward reaches nothing.
 *
 * Every refusal is one line on stderr, which the entrypoint sends to the boot
 * log, at most once a minute per host and reason.
 */
import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import { type Server, type Socket, connect, createServer } from 'node:net';
import { classifyAddress } from '../../packages/server/src/outbound-fetch.ts';
import {
  type AllowEntry,
  PROXY_HOST,
  PROXY_PORT,
  admits,
  parseAllowlist,
} from './lead-egress-plan.ts';
import { ALLOW_PATH } from './lead-egress.ts';
import { MAX_HELLO, parseConnect, readHello } from './lead-proxy-plan.ts';

export interface ProxyOptions {
  entries: AllowEntry[];
  resolve?: (host: string) => Promise<string[]>;
  dial?: (address: string, port: number) => Socket;
  /** Whether an upstream address may be dialled. Public addresses only, unless a test says otherwise. */
  allowAddress?: (address: string) => boolean;
  log?: (line: string) => void;
  /** How long a client may take to send its request and its first bytes. */
  idleMs?: number;
}

const MAX_HEAD = 8192;

const defaultResolve = async (host: string) =>
  (await dns.lookup(host, { all: true })).map((a) => a.address);

/**
 * One line per key per window, and at most `perWindow` lines in a window
 * altogether, so a lead that asks for a new name every time can neither
 * flood the boot log nor grow this map without end. The first line held
 * back in a window says so.
 */
export function rateLimitedLog(
  log: (line: string) => void,
  everyMs = 60_000,
  perWindow = 30,
  now: () => number = Date.now,
) {
  let windowStart = Number.NEGATIVE_INFINITY;
  let seen = new Set<string>();
  let held = 0;
  return (key: string, line: string) => {
    const t = now();
    if (t - windowStart >= everyMs) {
      if (held > 0) log(`[lead-proxy] ${held} more refusals in the last minute were not logged`);
      windowStart = t;
      seen = new Set();
      held = 0;
    }
    if (seen.has(key)) return;
    if (seen.size >= perWindow) {
      held++;
      return;
    }
    seen.add(key);
    log(line);
  };
}

export function createProxy(o: ProxyOptions): Server {
  const resolve = o.resolve ?? defaultResolve;
  const dial = o.dial ?? ((address, port) => connect({ host: address, port }));
  const allowAddress = o.allowAddress ?? ((a) => classifyAddress(a) === 'public');
  const refuse = rateLimitedLog(o.log ?? ((l) => console.error(l)));
  const idleMs = o.idleMs ?? 15_000;

  return createServer((client) => {
    let buf = Buffer.alloc(0);
    let target: { host: string; port: number } | null = null;
    client.setTimeout(idleMs, () => client.destroy());
    client.on('error', () => client.destroy());

    const deny = (why: string, status?: number) => {
      const t = target ? `${target.host}:${target.port}` : 'a request';
      refuse(`${t} ${why}`, `[lead-proxy] refused ${t}: ${why}`);
      if (status) client.end(`HTTP/1.1 ${status} ${why}\r\nConnection: close\r\n\r\n`);
      else client.destroy();
    };

    const open = async (first: Buffer) => {
      const t = target as { host: string; port: number };
      client.pause();
      client.removeListener('data', onData);
      let addrs: string[];
      try {
        addrs = (await resolve(t.host)).filter(allowAddress);
      } catch {
        addrs = [];
      }
      const [addr] = addrs;
      if (addr === undefined) return deny('it resolves to no public address');
      const up = dial(addr, t.port);
      up.on('error', () => {
        up.destroy();
        client.destroy();
      });
      client.on('close', () => up.destroy());
      up.on('close', () => client.destroy());
      up.once('connect', () => {
        client.setTimeout(0);
        up.write(first);
        client.pipe(up);
        up.pipe(client);
        client.resume();
      });
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (target === null) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buf.length > MAX_HEAD) deny('its request head is too long', 431);
          return;
        }
        const req = parseConnect(buf.subarray(0, end).toString('latin1'));
        if (!req.ok) return deny(req.reason, req.status);
        target = { host: req.host, port: req.port };
        if (!admits(o.entries, req.host, req.port)) {
          return deny('it is not on lead-egress.allow', 403);
        }
        buf = buf.subarray(end + 4);
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (buf.length === 0) return;
      }
      const hello = readHello(buf);
      if (hello.kind === 'incomplete') {
        if (buf.length > MAX_HELLO) deny('its first TLS record is too long');
        return;
      }
      const t = target as { host: string; port: number };
      if (hello.kind === 'sni') {
        if (hello.name !== t.host) return deny(`its TLS server name is ${hello.name}`);
      } else if (hello.kind === 'not-tls') {
        if (t.port === 443) return deny('it sent port 443 something that is not TLS');
      } else {
        return deny(
          hello.kind === 'no-sni' ? 'its TLS hello names no server' : 'its TLS hello is malformed',
        );
      }
      void open(buf);
    };
    client.on('data', onData);
  });
}

/** ssh's ProxyCommand: one CONNECT, then this process's stdin and stdout are the connection. */
async function connectThrough(host: string, port: number): Promise<number> {
  const s = connect({ host: PROXY_HOST, port: PROXY_PORT });
  return new Promise((done) => {
    let head = Buffer.alloc(0);
    s.on('error', (e) => {
      console.error(`lead-proxy connect: ${e.message}`);
      done(1);
    });
    s.once('connect', () =>
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`),
    );
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      s.removeListener('data', onHead);
      const status = head.subarray(0, end).toString('latin1').split('\r\n')[0] ?? '';
      if (!/^HTTP\/1\.[01] 200 /.test(status)) {
        console.error(`lead-proxy connect: ${status}`);
        s.destroy();
        return done(1);
      }
      const rest = head.subarray(end + 4);
      if (rest.length > 0) process.stdout.write(rest);
      s.pipe(process.stdout);
      process.stdin.pipe(s);
      s.on('close', () => done(0));
    };
    s.on('data', onHead);
  });
}

if (import.meta.main) {
  const [cmd, host, port] = process.argv.slice(2);
  if (cmd === 'serve') {
    const entries = parseAllowlist(readFileSync(ALLOW_PATH, 'utf8'));
    const server = createProxy({ entries });
    server.on('error', (e) => {
      console.error(`[lead-proxy] cannot listen on ${PROXY_HOST}:${PROXY_PORT}: ${e.message}`);
      process.exit(1);
    });
    server.listen(PROXY_PORT, PROXY_HOST, () =>
      console.error(
        `[lead-proxy] listening on ${PROXY_HOST}:${PROXY_PORT} for ${entries.map((e) => `${e.host}:${e.ports.map((p) => p.port).join(',')}`).join(' ')}`,
      ),
    );
  } else if (cmd === 'connect' && host && port) {
    process.exit(await connectThrough(host, Number(port)));
  } else {
    console.error('usage: lead-proxy.ts serve | connect <host> <port>');
    process.exit(64);
  }
}
