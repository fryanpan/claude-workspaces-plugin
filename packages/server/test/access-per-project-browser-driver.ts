#!/usr/bin/env bun
/**
 * A page on one project's subdomain tries to call another project's board with
 * Bryan's session, in a running browser.
 *
 * Two real servers, each behind a stand-in for its own Access application: a
 * loopback proxy that admits a request only with a `CF_Authorization` cookie
 * minted for its application, turns that cookie into the
 * `Cf-Access-Jwt-Assertion` header and adds `cf-ray`, as the edge does. The
 * hosts are two project hostnames in one zone, which this browser alone resolves
 * to loopback, so they are one site as the real ones are, and a `Lax` cookie
 * rides a fetch between them. (`*.localhost` would not do: Chrome treats
 * each of those as a site of its own, and the cookie never leaves.) The
 * browser holds Bryan's cookie for each host, as it would after signing in to
 * both.
 *
 * From a Riverbend page the script reads and writes Harborlight's board; from
 * a Harborlight page it does the same, the control that shows the session is
 * good. It reports what each page could read, what each write left on the
 * Harborlight server, and what reached Harborlight's edge.
 *
 * Spawned by `packages/workspaces-app/test/access-per-project-browser.test.ts`, which reads the JSON this
 * prints on its last line.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was measured in a running browser or
 * read off the server's own store.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { Cdp, launchChrome, pageSocketUrl, stopBrowser } from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  extraChromeArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'per-project-browser-kid';
const OWNER_EMAIL = 'owner@harborlight.test';
const MAC_HOST = 'harborlight-workspaces.harborlight.test';
const CLOUD_HOST = 'riverbend-workspaces.harborlight.test';
/** Every name in the zone goes to loopback, in this browser only. */
const RESOLVE_TO_LOOPBACK = '--host-resolver-rules=MAP *.harborlight.test 127.0.0.1';
const AUD: Record<string, string> = {
  [MAC_HOST]: 'aud-harborlight-app',
  [CLOUD_HOST]: 'aud-riverbend-app',
};

/** What one page managed against Harborlight's board. */
export interface Attempt {
  /** The read's outcome: the board's name, or why there was none. */
  read: string;
  /** A credentialed write's HTTP status as the page saw it, or `blocked`. */
  write: string;
  /** Whether the board that write asked for now exists on Harborlight. */
  written: boolean;
}

export interface PerProjectReading {
  /** The script run from a Harborlight page: the control. */
  sameProject: Attempt;
  /** The same script from a Riverbend page. */
  otherProject: Attempt;
  /** Requests from the Riverbend page that reached Harborlight's edge with
   *  Bryan's cookie, and the status Harborlight's server answered. */
  fromOther: Array<{ method: string; status: number }>;
}

interface Edge {
  port: number;
  stop: () => void;
  /** Each request's method and Origin as it arrived, and the answer's status. */
  seen: Array<{ method: string; origin: string | null; cookie: boolean; status: number }>;
}

/** A stand-in for one Access application in front of one server. */
function edgeFor(host: string, server: ServerHandle): Edge {
  const seen: Edge['seen'] = [];
  const s = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get('cookie') ?? '');
      const row = {
        method: req.method,
        origin: req.headers.get('origin'),
        cookie: !!cookie,
        status: 0,
      };
      seen.push(row);
      if (req.method !== 'OPTIONS' && (!cookie?.[1] || decodeJwt(cookie[1]).aud !== AUD[host])) {
        // Access lets a preflight through unauthenticated, and nothing else.
        row.status = 403;
        return new Response('Access: sign in', { status: 403 });
      }
      const url = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.delete('cookie');
      if (cookie?.[1]) headers.set('cf-access-jwt-assertion', cookie[1]);
      headers.set('cf-ray', '8a1b2c3d4e5f-SJC');
      headers.set('host', url.host);
      const res = await fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.body,
        redirect: 'manual',
      });
      row.status = res.status;
      return res;
    },
  });
  return { port: s.port as number, stop: () => s.stop(true), seen };
}

