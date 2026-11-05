/**
 * The lead's half of the gh proxy (`gh-proxy-server.ts`): where its socket
 * is, the gh config and environment a lead with the `gh` tool gets, and the
 * profile rule for every other lead. Runbook: `docs/process/lead-sandbox.md`,
 * "gh through the proxy".
 *
 * gh reads `http_unix_socket` from its config and then sends every API
 * request, in plain HTTP, to that socket (gh 2.102, measured 4 November
 * 2026). The proxy, outside the wall, checks the request against the lead's
 * repo list and sends it on to GitHub with the owner's credential. Inside
 * the wall, `GH_TOKEN` is the lead's own proxy token, the one its git sends.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureLeadToken } from './git-proxy-lead.ts';

/** The socket the git proxy serves gh on. Unix socket paths may be at most 104 bytes. */
export function ghProxySocket(uid: number): string {
  return `/private/tmp/cw-${uid}-gh/api.sock`;
}

/** gh's config for a walled lead: every API call goes to the proxy's socket. */
export function leadGhConfig(lead: string, socket: string): string {
  return [
    `# Written by scripts/lead-sandbox.ts for ${lead}; do not edit. gh goes through the proxy.`,
    'version: "1"',
    'git_protocol: https',
    `http_unix_socket: ${socket}`,
    '',
  ].join('\n');
}

/**
 * Write gh's config into `<dir>/gh` (`dir` is the lead's git-proxy folder,
 * which the lead reads and never writes), and return the environment that
 * points gh at it. `GH_TOKEN` also outranks any token the owner's shell
 * exported, so gh inside the wall never sends one.
 */
export function ensureGhFiles(lead: string, dir: string, socket: string): Record<string, string> {
  const token = readFileSync(ensureLeadToken(dir), 'utf8').trim();
  const configDir = join(dir, 'gh');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'config.yml'), leadGhConfig(lead, socket), { mode: 0o600 });
  return {
    GH_CONFIG_DIR: configDir,
    GH_TOKEN: token,
    GH_HOST: 'github.com',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
  };
}

/** A lead without `gh` cannot connect to the proxy's socket; the token check is the second wall. */
export function ghNetworkRules(lead: { tools: readonly string[] }, socket: string): string[] {
  if (lead.tools.includes('gh')) return [];
  return [`(deny network-outbound (remote unix-socket (path-literal "${socket}"))) ; the gh proxy`];
}
