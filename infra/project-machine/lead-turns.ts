#!/usr/bin/env bun
/**
 * The lead's billed turns, as numbers: one line per request in its
 * transcripts since a given time, with the model and the four token counts
 * Claude Code records. `machine-burn.ts` runs this on the machine as the
 * `lead` user and copies the lines to the Mac, where budget watch reads them.
 *
 *   bun lead-turns.ts <lead root> <since, ms since the epoch>
 *
 * Only numbers, a model name, a request id and a timestamp leave a
 * transcript. No message text, tool input or file path is printed. The
 * transcripts are the lead's to write, so the Mac checks every field again
 * (`parseTurns`) and takes nothing it does not recognise.
 *
 * A transcript writes one record per content block, and each repeats the
 * same usage, so a request is printed once, on its request id (budget watch
 * dedupes the same way). Subagent transcripts, under `<session>/subagents/`,
 * are marked, because budget watch reads a project's context size off its
 * main sessions only.
 */
import { type Stats, createReadStream, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** One billed request. Short keys: the Mac reads thousands of these over ssh. */
export interface Turn {
  /** When, in ms since the epoch. */
  t: number;
  /** The request id, or the message id when the record has none. */
  r: string;
  m: string;
  /** 1 when it came from a subagent's transcript. */
  s: 0 | 1;
  i: number;
  o: number;
  cc: number;
  cr: number;
}

export const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MODEL = /^[A-Za-z0-9._:[\]-]{1,64}$/;
/** More tokens than one request can carry; anything above is not a count. */
export const MAX_COUNT = 1e9;

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : null;

/** A transcript line's billed request, or null when it carries none. */
export function turnOf(line: string, sub: boolean): Turn | null {
  let o: {
    timestamp?: unknown;
    requestId?: unknown;
    message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> };
  };
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const u = o?.message?.usage;
  if (!u || typeof u !== 'object') return null;
  const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  const r = typeof o.requestId === 'string' ? o.requestId : o.message?.id;
  if (typeof r !== 'string' || !REQUEST_ID.test(r)) return null;
  const m =
    typeof o.message?.model === 'string' && MODEL.test(o.message.model)
      ? o.message.model
      : 'unknown';
  const i = count(u.input_tokens ?? 0);
  const out = count(u.output_tokens ?? 0);
  const cc = count(u.cache_creation_input_tokens ?? 0);
  const cr = count(u.cache_read_input_tokens ?? 0);
  if (i === null || out === null || cc === null || cr === null) return null;
  return { t, r, m, s: sub ? 1 : 0, i, o: out, cc, cr };
}

/** Every `.jsonl` under `dir` changed at or after `since`. Links are not followed. */
function transcripts(dir: string, since: number, depth = 0): string[] {
  if (depth > 4) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let st: Stats | undefined;
    try {
      st = lstatSync(path, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (!st) continue;
    if (st.isDirectory()) found.push(...transcripts(path, since, depth + 1));
    else if (st.isFile() && name.endsWith('.jsonl') && st.mtimeMs >= since) found.push(path);
  }
  return found;
}

/** The turns at or after `since` in the transcripts under `projects`, each request once. */
export async function turnsSince(projects: string, since: number): Promise<Turn[]> {
  const seen = new Set<string>();
  const turns: Turn[] = [];
  for (const file of transcripts(projects, since)) {
    const sub = file.includes('/subagents/');
    const lines = createInterface({
      input: createReadStream(file),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (!line.includes('"usage"')) continue;
      const turn = turnOf(line, sub);
      if (!turn || turn.t < since || seen.has(turn.r)) continue;
      seen.add(turn.r);
      turns.push(turn);
    }
  }
  return turns.sort((a, b) => a.t - b.t);
}

if (import.meta.main) {
  const [root, sinceArg] = process.argv.slice(2);
  const since = Number(sinceArg);
  if (!root || !Number.isFinite(since)) {
    console.error('usage: lead-turns.ts <lead root> <since ms>');
    process.exit(64);
  }
  for (const t of await turnsSince(join(root, 'claude-projects'), since)) {
    console.log(JSON.stringify(t));
  }
}
