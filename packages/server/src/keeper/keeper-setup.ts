/**
 * Finishing the keeper's setup in one run: sections 2 to 4 of
 * `docs/process/keeper.md`, after `scripts/keeper-install.sh` has the
 * keeper running. Runs as Bryan, never as root and never as an agent.
 *
 * 1. A new Fly org token, made with Bryan's own `fly` login, into the keeper.
 * 2. A new Cloudflare token, made with the current one (or in the dashboard
 *    when it cannot), into the keeper with the one account id it sees.
 * 3. Each project app (`cw-<project>`, the deploy's name for one) adopted.
 * 4. `CW_KEEPER_URL` in the fleet's launch environment (`~/.claude/settings.json`)
 *    and in prod's launchd job, and prod restarted onto it.
 * 5. The check: the store is unreadable to this user, and a probe `fly apps
 *    create` is held for a passkey, its link printed, and then withdrawn.
 *
 * Every step reads what is already there first and skips what is done, so a
 * second run changes nothing. A credential reaches the keeper on stdin only:
 * never an argument, a file, the clipboard or a printed line. `dryRun` reads
 * state, makes no change, and reads no credential. Section 5 of the runbook,
 * retiring the old tokens, is deliberately not here: that one is Bryan's.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECRET_ACCOUNT, storedSecretService } from '../../../core/src/secret-name.ts';
import { API_HEADER, HELD_HEADER } from './keeper-http.ts';
import { manualTokenSteps, mintKeeperToken, oneAccount } from './keeper-setup-cloudflare.ts';

export { CF_TOKEN_PERMISSIONS } from './keeper-setup-cloudflare.ts';

export interface SetupOptions {
  /** The keeper's install root, `/Users/cw-relay/keeper`. */
  root: string;
  /** The keeper's macOS user. */
  user: string;
  /** Bryan's home: `.claude/settings.json` and `Library/LaunchAgents` are under it. */
  home: string;
  uid: number;
  /** Prod's launchd label. */
  label: string;
  /** The environment every tool runs with; its PATH is where they are found. */
  env: Record<string, string | undefined>;
  dryRun: boolean;
  fetch: typeof fetch;
  /** Read one line from the terminal without showing it. */
  readSecret: (prompt: string) => Promise<string>;
  print: (line: string) => void;
}

