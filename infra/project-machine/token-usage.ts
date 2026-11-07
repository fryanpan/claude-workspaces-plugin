/**
 * What `machine:tokens usage` reads: each project's machine, for the label of
 * the token its lead runs on and the lead's last reading (`lead-usage.ts`).
 *
 * The files are in the lead's own folder, so the read runs as `lead`, never
 * as root: a link the lead planted there reaches only what the lead can
 * already read. Only a label and numbers are parsed out of the answer, and
 * the answer itself is never printed.
 *
 * Through the keeper `fly ssh console` is a `token.move` hold, so each
 * project read is one passkey tap. No route on the project's server reports
 * this, and adding one is not free: it is a new path to reach from outside.
 */
import { LEAD_BOARD_SECRET, PROJECT_NAME } from './deploy-plan.ts';
import {
  TOKEN_LABEL,
  type UsageFile,
  type UsageWindow,
  parseUsageFile,
  percent,
} from './lead-usage.ts';
import { flyJson, onMachine } from './mac-ops.ts';

export const LEAD_ROOT = '/data/lead';
/** The image's PATH (oven/bun's debian base). */
export const MACHINE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const START = 'cw-usage-start';

/** `script`, as the machine's `lead` user with a clean environment. */
export const asLead = (script: string, path: string): string =>
  `env -i PATH=${path} setpriv --reuid=lead --regid=lead --init-groups -- sh -c '${script}'`;

/** A file the lead wrote, which may be a pipe that never ends: bounded in time and size. */
export const boundedRead = (file: string, bytes: number): string =>
  `timeout 5 head -c ${bytes} ${file} 2>/dev/null`;

export const leadReadCommand = (root = LEAD_ROOT, path = MACHINE_PATH): string =>
  asLead(
    `echo ${START}; ${boundedRead(`${root}/token-label`, 256)} || echo; ${boundedRead(`${root}/usage.json`, 4096)}; exit 0`,
    path,
  );

export interface LeadRead {
  /** The token's label; '' for a project's own sign-in; null when unreadable. */
  label: string | null;
  usage: UsageFile | null;
}

export interface ProjectUsage extends LeadRead {
  project: string;
  error?: string;
}

export function parseLeadRead(stdout: string): LeadRead {
  const lines = stdout.split(/\r?\n/);
  const at = lines.indexOf(START);
  if (at < 0) return { label: null, usage: null };
  const label = (lines[at + 1] ?? '').trim();
  return {
    label: label === '' || TOKEN_LABEL.test(label) ? label : null,
    usage: parseUsageFile(lines[at + 2] ?? ''),
  };
}

/** The projects to read: those named, or every `cw-` app on Fly with a lead. */
function projectsToRead(named: readonly string[]): string[] {
  if (named.length > 0) {
    const bad = named.find((p) => !PROJECT_NAME.test(p));
    if (bad !== undefined) throw new Error(`${bad} is not a project name`);
    return [...named];
  }
  return flyJson<{ Name?: string; name?: string }[]>(['apps', 'list'])
    .map((a) => a.Name ?? a.name ?? '')
    .filter((n) => n.startsWith('cw-') && PROJECT_NAME.test(n.slice(3)))
    .filter(hasLead)
    .map((n) => n.slice(3))
    .sort();
}

/** A routine read, so an app with no lead costs no tap. Unknown counts as having one. */
function hasLead(app: string): boolean {
  try {
    const secrets = flyJson<{ Name?: string; name?: string }[]>(['secrets', 'list', '--app', app]);
    return secrets.some((s) => (s.Name ?? s.name) === LEAD_BOARD_SECRET);
  } catch {
    return true;
  }
}

export function usageReport(named: readonly string[]): ProjectUsage[] {
  return projectsToRead(named).map((project) => {
    try {
      return { project, ...parseLeadRead(onMachine(`cw-${project}`, leadReadCommand())) };
    } catch {
      return { project, label: null, usage: null, error: 'could not read the machine' };
    }
  });
}

const stamp = (seconds: number): string =>
  `${new Date(seconds * 1000).toISOString().slice(5, 16).replace('T', ' ')}Z`;

function windowText(name: string, w: UsageWindow | null, now: number): string {
  if (!w) return `${name} -`;
  const ends = w.resetsAt * 1000 <= now ? 'window ended' : `ends ${stamp(w.resetsAt)}`;
  return `${name} ${percent(w.usedPercent)} (${ends})`;
}

function readingText(u: UsageFile, now: number): string {
  const minutes = Math.floor((now - (u.readAt ?? u.seenAt)) / 60_000);
  const windows = `${windowText('5h', u.fiveHour, now)}, ${windowText('7d', u.sevenDay, now)}`;
  return `${windows}, read ${minutes} min ago`;
}

const NOT_RUN = (p: string) => `no reading: the status line has not run on ${p}`;
const NO_LIMITS = (p: string) =>
  `no reading: the status line ran on ${p}, with no rate_limits so far`;

/** Whether this report's reading is of the token the project runs on now. */
const ownReading = (r: ProjectUsage): UsageFile | null =>
  r.usage !== null && r.usage.label === r.label ? r.usage : null;

/** Why these projects give no numbers, from the most telling one. */
function noReading(projects: readonly ProjectUsage[]): string {
  if (projects.length === 0) return 'no reading: no project runs on it';
  const ran = projects.find((p) => ownReading(p) !== null);
  if (ran) return NO_LIMITS(ran.project);
  return NOT_RUN((projects[0] as ProjectUsage).project);
}

const hasNumbers = (u: UsageFile | null): u is UsageFile => u !== null && u.readAt !== null;

/**
 * One line per listed token, with the newest reading from the projects on it
 * now. A project just moved has no reading of its new token yet, and its last
 * reading of the old one is not used: the file is the lead's to write, and a
 * reading counted for a token its project does not run on would let one lead
 * speak for another's. What a lead says of its own token is taken as it comes.
 * A project on its own sign-in has a line of its own, because two of those are
 * two tokens.
 */
export function renderUsage(
  labels: readonly string[],
  reports: readonly ProjectUsage[],
  now: number,
): string[] {
  const out: string[] = [];
  let gap = false;
  const line = (name: string, projects: readonly ProjectUsage[], u: UsageFile | undefined) => {
    const on = projects.map((p) => p.project).join(', ') || '-';
    if (!u) gap = true;
    out.push(`${name} [${on}]: ${u ? readingText(u, now) : noReading(projects)}`);
  };
  const seen = reports.flatMap((r) => (r.label ? [r.label] : []));
  for (const label of new Set([...labels, ...seen])) {
    const projects = reports.filter((r) => r.label === label);
    const newest = projects
      .map(ownReading)
      .filter(hasNumbers)
      .filter((u) => (u.readAt ?? 0) <= now)
      .sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0))[0];
    line(labels.includes(label) ? label : `${label} (not on the list)`, projects, newest);
  }
  for (const r of reports) {
    if (r.error) {
      gap = true;
      out.push(`[${r.project}]: ${r.error}`);
    } else if (r.label === null) {
      gap = true;
      out.push(`[${r.project}]: the machine's label is unreadable`);
    } else if (r.label === '') {
      const own = ownReading(r);
      line('own sign-in', [r], hasNumbers(own) ? own : undefined);
    }
  }
  if (gap) {
    out.push(
      'unproven: whether rate_limits appears for a session signed in with CLAUDE_CODE_OAUTH_TOKEN. The docs do not say, and they give it only on Pro, Max and Ultra plans, after a first answer.',
    );
  }
  return out;
}