/** Read and write Harborlight's board from whatever page this runs on. */
function attemptScript(target: string, board: string, name: string): string {
  return `(async () => {
    const out = {};
    try {
      const r = await fetch(${JSON.stringify(`${target}/workspaces/${board}?format=json`)},
        { credentials: 'include' });
      const body = await r.json();
      out.read = body?.workspace?.name ?? body?.name ?? ('status ' + r.status);
    } catch (e) { out.read = 'blocked'; }
    try {
      // text/plain: a simple request, so the browser sends it without asking.
      const r = await fetch(${JSON.stringify(`${target}/workspaces`)}, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ name: ${JSON.stringify(name)} }),
      });
      out.write = String(r.status);
    } catch (e) { out.write = 'blocked'; }
    return out;
  })()`;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'access-per-project-'));
  const servers: ServerHandle[] = [];
  const edges: Edge[] = [];
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = (await exportJWK(publicKey)) as JWK;
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const jwks: JSONWebKeySet = { keys: [jwk] };
    const stampFor = (host: string) =>
      new SignJWT({ email: OWNER_EMAIL })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(AUD[host] as string)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .sign(privateKey);
    const boot = (host: string) => {
      const h = createServer({
        port: 0,
        dataDir: join(dir, host),
        cfAccess: { teamDomain: TEAM_DOMAIN, audience: AUD[host] as string, jwks },
        proxiedTrustedHosts: [host],
        proxiedTrustedEmails: [OWNER_EMAIL],
      });
      servers.push(h);
      return h;
    };
    const mac = boot(MAC_HOST);
    const cloud = boot(CLOUD_HOST);
    const macBoard = mac.tasks.createWorkspace('Harborlight board').id;
    const cloudBoard = cloud.tasks.createWorkspace('Riverbend board').id;
    const macEdge = edgeFor(MAC_HOST, mac);
    const cloudEdge = edgeFor(CLOUD_HOST, cloud);
    edges.push(macEdge, cloudEdge);
    const macUrl = `http://${MAC_HOST}:${macEdge.port}`;
    const cloudUrl = `http://${CLOUD_HOST}:${cloudEdge.port}`;

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) =>
        chromeLaunchArgs({ width: 1180, height: 820 }, profile, [
          ...extraChromeArgs(),
          RESOLVE_TO_LOOPBACK,
        ]),
      STARTUP_TIMEOUT_MS,
      `access-per-project-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    // Bryan has signed in to both applications: one cookie per host, set by
    // that host alone, as Access sets it.
    for (const [host, url] of [
      [MAC_HOST, macUrl],
      [CLOUD_HOST, cloudUrl],
    ] as const) {
      await cdp.send('Network.setCookie', {
        name: 'CF_Authorization',
        value: await stampFor(host),
        url,
        httpOnly: true,
        sameSite: 'Lax',
      });
    }
    const open = async (url: string) => {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
    };
    const exists = (name: string) => mac.tasks.listWorkspaces().some((w) => w.name === name);
    const attempt = async (pageUrl: string, name: string): Promise<Attempt> => {
      await open(pageUrl);
      const r = (await cdp.evaluate(attemptScript(macUrl, macBoard, name))) as {
        read: string;
        write: string;
      };
      return { ...r, written: exists(name) };
    };

    const sameProject = await attempt(
      `${macUrl}/workspaces/${macBoard}?format=json`,
      'Planted from Harborlight',
    );
    const before = macEdge.seen.length;
    const otherProject = await attempt(
      `${cloudUrl}/workspaces/${cloudBoard}?format=json`,
      'Planted from Riverbend',
    );
    const fromOther = macEdge.seen
      .slice(before)
      .filter((s) => s.cookie && s.origin === cloudUrl)
      .map(({ method, status }) => ({ method, status }));
    cdp.close();
    const reading: PerProjectReading = { sameProject, otherProject, fromOther };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    for (const e of edges) e.stop();
    for (const s of servers) await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