/** The deploy's app name for a project (`infra/project-machine/deploy-plan.ts`). */
const PROJECT_APP = /^cw-[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const PROBE_APP = 'cw-keeper-probe';

class Stop extends Error {}

export async function runKeeperSetup(o: SetupOptions): Promise<number> {
  try {
    await steps(o);
    return 0;
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    o.print('');
    o.print(`STOP: ${err.message}`);
    o.print('Nothing after this step ran. Fix it and run the command again.');
    return 1;
  }
}

async function steps(o: SetupOptions): Promise<void> {
  const step = (s: string) => {
    o.print('');
    o.print(`== ${s}`);
  };
  const ok = (s: string) => o.print(`   ok: ${s}`);
  const would = (s: string) => o.print(`   would ${s}`);
  const run = (cmd: string, args: string[], input?: string) => {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      env: o.env,
      ...(input !== undefined ? { input } : {}),
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const keeper = (args: string[], input?: string) =>
    run(
      'sudo',
      [
        '-H',
        '-u',
        o.user,
        'env',
        `CW_KEEPER_DIR=${o.root}/state`,
        `CW_KEEPER_FLY_BIN=${o.root}/bin/fly`,
        `${o.root}/bin/bun`,
        `${o.root}/app/packages/server/src/keeper/keeper-bin.ts`,
        ...args,
      ],
      input,
    );
  const importValue = (name: string, value: string) => {
    const r = keeper(['import', name], value);
    if (r.status !== 0) throw new Stop(`the keeper did not store ${name}: ${r.stderr.trim()}`);
    ok(`the keeper stored ${name}`);
  };
  /** A Keychain entry the deploy scripts wrote, base64 on disk. */
  const keychain = (name: string): string | null => {
    const r = run('security', [
      'find-generic-password',
      '-a',
      SECRET_ACCOUNT,
      '-s',
      storedSecretService(name),
      '-w',
    ]);
    if (r.status !== 0) return null;
    return Buffer.from(r.stdout.trim(), 'base64').toString('utf8').trim() || null;
  };

  step('0. Preflight');
  if (o.uid === 0)
    throw new Stop('run this as yourself, not as root; it uses sudo where it needs to');
  // The one password prompt. Every later sudo reuses it.
  const v = spawnSync('sudo', ['-v'], { stdio: 'inherit', env: o.env });
  if (v.status !== 0) throw new Stop('sudo did not accept the password');
  const check = keeper(['check']);
  const lines = `${check.stdout}${check.stderr}`.trim().split('\n');
  const unsafe = lines.filter((l) => l.startsWith('unsafe:'));
  if (unsafe.length) {
    for (const l of unsafe) o.print(`   ${l}`);
    throw new Stop('the keeper found a path another user could change (the unsafe: lines above)');
  }
  if (!lines.at(-1)?.startsWith('store: ok'))
    throw new Stop(`the keeper's check did not end with store: ok; run keeper-install.sh first`);
  const listed = (key: string) => {
    const l = lines.find((x) => x.startsWith(`${key}: `))?.slice(key.length + 2) ?? 'none';
    return new Set(l === 'none' ? [] : l.split(' ').filter(Boolean));
  };
  const held = listed('credentials');
  const adopted = listed('apps');
  const port = keeper(['port']).stdout.trim();
  if (!/^\d+$/.test(port)) throw new Stop(`keeper port printed '${port}', not a number`);
  const url = `http://localhost:${port}`;
  ok(`the keeper's store is sound and it answers on ${url}`);

  step('1. A new Fly org token, made with your own fly login');
  // The slug is no secret: the deploy scripts keep it in the Keychain beside the old token.
  const slug = keychain('fly-org-slug');
  if (held.has('fly-org-token')) {
    ok('the keeper holds a Fly org token already');
  } else {
    const org = slug;
    if (!org)
      throw new Stop(
        `the Keychain has no ${storedSecretService('fly-org-slug')}, the org the deploy scripts use`,
      );
    if (o.dryRun)
      would(`run fly tokens create org --org ${org} --name keeper, and import the token`);
    else {
      const r = run('fly', ['tokens', 'create', 'org', '--org', org, '--name', 'keeper']);
      if (r.status !== 0) throw new Stop(`fly tokens create failed: ${r.stderr.trim()}`);
      // fly prints `FlyV1 fm2_…`; fly reads the token without the scheme too,
      // and the keeper's import refuses a value holding whitespace.
      const token = r.stdout
        .split('\n')
        .map((l) => l.trim().replace(/^FlyV1 /, ''))
        .find((l) => /^fm\d_\S+$/.test(l));
      if (!token)
        throw new Stop(
          'fly printed no token this recognises, so nothing was imported. ' +
            'Revoke what it made: fly tokens list, then fly tokens revoke',
        );
      importValue('fly-org-token', token);
    }
  }
  if (held.has('fly-org-slug')) ok('the keeper holds the Fly org slug already');
  else if (slug) {
    if (o.dryRun) would(`import the org slug ${slug}`);
    else importValue('fly-org-slug', slug);
  }

  step('2. A new Cloudflare token, and the one account it sees');
  if (held.has('cloudflare-api-token') && held.has('cloudflare-account-id')) {
    ok('the keeper holds a Cloudflare token and account id already');
  } else if (o.dryRun) {
    would('make a token with the current one; if it cannot, ask you to make one, with:');
    for (const l of manualTokenSteps()) o.print(`   ${l}`);
    would('import the token, and the account id Cloudflare returns for it');
  } else if (held.has('cloudflare-api-token')) {
    // An earlier run stored the token and stopped: ask through the keeper.
    const r = await o.fetch(`${url}/v1/cloudflare/accounts`, { headers: { [API_HEADER]: '1' } });
    const body = (await r.json().catch(() => ({}))) as { result?: { id?: string }[] };
    const ids = (body.result ?? []).map((a) => a.id).filter((id) => typeof id === 'string');
    if (ids.length !== 1)
      throw new Stop(`the keeper's token sees ${ids.length} accounts; it must see exactly one`);
    importValue('cloudflare-account-id', ids[0] as string);
  } else {
    const current = keychain('cloudflare-api-token');
    const minted = current
      ? await mintKeeperToken(o.fetch, current, new Date().toISOString().slice(0, 10))
      : { why: 'the Keychain holds no cloudflare-api-token' };
    let token: string;
    if ('token' in minted) {
      token = minted.token;
      ok('made a new Cloudflare token with the current one');
    } else {
      o.print(`   The current token cannot make tokens (${minted.why}).`);
      for (const l of manualTokenSteps()) o.print(`   ${l}`);
      token = (
        await o.readSecret('   Paste the new token here (it is not shown), then press Return: ')
      ).trim();
      if (!token || /\s/.test(token))
        throw new Stop('that was not one token; nothing was imported');
    }
    const account = await oneAccount(o.fetch, token);
    if ('why' in account) throw new Stop(`the new token: ${account.why}; nothing was imported`);
    importValue('cloudflare-api-token', token);
    importValue('cloudflare-account-id', account.id);
  }

  step('3. Adopt the project apps made before the keeper');
  const list = run('fly', ['apps', 'list', '--json', ...(slug ? ['--org', slug] : [])]);
  if (list.status !== 0) throw new Stop(`fly apps list failed: ${list.stderr.trim()}`);
  let apps: string[];
  try {
    apps = (JSON.parse(list.stdout) as { Name?: string; name?: string }[])
      .map((a) => a.Name ?? a.name ?? '')
      .filter((n) => PROJECT_APP.test(n) && n !== PROBE_APP);
  } catch {
    throw new Stop('fly apps list --json did not print JSON');
  }
  const toAdopt = apps.filter((a) => !adopted.has(a));
  if (apps.length === 0) ok('no project apps exist yet');
  else if (toAdopt.length === 0) ok(`adopted already: ${apps.join(', ')}`);
  else if (o.dryRun) would(`adopt ${toAdopt.join(', ')}`);
  else {
    for (const app of toAdopt) {
      const r = keeper(['adopt', app]);
      if (r.status !== 0) throw new Stop(`the keeper did not adopt ${app}: ${r.stderr.trim()}`);
      ok(`adopted ${app}`);
    }
  }

  step(`4. Point the callers at ${url}`);
  const settingsPath = join(o.home, '.claude', 'settings.json');
  let settings: { env?: Record<string, string> } & Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      throw new Stop(`${settingsPath} is not JSON; fix it and run again`);
    }
  }
  if (settings.env?.CW_KEEPER_URL === url) ok(`${settingsPath} sets CW_KEEPER_URL already`);
  else if (o.dryRun) would(`set CW_KEEPER_URL=${url} in the env of ${settingsPath}`);
  else {
    settings.env = { ...settings.env, CW_KEEPER_URL: url };
    atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    ok(`set CW_KEEPER_URL in ${settingsPath}; sessions launched from now on have it`);
  }
  const plist = join(o.home, 'Library', 'LaunchAgents', `${o.label}.plist`);
  if (!existsSync(plist)) throw new Stop(`prod's launchd job ${plist} does not exist`);
  const xml = readFileSync(plist, 'utf8');
  const have = /<key>CW_KEEPER_URL<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1];
  if (have === url) ok(`prod's launchd job sets CW_KEEPER_URL already; prod not restarted`);
  else if (o.dryRun) would(`set CW_KEEPER_URL=${url} in ${plist}, then restart prod`);
  else {
    const next = withKeeperUrl(xml, url);
    if (!next) throw new Stop(`${plist} has no EnvironmentVariables dict to add CW_KEEPER_URL to`);
    copyFileSync(plist, `${plist}.bak.keeper-${Date.now()}`);
    atomicWrite(plist, next);
    ok(`set CW_KEEPER_URL in ${plist}`);
    restartProd(o, plist);
    ok(`restarted ${o.label}`);
  }

  step('5. Check it');
  const creds = join(o.root, 'state', 'credentials.json');
  let readable = true;
  try {
    readFileSync(creds);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM')
      throw new Stop(`reading ${creds} failed with ${code}, not Permission denied`);
    readable = false;
  }
  if (readable)
    throw new Stop(`this user can read ${creds}; the keeper's store must be closed to it`);
  ok(`${creds}: Permission denied`);
  if (o.dryRun) {
    would(
      `ask the keeper to run fly apps create ${PROBE_APP}, print its approval link, and withdraw it`,
    );
    o.print('');
    o.print('Dry run: nothing was changed.');
    return;
  }
  await probe(o, url, ok);
  o.print('');
  o.print(
    `The keeper is set up: it holds the tokens, the callers use ${url}, and the check passed.`,
  );
  o.print('Next, by hand: section 5 of docs/process/keeper.md, retiring the old tokens.');
}

