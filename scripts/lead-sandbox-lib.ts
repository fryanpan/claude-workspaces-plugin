/**
 * A Seatbelt profile per Mac lead, so a lead's `claude` process cannot read
 * or write another project's files. The runbook is
 * `docs/process/lead-sandbox.md`; the CLI and launch wrapper is
 * `lead-sandbox.ts`.
 *
 * `mac-lead-users.ts` walls a lead off with a macOS user of its own, which
 * needs the owner's admin password. This needs nothing: `sandbox-exec` runs
 * as the owner, and a process can always narrow what it may do. The profile
 * allows everything by default and then denies the protected folders (the
 * owner's home, its data volume twin, the prod root and whatever the config
 * names), and opens back up, inside them, the lead's own projects and what
 * Claude Code needs to run.
 *
 * Seatbelt applies the last rule that matches, so the profile lists its
 * rules from the shortest path to the longest: the most specific folder
 * named decides. Every other lead's projects are protected for this one. And it matches a file by its resolved path, so a rule on a
 * symlink alone protects nothing; every path is written at both ends, as
 * `mac-lead-users-lib.ts` does for its ACLs.
 */
import { expandRealPaths } from './mac-lead-users-lib.ts';

export interface Lead {
  /** Lowercase words, for the profile's file name. */
  name: string;
  /** The lead's own repos: read and write, with their worktrees inside. */
  projects: string[];
  /** Extra folders or files the lead may read and write (a build cache). */
  allow: string[];
  /** Extra folders or files the lead may only read (`~/.gitconfig`). */
  allowRead: string[];
}

export interface LeadSandboxConfig {
  leads: Lead[];
  /** Folders no lead may read or write, beyond the built-in ones. */
  protect: string[];
}

/** The machine, as the generator may ask about it. */
export interface Machine {
  home: string;
  uid: number;
  /** The path with every symlink resolved, or the path itself if it is missing. */
  realpath(path: string): string;
}

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Folders every lead is denied whatever the config says, relative to the
 * home folder. The home holds every repo, every credential and every board's
 * data.
 */
export const BUILT_IN_PROTECT = [''];

/**
 * Prod's root: its checkout, its data folder and its releases. Denied after
 * every other rule, with the wall's own files, so no `allow` at any depth
 * reopens it.
 */
export const PROD_ROOT = 'Library/Application Support/claude-workspaces';

/**
 * What Claude Code reads and writes under the home folder to start, sign in
 * and keep its state, measured by running `claude -p` under the profile.
 * `~/.claude/projects` is denied again below this, and reopened only for the
 * lead's own transcript folders.
 */
export const CLAUDE_READ_WRITE = ['.claude', '.local/share/claude', '.local/state/claude'];
export const CLAUDE_READ = ['.local/bin', '.bun', 'Library/Keychains'];

type Access = 'deny' | 'read' | 'write';

interface Rule {
  access: Access;
  /** A `subpath`, or a `regex` for a transcript folder name. */
  filter: { subpath: string } | { literal: string } | { regex: string; under: string };
  why: string;
  /** Written after every other rule, so nothing reopens it. */
  last?: true;
}

