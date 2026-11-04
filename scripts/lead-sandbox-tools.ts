/**
 * The tools a lead's config may open inside its wall (`tools: [...]`), and
 * the `bun` wrapper every walled lead gets. Turned into profile rules by
 * `lead-sandbox-lib.ts` and into the lead's environment by `lead-sandbox.ts`.
 *
 * - `adb`: reads `~/Android/Sdk/platform-tools`, and connects to adb's server
 *   on port 5037. Without it that port is refused, because the server on it
 *   drives every phone plugged into this Mac.
 * - `uv`: `uv` and `uvx` with a cache of the lead's own
 *   (`~/Library/Caches/claude-workspaces/lead-sandbox/<lead>/uv`), and read
 *   access to the Pythons uv installed (`~/.local/share/uv/python`). The
 *   owner's cache stays out of the wall: a lead that wrote to it could change
 *   a package the owner's next `uvx` runs.
 *
 * - `gh`: gh sends its API calls to the gh proxy's socket
 *   (`gh-proxy-lead.ts`), which holds the owner's credential and passes
 *   only reads and PR create, comment and edit on the lead's `githubRepos`.
 *   Needs `githubRepos`. Without it the socket is refused.
 *
 * The `bun` wrapper: a plugin MCP server such as Discord starts with
 * `bun run --cwd <plugin> start`, and its start script runs `bun install`
 * first. In the plugin cache the wall refuses every write, so that install
 * exits 1 (`Failed to link which: EPERM`, measured 4 November 2026) and the
 * server never starts. The wrapper sets `BUN_CONFIG_SKIP_INSTALL_PACKAGES=1`
 * for a bun whose folder is in `~/.claude/plugins`, and for no other folder.
 * There the install could not write anyway; the plugin runs on the packages
 * an unwalled session installed.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGhFiles, ghNetworkRules, ghProxySocket } from './gh-proxy-lead.ts';
import { gitProxyLeadDir } from './git-proxy-lead.ts';

export const LEAD_TOOLS = ['adb', 'uv', 'gh'] as const;
export type LeadTool = (typeof LEAD_TOOLS)[number];

/** The port adb's client finds its server on. */
export const ADB_SERVER_PORT = 5037;
export const ADB_SDK = 'Android/Sdk/platform-tools';
export const UV_PYTHONS = '.local/share/uv/python';

/** Each lead's `bun` wrapper, under `<home>/<LEAD_TOOLS_DIR>/<lead>/bin`. Read only to the lead. */
export const LEAD_TOOLS_DIR = '.config/claude-workspaces/lead-tools';
/** Each lead's own caches, under `<home>/<LEAD_CACHE_DIR>/<lead>`. */
export const LEAD_CACHE_DIR = 'Library/Caches/claude-workspaces/lead-sandbox';

/** A lead's `tools`, checked, or the reason it is refused. */
export function parseTools(v: unknown, lead: string): LeadTool[] | string {
  if (v === undefined) return [];
  if (
    !Array.isArray(v) ||
    !v.every((t) => (LEAD_TOOLS as readonly unknown[]).includes(t)) ||
    new Set(v).size !== v.length
  )
    return `${lead}.tools must list distinct names from: ${LEAD_TOOLS.join(', ')}`;
  return v as LeadTool[];
}

interface ToolLead {
  name: string;
  tools: readonly LeadTool[];
}

export function leadToolsDir(home: string, lead: string): string {
  return join(home, LEAD_TOOLS_DIR, lead);
}

function uvCache(home: string, lead: string): string {
  return join(home, LEAD_CACHE_DIR, lead, 'uv');
}

/** What the lead may read and not write: its wrapper's folder, and each tool's files. */
export function toolReadPaths(lead: ToolLead, home: string): string[] {
  return [
    leadToolsDir(home, lead.name),
    ...(lead.tools.includes('adb') ? [join(home, ADB_SDK)] : []),
    ...(lead.tools.includes('uv') ? [join(home, UV_PYTHONS)] : []),
  ];
}

