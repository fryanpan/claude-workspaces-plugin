/**
 * Did the merged conversations survive?
 *
 * The migration copies a loser's threads into the winner and leaves the
 * loser's `.ydoc` untouched, which is what makes the run reversible — and it
 * is also what makes this check possible after the fact. Every thread id in a
 * loser is a thread id the winner must now hold. The losers are the expected
 * answer, still on disk, written by nobody since.
 *
 * It exists because a write can be lost AFTER a successful run: a server
 * still finishing its shutdown flush, an editor, a restore from a backup.
 * The run's own parity assertion cannot see any of those, because they happen
 * when it is over.
 *
 * Read-only, and deliberately so: nothing here opens the registry, writes the
 * journal, or touches a `.ydoc`. It is safe to run against a live data
 * directory with the server up.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listThreads } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { readJournal } from './doc-identity-journal.ts';

export interface WinnerCheck {
  winner: string;
  losers: number;
  /** Distinct thread ids across the losers: what the winner must hold. */
  expected: number;
  present: number;
  /** Ids the winner does not hold. Ids, never text. */
  missing: string[];
  /** A `.ydoc` this check could not open. Nothing can be concluded from it. */
  unreadable: string[];
}

export interface CheckResult {
  runs: number;
  winners: WinnerCheck[];
  expected: number;
  present: number;
  ok: boolean;
}

function threadIds(dataDir: string, docId: string): string[] | null {
  const path = join(dataDir, `${docId}.ydoc`);
  if (!existsSync(path)) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(readFileSync(path)));
  } catch {
    return null;
  }
  return listThreads(doc).map((t) => t.id);
}

/**
 * Walk every merge the journal recorded and compare each winner against the
 * losers it was merged from.
 *
 * A `.ydoc` that cannot be opened is reported as unreadable rather than as a
 * missing thread: an absent loser proves nothing about the winner, and an
 * absent winner is a far louder failure than a count.
 */
export function checkMerges(dataDir: string): CheckResult {
  const journal = readJournal(dataDir);
  const winners: WinnerCheck[] = [];
  for (const run of journal.runs) {
    for (const merge of run.merges) {
      const held = threadIds(dataDir, merge.winner);
      const unreadable: string[] = [];
      if (held === null) unreadable.push(merge.winner);
      const wanted = new Set<string>();
      for (const loser of merge.losers) {
        const ids = threadIds(dataDir, loser);
        if (ids === null) {
          unreadable.push(loser);
          continue;
        }
        for (const id of ids) wanted.add(id);
      }
      const has = new Set(held ?? []);
      const missing = [...wanted].filter((id) => !has.has(id));
      winners.push({
        winner: merge.winner,
        losers: merge.losers.length,
        expected: wanted.size,
        present: wanted.size - missing.length,
        missing,
        unreadable,
      });
    }
  }
  const expected = winners.reduce((n, w) => n + w.expected, 0);
  const present = winners.reduce((n, w) => n + w.present, 0);
  return {
    runs: journal.runs.length,
    winners,
    expected,
    present,
    ok: present === expected && winners.every((w) => w.unreadable.length === 0),
  };
}

/** The report, one line per winner and a total. Ids and counts, never text. */
export function checkLines(res: CheckResult): string[] {
  const out = [`${res.winners.length} merged winner(s) across ${res.runs} run(s).`, ''];
  for (const w of res.winners) {
    const flag = w.missing.length > 0 ? '  MISSING' : '';
    out.push(
      `  ${w.winner}  from ${w.losers} loser(s)  expected ${w.expected}  present ${w.present}${flag}`,
    );
    if (w.missing.length > 0) out.push(`      missing thread ids: ${w.missing.join(' ')}`);
    if (w.unreadable.length > 0) out.push(`      unreadable .ydoc: ${w.unreadable.join(' ')}`);
  }
  out.push('');
  out.push(`  threads expected  ${res.expected}`);
  out.push(`  threads present   ${res.present}`);
  out.push(
    res.ok ? '\nEvery merged conversation is where the run put it.' : '\nFAILED — see above.',
  );
  return out;
}
