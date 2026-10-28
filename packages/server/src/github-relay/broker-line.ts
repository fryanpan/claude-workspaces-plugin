/**
 * Reading one line the GitHub broker queued.
 *
 * The broker (`~/dev/github-claude-channel/broker.ts`) hands a session plain
 * strings, one per event, each opening with an icon and naming the repo in
 * backticks before anything a GitHub user wrote:
 *
 *   ✅/❌ CI · 👀 review requested · 💬 mention or comment · 📌 assigned ·
 *   🔀 merged / 🚫 closed · 🆕 new issue · 🚀/💥 deploy
 *
 * So the kind is the icon and the repo is the first backticked `owner/name`.
 * A line that opens with no known icon is not an event this relay forwards.
 */
import { type GithubEventKind, UNSAFE_GITHUB_TEXT } from '../github-hub.ts';

const KIND_BY_ICON: ReadonlyArray<readonly [string, GithubEventKind]> = [
  ['✅', 'ci'],
  ['❌', 'ci'],
  ['👀', 'review'],
  ['💬', 'mention'],
  ['📌', 'mention'],
  ['🔀', 'merge'],
  ['🚫', 'merge'],
  ['🆕', 'issue'],
  ['🚀', 'deploy'],
  ['💥', 'deploy'],
];

const REPO_IN_TICKS = /`([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})`/;
/** What the board refuses in a pushed text, removed here so a title holding
 *  one still arrives, minus that character. */
const UNSAFE = new RegExp(UNSAFE_GITHUB_TEXT.source, 'g');
export const BROKER_TEXT_MAX = 2_000;

export interface BrokerEvent {
  repo: string;
  kind: GithubEventKind;
  text: string;
}

/** The repo and kind a broker line is about, or null for one it is not. */
export function readBrokerLine(line: unknown): BrokerEvent | null {
  if (typeof line !== 'string') return null;
  const trimmed = line.trimStart();
  const kind = KIND_BY_ICON.find(([icon]) => trimmed.startsWith(icon))?.[1];
  if (!kind) return null;
  const repo = REPO_IN_TICKS.exec(trimmed)?.[1];
  if (!repo) return null;
  const text = trimmed.replace(UNSAFE, '').slice(0, BROKER_TEXT_MAX);
  return { repo, kind, text };
}