/** What the lead may write: its own caches. */
export function toolWritePaths(lead: ToolLead, home: string): string[] {
  return lead.tools.includes('uv') ? [uvCache(home, lead.name)] : [];
}

/** Port 5037 is refused at every address unless the lead has `adb`, and the gh proxy's socket unless it has `gh`. */
export function toolNetworkRules(
  lead: ToolLead,
  ghSocket: string,
  adbPort: number = ADB_SERVER_PORT,
): string[] {
  return [
    ...(lead.tools.includes('adb')
      ? []
      : [`(deny network-outbound (remote ip "*:${adbPort}")) ; adb's server`]),
    ...ghNetworkRules(lead, ghSocket),
  ];
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The wrapper's text. `readOnly` are the folders, at both ends of each
 * symlink, in which the install is skipped; `realBun` is the bun it runs.
 */
export function bunWrapper(lead: string, realBun: string, readOnly: readonly string[]): string {
  const cases = readOnly.flatMap((d) => [shQuote(d), `${shQuote(d)}/*`]).join('|');
  return [
    '#!/bin/sh',
    `# Written by scripts/lead-sandbox.ts for ${lead}; do not edit. See lead-sandbox-tools.ts.`,
    'dir=$PWD',
    'prev=',
    'for a in "$@"; do',
    '  case "$prev" in --cwd) dir=$a ;; esac',
    '  case "$a" in --cwd=*) dir=${a#--cwd=} ;; esac',
    '  prev=$a',
    'done',
    `case "$dir" in ${cases}) export BUN_CONFIG_SKIP_INSTALL_PACKAGES=1 ;; esac`,
    `exec ${shQuote(realBun)} "$@"`,
    '',
  ].join('\n');
}

/** The first `bun` on `path` outside `wrappers` (every lead's wrapper folder), or null. */
export function bunOnPath(
  path: string | undefined,
  wrappers: string,
  exists: (p: string) => boolean,
): string | null {
  for (const dir of (path ?? '').split(':')) {
    if (dir === '' || dir.startsWith(wrappers)) continue;
    if (exists(join(dir, 'bun'))) return join(dir, 'bun');
  }
  return null;
}

/** The plugin cache at both ends of `~/.claude`. */
export function pluginDirs(home: string, realpath: (p: string) => string): string[] {
  const claude = join(home, '.claude');
  return [...new Set([claude, realpath(claude)])].map((c) => `${c}/plugins`);
}

/**
 * Write the lead's wrapper and make its caches, and answer what its
 * environment gains: the wrapper first on PATH, and each tool's settings.
 * No value is a secret. `realBun` null is the first bun on `path`.
 */
export function ensureLeadTools(
  lead: ToolLead,
  home: string,
  realBun: string | null,
  realpath: (p: string) => string,
  path: string | undefined,
  ghSocket: string = ghProxySocket(process.getuid?.() ?? 0),
): Record<string, string> {
  const bin = join(leadToolsDir(home, lead.name), 'bin');
  // Not the bun running the launch: from prod's checkout that may be prod's
  // `bin/bun`, under the prod root the wall refuses.
  const bun =
    realBun ?? bunOnPath(path, join(home, LEAD_TOOLS_DIR), existsSync) ?? process.execPath;
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const wrapper = join(bin, 'bun');
  writeFileSync(wrapper, bunWrapper(lead.name, bun, pluginDirs(home, realpath)));
  chmodSync(wrapper, 0o700);
  const env: Record<string, string> = { PATH: path ? `${bin}:${path}` : bin };
  if (lead.tools.includes('uv')) {
    const cache = uvCache(home, lead.name);
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    env.UV_CACHE_DIR = join(cache, 'cache');
    env.UV_TOOL_DIR = join(cache, 'tools');
  }
  if (lead.tools.includes('gh'))
    Object.assign(env, ensureGhFiles(lead.name, gitProxyLeadDir(home, lead.name), ghSocket));
  return env;
}
