#!/usr/bin/env bun
/**
 * The GitHub proxy for sandboxed leads: a git smart-HTTP server on loopback
 * that lets each lead fetch and push the repos its config names, with the
 * owner's GitHub credential, which no lead ever holds. Runbook:
 * `docs/process/lead-sandbox.md`, "GitHub through the proxy". The handler
 * is `git-proxy-server.ts`; the lead's side is `git-proxy-lead.ts`.
 *
 *   bun scripts/git-proxy.ts --config ~/.config/claude-workspaces/lead-sandbox.json
 *
 * Flags: `--tokens <dir>` (default `~/.config/claude-workspaces/git-proxy`),
 * `--credential-command <sh>` (default `gh auth token`), `--upstream <url>`
 * (default `https://github.com`), `--api <url>` (default
 * `https://api.github.com`). The port is the config's `gitProxyPort`, 8793
 * unless it says otherwise, on 127.0.0.1 only.
 *
 * The same process serves gh for leads whose `tools` list `gh`, on the unix
 * socket `ghProxySocket(uid)` (`--gh-socket <path>` to move it); the
 * handler is `gh-proxy-server.ts`.
 *
 * The credential is read once, at start, from the command's output, and
 * kept in memory: it is never written, logged or passed to a child.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ghProxySocket } from './gh-proxy-lead.ts';
import { createGhProxy } from './gh-proxy-server.ts';
import { GIT_PROXY_DIR, readLeadTokens } from './git-proxy-lead.ts';
import { redact } from './git-proxy-lib.ts';
import { createGitProxy } from './git-proxy-server.ts';
import { type LeadSandboxConfig, parseConfig } from './lead-sandbox-config.ts';

function main(argv: string[]): number {
  const say = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const given = flag('--config');
  if (!given) {
    say('usage: bun scripts/git-proxy.ts --config <lead-sandbox.json> [--tokens <dir>]');
    return 2;
  }
  const file = resolve(given);
  // The proxy's `git worktree add` runs `/usr/bin/git`, whose real binary an
  // Xcode cache a lead can write would otherwise choose (lead-tree-containment.md).
  process.env.xcrun_nocache = '1';
  const load = (): LeadSandboxConfig | string => {
    try {
      const parsed = parseConfig(JSON.parse(readFileSync(file, 'utf8')), homedir());
      return parsed.ok ? parsed.config : parsed.error;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const first = load();
  if (typeof first === 'string') {
    say(`config refused: ${first}`);
    return 2;
  }
  const tokens = resolve(flag('--tokens') ?? join(homedir(), GIT_PROXY_DIR));
  const command = flag('--credential-command') ?? 'gh auth token';
  const got = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  const credential = got.status === 0 ? got.stdout.trim() : '';
  if (!credential) {
    // Its stderr could carry part of a credential; say only that it failed.
    say(`no GitHub credential: \`${command}\` exited ${got.status} or printed nothing`);
    return 2;
  }
  // The last config that parsed: a bad edit leaves the proxy on the one before.
  let config = first;
  const leads = () => {
    const next = load();
    if (typeof next === 'string') say(`config refused, keeping the last one: ${next}`);
    else config = next;
    return readLeadTokens(config.leads, tokens);
  };
  const api = flag('--api') ?? 'https://api.github.com';
  const proxy = createGitProxy({
    credential,
    upstream: flag('--upstream') ?? 'https://github.com',
    api,
    leads,
    log: say,
  });
  const gh = createGhProxy({ credential, api, leads, log: (line) => say(`gh ${line}`) });
  for (const server of [proxy, gh])
    server.on('error', (err) => {
      say(`proxy stopped: ${redact(err.message, [credential])}`);
      process.exit(1);
    });
  // The socket's folder is the owner's alone; a socket left by the last run is transient.
  const socket = resolve(flag('--gh-socket') ?? ghProxySocket(process.getuid?.() ?? 0));
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  chmodSync(dirname(socket), 0o700);
  rmSync(socket, { force: true });
  gh.listen(socket, () => {
    chmodSync(socket, 0o600);
    say(`gh proxy on ${socket}`);
  });
  proxy.listen(first.gitProxyPort, '127.0.0.1', () => {
    const leads = first.leads.filter((l) => l.githubRepos.length > 0).map((l) => l.name);
    say(`git proxy on 127.0.0.1:${first.gitProxyPort} for ${leads.join(', ') || 'no lead yet'}`);
  });
  return -1;
}

const code = main(process.argv.slice(2));
if (code >= 0) process.exit(code);