/** The config, checked, or the reason it is refused. A path may start `~/`. */
export function parseConfig(
  raw: unknown,
  home: string,
): { ok: true; config: LeadSandboxConfig } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, error: 'config is not an object' };
  const r = raw as { leads?: unknown; protect?: unknown };
  if (!Array.isArray(r.leads) || r.leads.length === 0)
    return { ok: false, error: 'config.leads must list at least one lead' };
  const paths = (v: unknown, what: string): string[] | string => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((p) => typeof p === 'string'))
      return `${what} must be a list of paths`;
    const expanded = (v as string[]).map((p) => (p.startsWith('~/') ? `${home}${p.slice(1)}` : p));
    for (const p of expanded) {
      if (!p.startsWith('/')) return `${what}: ${p} must be absolute`;
      if (p === '/' || /\/\.\.?(\/|$)/.test(p))
        return `${what}: ${p} must name one folder, not / or a relative step`;
      if (/["\\\n\r]/.test(p)) return `${what}: ${p} must not hold a quote or a backslash`;
    }
    return expanded;
  };
  const leads: Lead[] = [];
  const seen = new Set<string>();
  for (const l of r.leads as unknown[]) {
    const o = (l ?? {}) as Record<string, unknown>;
    const name = o.name;
    if (typeof name !== 'string' || !NAME.test(name))
      return { ok: false, error: `lead name ${JSON.stringify(name)} must be lowercase words` };
    if (seen.has(name)) return { ok: false, error: `${name} is listed twice` };
    seen.add(name);
    const projects = paths(o.projects, `${name}.projects`);
    const allow = paths(o.allow, `${name}.allow`);
    const allowRead = paths(o.allowRead, `${name}.allowRead`);
    for (const p of [projects, allow, allowRead])
      if (typeof p === 'string') return { ok: false, error: p };
    if ((projects as string[]).length === 0)
      return { ok: false, error: `${name}.projects must name at least one repo` };
    leads.push({
      name,
      projects: projects as string[],
      allow: allow as string[],
      allowRead: allowRead as string[],
    });
  }
  const protect = paths(r.protect, 'protect');
  if (typeof protect === 'string') return { ok: false, error: protect };
  return { ok: true, config: { leads, protect } };
}

/** Claude Code's name for a project's transcript folder: every other character a dash. */
export function transcriptSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function under(home: string, rel: string): string {
  return rel === '' ? home : `${home}/${rel}`;
}

/** Every rule for one lead, before ordering and before both ends are written. */
function rulesFor(
  lead: Lead,
  config: LeadSandboxConfig,
  m: Machine,
  guard: readonly string[],
): Rule[] {
  const rules: Rule[] = [];
  const add = (access: Access, path: string, why: string) =>
    rules.push({ access, filter: { subpath: path }, why });
  for (const rel of BUILT_IN_PROTECT) add('deny', under(m.home, rel), 'protected');
  for (const p of config.protect) add('deny', p, 'protected');
  for (const other of config.leads)
    if (other.name !== lead.name)
      for (const p of other.projects) add('deny', p, `${other.name}'s project`);
  for (const rel of CLAUDE_READ_WRITE) add('write', under(m.home, rel), 'Claude Code');
  for (const rel of CLAUDE_READ) add('read', under(m.home, rel), 'Claude Code');
  // `~/.claude.json` and the temporary files it is replaced through.
  rules.push({
    access: 'write',
    filter: { regex: `^${escapeRegex(m.realpath(m.home))}/\\.claude\\.json[^/]*$`, under: m.home },
    why: 'Claude Code',
  });

  // Other projects' transcripts and scratch folders are other projects' data.
  const transcripts = `${m.home}/.claude/projects`;
  const scratch = `/private/tmp/claude-${m.uid}`;
  add('deny', transcripts, 'other projects');
  add('deny', scratch, 'other projects');
  // Claude Code opens the scratch root itself at start (measured: EPERM on
  // open without this). It lists the other projects' folder names, not
  // what is in them.
  rules.push({
    access: 'read',
    filter: { literal: scratch },
    why: 'Claude Code',
  });
  for (const p of lead.projects) {
    add('write', p, 'own project');
    const slugs = new Set([transcriptSlug(p), transcriptSlug(m.realpath(p))]);
    for (const slug of slugs) {
      for (const root of [transcripts, scratch]) {
        // The project's own folder, and one per worktree launched inside it.
        const regex = `^${escapeRegex(m.realpath(root))}/${escapeRegex(slug)}(--claude-worktrees-[^/]+)?(/|$)`;
        rules.push({ access: 'write', filter: { regex, under: root }, why: 'own transcripts' });
      }
    }
  }
  for (const p of lead.allow) add('write', p, 'config allow');
  for (const p of lead.allowRead) add('read', p, 'config allowRead');
  // The config and the profiles: a lead that could edit them would widen
  // its own next launch. Denied last, so no allow at any depth reopens them,
  // and prod's root with them.
  for (const p of guard)
    rules.push({ access: 'deny', filter: { subpath: p }, why: 'the wall itself', last: true });
  rules.push({
    access: 'deny',
    filter: { subpath: under(m.home, PROD_ROOT) },
    why: 'prod',
    last: true,
  });
  return rules;
}

