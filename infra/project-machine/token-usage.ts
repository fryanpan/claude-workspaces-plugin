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
import { PROJECT_NAME } from './deploy-plan.ts';
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

export const leadReadCommand = (root = LEAD_ROOT, path = MACHINE_PATH): string =>
  asLead(
    `echo ${START}; cat ${root}/token-label 2>/dev/null || echo; cat ${root}/usage.json 2>/dev/null; exit 0`,
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

/** The projects to read: those named, or every `cw-` app on Fly. */
function projectsToRead(named: readonly string[]): string[] {
  if (named.length > 0) {
    const bad = named.find((p) => !PROJECT_NAME.test(p));
    if (bad !== undefined) throw new Error(`${bad} is not a project name`);
    return [...named];
  }
  return flyJson<{ Name?: string; name?: string }[]>(['apps', 'list'])
    .map((a) => a.Name ?? a.name ?? '')
    .filter((n) => n.startsWith('cw-') && PROJECT_NAME.test(n.slice(3)))
    .map((n) => n.slice(3))
    .sort();
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
const NO_LIMITS = (p: string) => `no reading: the status line ran on ${p}, with no rate_limits`;

/** Why these projects give no numbers, from the most telling one. */
function noReading(projects: readonly ProjectUsage[]): string {
  if (projects.length === 0) return 'no reading: no project runs on it';
  const ran = projects.find((p) => p.usage !== null);
  if (ran) return NO_LIMITS(ran.project);
  return NOT_RUN((projects[0] as ProjectUsage).project);
}

const hasNumbers = (u: UsageFile | null): u is UsageFile => u !== null && u.readAt !== null;

/**
 * One line per listed token, with its newest reading from any project,
 * attributed by the label in the reading: a project just moved still holds
 * its last reading of the old token. A project on its own sign-in has a line
 * of its own, because two of those are two tokens.
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
    const newest = reports
      .map((r) => r.usage)
      .filter(hasNumbers)
      .filter((u) => u.label === label)
      .sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0))[0];
    const projects = reports.filter((r) => r.label === label);
    line(labels.includes(label) ? label : `${label} (not on the list)`, projects, newest);
  }
  for (const r of reports) {
    if (r.error) {
      gap = true;
      out.push(`[${r.project}]: ${r.error}`);
    } else if (!r.label) {
      const own = hasNumbers(r.usage) && r.usage.label === '' ? r.usage : undefined;
      line('own sign-in', [r], own);
    }
  }
  if (gap) {
    out.push(
      'unproven: whether rate_limits appears for a session signed in with CLAUDE_CODE_OAUTH_TOKEN. The docs do not say, and they give it only on Pro, Max and Ultra plans, after a first answer.',
    );
  }
  return out;
}
