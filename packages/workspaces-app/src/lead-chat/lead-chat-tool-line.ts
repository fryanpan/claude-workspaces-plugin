/**
 * A tool call reduced to the line Claude Code's terminal prints for it: the
 * tool's short name and its one main argument — `Bash` and what the command
 * does, `Read` and a file's name, `Grep` and its pattern,
 * `find_and_replace` and the doc it edits. Never raw JSON.
 *
 * The hook (`plugin/hooks/lib/session-mirror.ts`) sends a Bash call's
 * command and a lone path as they are, and any other input as JSON capped at
 * 2000 characters. A capped object no longer parses, so the fields are also
 * read out of the text directly.
 */
import type { LeadChatToolCall } from '@claude-workspaces/core/lead-chat';

/** `mcp__plugin_claude-workspaces_claude-workspaces__find_and_replace` →
 *  `find_and_replace`; a name without the prefix is kept. */
export function shortToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const cut = name.lastIndexOf('__');
  return cut > 3 && cut + 2 < name.length ? name.slice(cut + 2) : name;
}

const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;
/** The fields that name what a call is about, most telling first. */
const MAIN_KEYS = [
  'description',
  'pattern',
  'query',
  'url',
  'skill',
  'title',
  'docId',
  'taskId',
  'threadId',
  'workspaceId',
  'name',
  'prompt',
  'text',
] as const;

const basename = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p;
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The input as an object of its string fields, parsed whole or, when the
 *  hook capped it, read field by field. */
function fields(input: string): Record<string, string> | null {
  const t = input.trim();
  if (!t.startsWith('{')) return null;
  const out: Record<string, string> = {};
  try {
    const o = JSON.parse(t) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
      return out;
    }
  } catch {
    // Capped mid-value: read what is whole.
  }
  for (const m of t.matchAll(/"([A-Za-z_][\w]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const [, k, raw] = m;
    if (!k || raw === undefined || k in out) continue;
    try {
      out[k] = JSON.parse(`"${raw}"`) as string;
    } catch {
      out[k] = raw;
    }
  }
  return out;
}

/** What the call is about, on one line, or empty when nothing says. */
function mainArg(name: string, input: string): string {
  const f = fields(input);
  if (name === 'Bash') {
    if (f?.description) return oneLine(f.description);
    const cmd = f?.command ?? input;
    return oneLine(cmd.split('\n').find((l) => l.trim() !== '') ?? '');
  }
  if (!f) {
    const first =
      input
        .split('\n')
        .find((l) => l.trim() !== '')
        ?.trim() ?? '';
    // A lone path, as the hook sends a Read's.
    return /^[^\s{}]*\/[^\s{}]*$/.test(first) ? basename(first) : oneLine(first);
  }
  if ((name === 'Grep' || name === 'Glob') && f.pattern) return f.pattern;
  for (const k of PATH_KEYS) {
    const p = f[k];
    if (p) return basename(p);
  }
  for (const k of MAIN_KEYS) {
    const v = f[k];
    if (v && v.trim() !== '') return oneLine(v);
  }
  const any = Object.values(f).find((v) => v.trim() !== '');
  return any ? oneLine(any) : '';
}

/** The tool row's line: the short name and the main argument. */
export function toolLine(t: LeadChatToolCall): { name: string; arg: string } {
  const name = shortToolName(t.name);
  return { name, arg: mainArg(name, t.input) };
}
