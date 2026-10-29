#!/usr/bin/env bun
/**
 * The owner taps an option on a review item from the board page, in headless
 * Chromium against a real server, and the answer records as his — once as an
 * iPad on the Access hostname, once as a Mac on loopback with the session
 * cookie. Since `review-items/answer-proof.ts` the server records a person's
 * answer only from that person's proven, same-origin request, so this is the
 * check that the board page still sends one.
 *
 * The iPad's Access proof is the assertion header Cloudflare would add, set
 * on every request with `Network.setExtraHTTPHeaders` beside `cf-ray`; the
 * page is opened on `workspaces.localhost`, which Chrome resolves to this
 * machine. The Mac's cookie is signed with the data dir's own key, which is
 * what the emailed-code sign-in would have set. What the page sends and what
 * the server records are real.
 *
 * Spawned by `packages/workspaces-app/test/answer-proof-browser.test.ts`,
 * which reads the JSON this prints on its last line.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was read off the running server.
 */
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  stopBrowser,
  withTimeout,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'answer-proof-browser-kid';
const AUD = 'aud-for-the-owner-app';
const HOST = 'workspaces.localhost';
const OWNER_EMAIL = 'owner@harborlight.test';
const AGENT = { id: 'agent-riverbend', name: 'Riverbend Bot', kind: 'agent' };
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** One device's answer, as the server stored it. */
export interface DeviceAnswer {
  text: string | null;
  answeredById: string | null;
}

export interface AnswerProofReading {
  ownerId: string;
  ipad: DeviceAnswer;
  mac: DeviceAnswer;
  /** The control: an agent's loopback claim of the owner, on a third item. */
  loopbackClaimStatus: number;
  loopbackClaimRecorded: boolean;
  errors: string[];
}

const step = (what: string): void => {
  process.stderr.write(`[answer-proof-browser-driver] ${what}\n`);
};

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'answer-proof-browser-'));
  let handle: ServerHandle | undefined;
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    step('build the board client');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      [
        'run',
        join(import.meta.dirname, '../../workspaces-app/scripts/build.ts'),
        '--outdir',
        appDist,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`board client build failed:\n${built.stderr}`);

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = (await exportJWK(publicKey)) as JWK;
    Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' });
    const jwks: JSONWebKeySet = { keys: [jwk] };
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({ email: OWNER_EMAIL })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUD)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const dataDir = join(dir, 'data');
    handle = createServer({
      port: 0,
      dataDir,
      markdownAppDistDir: appDist,
      ownerEmail: OWNER_EMAIL,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: AUD, jwks },
      shareLinkHosts: ['share.localhost'],
      shareLinkAudience: 'aud-for-the-share-app',
      proxiedTrustedHosts: [HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
    });
    const local = `http://127.0.0.1:${handle.port}`;
    const agentPost = async (path: string, body: unknown) => {
      const r = await fetch(`${local}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return (await r.json()) as Record<string, { id: string }>;
    };
    const board = handle.tasks.createWorkspace('Harborlight').id;
    const fileItem = async (title: string) => {
      const task = (await agentPost(`/workspaces/${board}/tasks`, { title, author: AGENT })).task;
      const item = (
        await agentPost(`/workspaces/${board}/tasks/${task?.id}/review-items`, {
          author: AGENT,
          review: {
            shape: 'decision',
            headline: 'Ship the Saltmarsh release notes today?',
            detail: 'They are drafted and reviewed. Shipping today beats the Friday freeze.',
            options: [
              { id: 'yes', label: 'Ship today' },
              { id: 'no', label: 'Hold for Monday' },
            ],
          },
        })
      ).item;
      return { taskId: task?.id ?? '', itemId: item?.id ?? '' };
    };
    const stored = async (taskId: string, itemId: string): Promise<DeviceAnswer> => {
      const { tasks } = (await (
        await fetch(`${local}/workspaces/${board}/tasks?format=json`)
      ).json()) as {
        tasks: Array<{
          id: string;
          reviews?: Array<{ id: string; answer?: { text: string; answeredBy?: { id: string } } }>;
        }>;
      };
      const a = tasks.find((t) => t.id === taskId)?.reviews?.find((r) => r.id === itemId)?.answer;
      return { text: a?.text ?? null, answeredById: a?.answeredBy?.id ?? null };
    };

    const ipadItem = await fileItem('Agent can ship the notes from the iPad so that Friday holds');
    const macItem = await fileItem('Agent can ship the notes from the Mac so that Friday holds');
    const claimItem = await fileItem('Agent can ship the notes on its own say so');

    step('launch Chrome');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `answer-proof-browser-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    const errors: string[] = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = (p as { exceptionDetails?: { exception?: { description?: string } } })
        .exceptionDetails;
      errors.push(d?.exception?.description?.split('\n')[0] ?? 'exception');
    });
    const ev = <T>(expr: string) => cdp.evaluate(expr) as Promise<T>;
    const tapOption = async (site: string, item: { taskId: string; itemId: string }) => {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', {
        url: `${site}/workspaces/${board}?task=${encodeURIComponent(item.taskId)}`,
      });
      await withTimeout(loaded, 30_000, 'the board page to load');
      await waitFor(
        () =>
          ev<boolean>(`(() => {
            const b = [...document.querySelectorAll('.board-decide-option')]
              .find((x) => x.textContent.includes('Ship today') && !x.disabled);
            if (!b) return false;
            b.click(); return true;
          })()`).catch(() => false),
        { timeout: 20_000, describe: 'the Ship today option' },
      );
      await waitFor(async () => (await stored(item.taskId, item.itemId)).text !== null, {
        timeout: 10_000,
        describe: 'the answer to land',
      }).catch(() => undefined);
      return stored(item.taskId, item.itemId);
    };

    step('iPad: the Access hostname at 1180x820, touch');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1180,
      height: 820,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: IPAD_UA });
    await cdp.send('Network.setExtraHTTPHeaders', {
      headers: { 'cf-access-jwt-assertion': accessToken, 'cf-ray': '8a1b2c3d4e5f-SJC' },
    });
    const ipad = await tapOption(`http://${HOST}:${handle.port}`, ipadItem);

    step('Mac: loopback with the session cookie');
    await cdp.send('Network.setExtraHTTPHeaders', { headers: {} });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const owner = signedInPerson(handle, dataDir, local, { email: OWNER_EMAIL });
    const [name, value] = (owner.headers.cookie ?? '').split(/=(.*)/s);
    await cdp.send('Network.setCookie', {
      name,
      value,
      url: local,
      httpOnly: true,
      sameSite: 'Lax',
    });
    const mac = await tapOption(local, macItem);

    step('control: an agent claims the owner over loopback');
    const claim = await fetch(
      `${local}/workspaces/${board}/tasks/${claimItem.taskId}/review-items/${claimItem.itemId}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Ship today',
          answeredWith: 'yes',
          author: { id: 'known-bryan', name: 'Bryan', kind: 'person' },
        }),
      },
    );

    cdp.close();
    const reading: AnswerProofReading = {
      ownerId: owner.user.id,
      ipad,
      mac,
      loopbackClaimStatus: claim.status,
      loopbackClaimRecorded: (await stored(claimItem.taskId, claimItem.itemId)).text !== null,
      errors,
    };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    resetOwnerIdentities();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