function depth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

function sbString(s: string): string {
  return `"${s}"`;
}

const VERB: Record<Access, string> = {
  deny: '(deny file-read* file-write*',
  read: '(allow file-read*',
  write: '(allow file-read* file-write*',
};

/**
 * The profile for one lead. Rules run from the shortest path to the
 * longest, so the most specific folder named decides. The wall's own files
 * come after all of them. Every allowed path's ancestors may be looked up
 * (`stat`, not listed), which is what resolving a path inside a denied folder
 * needs.
 */
export function buildProfile(
  lead: Lead,
  config: LeadSandboxConfig,
  m: Machine,
  guard: readonly string[] = [],
): string {
  type Line = { depth: number; order: number; text: string };
  const lines: Line[] = [];
  const ancestors = new Set<string>();
  // At the same depth the lead's own grant wins over a shared protection:
  // the config may protect every project, the lead's own among them.
  const order: Record<Access, number> = { deny: 0, read: 1, write: 2 };
  for (const r of rulesFor(lead, config, m, guard)) {
    if ('subpath' in r.filter) {
      for (const p of expandRealPaths([r.filter.subpath], m.realpath)) {
        lines.push({
          depth: r.last ? Number.POSITIVE_INFINITY : depth(p),
          order: order[r.access],
          text: `${VERB[r.access]} (subpath ${sbString(p)})) ; ${r.why}`,
        });
        if (r.access !== 'deny') for (const a of ancestorsOf(p)) ancestors.add(a);
      }
    } else if ('literal' in r.filter) {
      for (const p of expandRealPaths([r.filter.literal], m.realpath)) {
        lines.push({
          // After the subpath of the same folder, which it narrows.
          depth: depth(p) + 0.5,
          order: order[r.access],
          text: `${VERB[r.access]} (literal ${sbString(p)})) ; ${r.why}`,
        });
        for (const a of ancestorsOf(p)) ancestors.add(a);
      }
    } else {
      const root = m.realpath(r.filter.under);
      lines.push({
        depth: depth(root) + 1,
        order: order[r.access],
        text: `${VERB[r.access]} (regex #${sbString(r.filter.regex)})) ; ${r.why}`,
      });
      for (const a of [...ancestorsOf(root), root]) ancestors.add(a);
    }
  }
  lines.sort((a, b) => a.depth - b.depth || a.order - b.order);
  const lookups = [...ancestors]
    .sort()
    .map((a) => `(allow file-read-metadata (literal ${sbString(a)}))`);
  return [
    `;; Seatbelt profile for lead ${lead.name}. Generated by scripts/lead-sandbox.ts; do not edit.`,
    '(version 1)',
    '(allow default)',
    ...lines.map((l) => l.text),
    ';; Looking up (not listing) each folder above an allowed path.',
    ...lookups,
    '',
  ].join('\n');
}

function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(`/${parts.slice(0, i).join('/')}`);
  return out;
}

/** The command that starts `argv` under the profile, in the lead's first project. */
export function launchCommand(
  lead: Lead,
  profilePath: string,
  argv: readonly string[],
): { cwd: string; argv: string[] } {
  return { cwd: lead.projects[0] ?? '/', argv: [SANDBOX_EXEC, '-f', profilePath, ...argv] };
}

/**
 * The folders a check must find refused, and the lead's own, which must
 * list. The prod root is left out on purpose: a check that lists it would
 * read prod's data folder names if the wall failed, and the home folder
 * above it proves the same deny.
 */
export function checkTargets(
  lead: Lead,
  config: LeadSandboxConfig,
  m: Machine,
): { own: string[]; protected: string[] } {
  const own = new Set(lead.projects);
  const others = config.leads.filter((o) => o.name !== lead.name).flatMap((o) => o.projects);
  return {
    own: lead.projects,
    protected: [...new Set([m.home, ...config.protect, ...others])].filter((p) => !own.has(p)),
  };
}
