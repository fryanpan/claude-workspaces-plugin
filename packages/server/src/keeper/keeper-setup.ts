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
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SECRET_ACCOUNT, storedSecretService } from '../../../core/src/secret-name.ts';
import { API_HEADER, HELD_HEADER } from './keeper-http.ts';
import {
  type CfAccount,
  manualTokenSteps,
  mintKeeperToken,
  oneAccount,
  theOneAccount,
} from './keeper-setup-cloudflare.ts';

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
  /** Read one line from the terminal, shown as typed. */
  readLine: (prompt: string) => Promise<string>;
  print: (line: string) => void;
}

/** The deploy's app name for a project (`infra/project-machine/deploy-plan.ts`). */
const PROJECT_APP = /^cw-[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const PROBE_APP = 'cw-keeper-probe';
/** A Fly org slug; never starting with `-`, so it cannot read as a flag. */
const FLY_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** One y/N answer; anything but y or yes is no. */
async function yes(o: SetupOptions, prompt: string): Promise<boolean> {
  return /^\s*y(es)?\s*$/i.test(await o.readLine(prompt));
}

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
  /** `undo` says how to retire a token that was made but not stored. */
  const importValue = (name: string, value: string, undo?: string) => {
    const r = keeper(['import', name], value);
    if (r.status !== 0)
      throw new Stop(
        `the keeper did not store ${name}: ${r.stderr.trim()}${undo ? `. ${undo}` : ''}`,
      );
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
  // stdout only: a runtime warning on stderr is not the keeper's verdict.
  const lines = check.stdout.trim().split('\n');
  const unsafe = lines.filter((l) => l.startsWith('unsafe:'));
  if (unsafe.length) {
    for (const l of unsafe) o.print(`   ${l}`);
    throw new Stop('the keeper found a path another user could change (the unsafe: lines above)');
  }
  if (!lines.at(-1)?.startsWith('store: ok')) {
    const said = (check.stderr.trim() || check.stdout.trim()).split('\n').at(-1) ?? '';
    throw new Stop(
      `the keeper's check did not end with store: ok (${said || `exit ${check.status}`}); ` +
        'if the keeper is not installed, run keeper-install.sh first',
    );
  }
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

  step('Confirm the org and the account');
  // Both come from stores anything running as you can write, so you see them
  // before a token is made for them or stored.
  const slug = keychain('fly-org-slug');
  if (!slug)
    throw new Stop(
      `the Keychain has no ${storedSecretService('fly-org-slug')}, the org the deploy scripts use`,
    );
  if (!FLY_SLUG.test(slug)) throw new Stop(`the Keychain's Fly org slug '${slug}' is not a slug`);
  const needFly = !held.has('fly-org-token') || !held.has('fly-org-slug');
  const needCf = !(held.has('cloudflare-api-token') && held.has('cloudflare-account-id'));
  let account: CfAccount | null = null;
  let current: string | null = null;
  if (needCf && !o.dryRun) {
    if (held.has('cloudflare-api-token')) {
      // An earlier run stored the token and stopped: ask through the keeper.
      const r = await o.fetch(`${url}/v1/cloudflare/accounts`, { headers: { [API_HEADER]: '1' } });
      const body = (await r.json().catch(() => ({}))) as { result?: unknown };
      const one = theOneAccount(body.result);
      if ('why' in one) throw new Stop(`the keeper's Cloudflare token: ${one.why}`);
      account = one;
    } else {
      current = keychain('cloudflare-api-token');
      const one = current ? await oneAccount(o.fetch, current) : null;
      if (one && !('why' in one)) account = one;
    }
  }
  o.print(`   Fly org:            ${slug}`);
  if (!needCf) o.print('   Cloudflare account: stored already');
  else if (account) o.print(`   Cloudflare account: ${account.name}`);
  else if (o.dryRun)
    o.print(
      '   Cloudflare account: read with the current token in a real run (a dry run reads none)',
    );
  else o.print('   Cloudflare account: the one your pasted token sees, shown before it is stored');
  if (!needFly && !needCf) ok('nothing to make or store');
  else if (o.dryRun) would('ask you to confirm these before anything is made or stored');
  else if (!(await yes(o, '   Make and store tokens for these? [y/N] ')))
    throw new Stop('you did not confirm; nothing was made or stored');

  step('1. A new Fly org token, made with your own fly login');
  if (held.has('fly-org-token')) {
    ok('the keeper holds a Fly org token already');
  } else if (o.dryRun) {
    would(`run fly tokens create org --org ${slug} --name keeper, and import the token`);
  } else {
    const r = run('fly', ['tokens', 'create', 'org', '--org', slug, '--name', 'keeper']);
    if (r.status !== 0) throw new Stop(`fly tokens create failed: ${r.stderr.trim()}`);
    const revoke =
      `Revoke the token it made: fly tokens list --org ${slug}, then ` +
      'fly tokens revoke <id> for the one named keeper';
    // fly prints `FlyV1 fm2_…`; fly reads the token without the scheme too,
    // and the keeper's import refuses a value holding whitespace.
    const token = r.stdout
      .split('\n')
      .map((l) => l.trim().replace(/^FlyV1 /, ''))
      .find((l) => /^fm\d_\S+$/.test(l));
    if (!token)
      throw new Stop(`fly printed no token this recognises, so nothing was imported. ${revoke}`);
    importValue('fly-org-token', token, revoke);
  }
  if (held.has('fly-org-slug')) ok('the keeper holds the Fly org slug already');
  else if (o.dryRun) would(`import the org slug ${slug}`);
  else importValue('fly-org-slug', slug);

  step('2. A new Cloudflare token, and the one account it sees');
  if (!needCf) {
    ok('the keeper holds a Cloudflare token and account id already');
  } else if (o.dryRun) {
    would('make a token with the current one; if it cannot, ask you to make one, with:');
    for (const l of manualTokenSteps()) o.print(`   ${l}`);
    would('import the token, and the account id Cloudflare returns for it');
  } else if (held.has('cloudflare-api-token')) {
    importValue('cloudflare-account-id', (account as CfAccount).id);
  } else {
    const name = `claude-workspaces keeper ${new Date().toISOString().slice(0, 10)}`;
    const minted = current
      ? await mintKeeperToken(o.fetch, current, name)
      : { why: 'the Keychain holds no cloudflare-api-token' };
    let token: string;
    let remove: string;
    if ('token' in minted) {
      token = minted.token;
      remove = `Delete the token "${name}" in the Cloudflare dashboard: My Profile > API Tokens`;
      ok('made a new Cloudflare token with the current one');
    } else {
      o.print(`   The current token cannot make tokens (${minted.why}).`);
      for (const l of manualTokenSteps()) o.print(`   ${l}`);
      token = (
        await o.readSecret('   Paste the new token here (it is not shown), then press Return: ')
      ).trim();
      if (!token || /\s/.test(token))
        throw new Stop('that was not one token; nothing was imported');
      remove = 'Delete the token you made in the Cloudflare dashboard: My Profile > API Tokens';
    }
    const seen = await oneAccount(o.fetch, token);
    if ('why' in seen)
      throw new Stop(`the new token: ${seen.why}; nothing was imported. ${remove}`);
    if (account && seen.id !== account.id)
      throw new Stop(
        `the new token sees a different account than the one you confirmed. ${remove}`,
      );
    if (!account) {
      o.print(`   Cloudflare account: ${seen.name}`);
      if (!(await yes(o, '   Store the token for this account? [y/N] ')))
        throw new Stop(`you did not confirm; nothing was stored. ${remove}`);
    }
    importValue('cloudflare-api-token', token, remove);
    importValue('cloudflare-account-id', seen.id);
  }

  step('3. Adopt the project apps made before the keeper');
  const list = run('fly', ['apps', 'list', '--json', '--org', slug]);
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
  // Judge prod by the job launchd is running, not by the file: a restart cut
  // short leaves the file right and prod booted out or on its old environment.
  const running = () => {
    const r = run('launchctl', ['print', `gui/${o.uid}/${o.label}`]);
    if (r.status !== 0) return { loaded: false, url: undefined };
    return { loaded: true, url: /\bCW_KEEPER_URL => (\S+)/.exec(r.stdout)?.[1] };
  };
  const job = running();
  const state = !job.loaded
    ? 'not loaded'
    : job.url === url
      ? 'running with it'
      : 'running without it';
  if (have === url && job.url === url) ok('prod runs with CW_KEEPER_URL already; not restarted');
  else if (o.dryRun) {
    if (have !== url) would(`set CW_KEEPER_URL=${url} in ${plist}`);
    would(`restart prod (it is ${state})`);
  } else {
    if (have !== url) {
      const next = withKeeperUrl(xml, url);
      if (!next)
        throw new Stop(`${plist} has no EnvironmentVariables dict to add CW_KEEPER_URL to`);
      copyFileSync(plist, `${plist}.bak.keeper-${Date.now()}`);
      atomicWrite(plist, next);
      ok(`set CW_KEEPER_URL in ${plist}`);
    }
    restartProd(o, plist);
    if (running().url !== url)
      throw new Stop(
        `launchd does not show ${o.label} running with CW_KEEPER_URL after the restart`,
      );
    ok(`restarted ${o.label}; it runs with CW_KEEPER_URL`);
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

/** Replace a file in one rename, keeping its mode (600 for a new one). */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.keeper-setup.tmp`;
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
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