/** The probe: a held call that prints its link, then is withdrawn so it can never run. */
async function probe(o: SetupOptions, url: string, ok: (s: string) => void): Promise<void> {
  const res = await o.fetch(`${url}/v1/fly`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [API_HEADER]: '1',
      'x-cw-requester': 'keeper-setup',
    },
    body: JSON.stringify({ args: ['apps', 'create', PROBE_APP] }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    pollToken?: string;
    approveUrl?: string;
    error?: string;
  };
  if (!res.headers.has(HELD_HEADER) || !body.id || !body.pollToken) {
    throw new Stop(
      `the keeper did not hold fly apps create ${PROBE_APP} for a passkey (${res.status}` +
        `${body.error ? `: ${body.error}` : ''}). Check fly apps list for ${PROBE_APP}`,
    );
  }
  ok(`the probe waits for your passkey at ${body.approveUrl}`);
  const gone = await o.fetch(`${url}/v1/requests/${body.id}`, {
    method: 'DELETE',
    headers: { [API_HEADER]: '1', 'x-cw-keeper-poll': body.pollToken },
  });
  if (!gone.ok)
    throw new Stop(`could not withdraw the probe; open ${body.approveUrl} and press Deny`);
  ok('withdrew the probe, so it created nothing and no tap can run it');
}

/** The plist with CW_KEEPER_URL set in EnvironmentVariables, or null when it has none. */
export function withKeeperUrl(xml: string, url: string): string | null {
  const existing = /(<key>CW_KEEPER_URL<\/key>\s*<string>)[^<]*(<\/string>)/;
  if (existing.test(xml)) return xml.replace(existing, `$1${url}$2`);
  const dict = /(<key>EnvironmentVariables<\/key>\s*<dict>)(\s*)/;
  const m = dict.exec(xml);
  if (!m) return null;
  const indent = m[2] ?? '\n        ';
  return xml.replace(
    dict,
    `$1${indent}<key>CW_KEEPER_URL</key>${indent}<string>${url}</string>${indent}`,
  );
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.keeper-setup.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Reload prod's job so launchd reads the new environment: `kickstart` would
 * restart it on the old one. The bootout-then-bootstrap is install.sh's own,
 * with its wait and retries (`scripts/launchd/bootstrap-retry.sh`).
 */
function restartProd(o: SetupOptions, plist: string): void {
  const helpers = join(import.meta.dir, '../../../../scripts/launchd/bootstrap-retry.sh');
  const domain = `gui/${o.uid}`;
  const r = spawnSync(
    '/bin/bash',
    [
      '-c',
      '. "$1"; if "$LAUNCHCTL" print "$2/$3" >/dev/null 2>&1; then "$LAUNCHCTL" bootout "$2/$3" || true; ' +
        'wait_for_bootout "$2/$3"; fi; bootstrap_with_retry "$2" "$4"',
      'restart',
      helpers,
      domain,
      o.label,
      plist,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], env: o.env },
  );
  if (r.status !== 0)
    throw new Stop(`prod did not come back; run: launchctl bootstrap ${domain} ${plist}`);
}
