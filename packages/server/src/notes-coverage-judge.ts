/**
 * The model's reading of what a finished meeting's notes left out, taken
 * once, when the meeting is over and before its quality item is filed.
 *
 * WHY A MODEL AND NOT THE LEXICAL CHECK. `notes-quality-coverage.ts` asks
 * whether a sentence's content words appear anywhere in the notes, and on
 * four replayed meetings it read 0-3% uncovered while a judge reading the
 * same notes found 11-24% of the ideas missing. Matching against one bullet
 * instead of the whole notes did not help: a model-written list of the
 * meeting's ideas scored WORSE than the notes it was judged against, so the
 * words a note shares with a sentence do not say whether the note carries
 * it. The board's goal for a meeting is that a meeting losing more than one
 * idea in twenty is reported, and only a reading of the meaning can tell.
 *
 * ONCE PER MEETING. It runs at the filer's commit (`notes-quality-filing.ts`)
 * — after the last leg, when the item is about to be filed or withdrawn —
 * never per leg, so a meeting with twenty reconnects pays for one reading.
 *
 * WHAT IT COSTS. One Haiku call per stretch of about 3,000 characters of
 * speech, each reading the whole notes from the prompt cache. An hour-long
 * meeting is about twenty calls.
 *
 * WHAT IT CANNOT DO. The model lists the points and judges them in one call,
 * so its count of points is its own and is not the eval's fixed ground
 * truth. The number is a reading for THIS meeting, good enough to say a
 * meeting lost ideas and to put the share on the item; the rate to trust
 * across meetings is still `bun run notes:eval`'s.
 */

import { readRenamedEnv } from '@claude-workspaces/core/env-names';
import type { NotesCoverage, SpokenTurn } from './notes-quality-coverage.ts';
import type { NotesQualityFlag, NotesQualityReport } from './notes-quality-report.ts';
import { GOAL_LOST_IDEA_SHARE, MIN_IDEAS_FOR_COVERAGE } from './notes-quality-thresholds.ts';
import { fixedHostFetch } from './outbound-fetch.ts';
import { readKeychainPassword } from './share/keychain.ts';
import { HAIKU_NO_THINKING, resolveKeySlotFrom } from './summarize.ts';

export const COVERAGE_JUDGE_MODEL = 'claude-haiku-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
/** The most characters of speech one call reads. */
export const COVERAGE_WINDOW_CHARS = 3_000;
/** Calls in flight at once. */
const CONCURRENCY = 4;
const TIMEOUT_MS = 60_000;

/** What the model found: the points the speech made, and how many no note
 *  carries. Counted over the stretches that were judged. */
export interface CoverageJudgement {
  ideas: number;
  lost: number;
  /** Stretches of speech read, and how many of them came back judged. */
  windows: number;
  judgedWindows: number;
}

export type NotesCoverageJudge = (input: {
  transcript: readonly SpokenTurn[];
  notes: string;
}) => Promise<CoverageJudgement | null>;

export const COVERAGE_JUDGE_SYSTEM = [
  'You check the notes of a meeting against one stretch of what was said in it.',
  '',
  'First list every separate point THE SPEECH makes: a fact, a status, a plan,',
  'a decision, a request, a question somebody asked, a reason, a number, a',
  'name. Skip greetings, thanks, filler and talk about the call itself.',
  '',
  'Then, for each point, say whether THE NOTES carry it — in any words,',
  'anywhere in the notes, however short. A note about the same topic that does',
  'not say this particular thing does not carry it. A note that gets the',
  'specifics wrong (who, which thing, the number, done or not done) does not',
  'carry it.',
  '',
  'Answer with the record_points tool.',
].join('\n');

const TOOL = {
  name: 'record_points',
  description: 'Record each point the speech makes and whether the notes carry it.',
  input_schema: {
    type: 'object' as const,
    properties: {
      points: {
        type: 'array',
        items: {
          type: 'object',
          properties: { point: { type: 'string' }, carried: { type: 'boolean' } },
          required: ['point', 'carried'],
        },
      },
    },
    required: ['points'],
  },
};

/** The speech in stretches of at most `max` characters, one line per turn.
 *  A turn longer than a stretch is a stretch of its own. */
export function coverageWindows(
  turns: readonly SpokenTurn[],
  max: number = COVERAGE_WINDOW_CHARS,
): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const t of turns) {
    const text = t.text.trim();
    if (text.length === 0) continue;
    const line = `${t.speaker ?? 'Speaker'}: ${text}`;
    if (cur.length > 0 && chars + line.length > max) {
      out.push(cur.join('\n'));
      cur = [];
      chars = 0;
    }
    cur.push(line);
    chars += line.length;
  }
  if (cur.length > 0) out.push(cur.join('\n'));
  return out;
}

/** The tool's answer, or null when it is not one. A row without a boolean
 *  verdict makes the whole answer unreadable: a missing verdict is not a no. */
export function parseCoverageAnswer(input: unknown): { ideas: number; lost: number } | null {
  const points = (input as { points?: unknown } | null)?.points;
  if (!Array.isArray(points)) return null;
  let lost = 0;
  for (const row of points as Array<{ carried?: unknown }>) {
    if (typeof row?.carried !== 'boolean') return null;
    if (!row.carried) lost++;
  }
  return { ideas: points.length, lost };
}

export interface CoverageJudgeDeps {
  apiKey: string;
  fetchImpl?: typeof fetch;
  onError?: (message: string) => void;
}

/** A judge on the given key. */
export function createCoverageJudge(deps: CoverageJudgeDeps): NotesCoverageJudge {
  const fetchImpl = deps.fetchImpl ?? fixedHostFetch;
  const judgeOne = async (
    notes: string,
    speech: string,
  ): Promise<{ ideas: number; lost: number } | null> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': deps.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: COVERAGE_JUDGE_MODEL,
          max_tokens: 3_000,
          thinking: HAIKU_NO_THINKING,
          system: COVERAGE_JUDGE_SYSTEM,
          tools: [TOOL],
          tool_choice: { type: 'tool', name: TOOL.name },
          messages: [
            {
              role: 'user',
              content: [
                // The notes are the same in every call, so they are read from
                // the cache after the first.
                {
                  type: 'text',
                  text: `THE NOTES:\n${notes || '(the notes are empty)'}`,
                  cache_control: { type: 'ephemeral' },
                },
                { type: 'text', text: `THE SPEECH:\n${speech}` },
              ],
            },
          ],
        }),
        signal: ctl.signal,
      });
      // The status only. A body can echo the prompt, and the prompt is speech.
      if (!res.ok) {
        deps.onError?.(`notes coverage judge returned HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as {
        content?: Array<{ type?: string; name?: string; input?: unknown }>;
      };
      const call = body.content?.find((b) => b.type === 'tool_use' && b.name === TOOL.name);
      return parseCoverageAnswer(call?.input);
    } catch (err) {
      deps.onError?.(
        `notes coverage judge failed: ${err instanceof Error ? err.message : 'error'}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  return async ({ transcript, notes }) => {
    const windows = coverageWindows(transcript);
    if (windows.length === 0) return null;
    const answers: Array<{ ideas: number; lost: number } | null> = new Array(windows.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < windows.length) {
        const i = next++;
        answers[i] = await judgeOne(notes, windows[i] as string);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, windows.length) }, worker));
    const judged = answers.filter((a): a is { ideas: number; lost: number } => a !== null);
    // Half the meeting unread is not a reading of the meeting.
    if (judged.length * 2 < windows.length) return null;
    return {
      ideas: judged.reduce((n, a) => n + a.ideas, 0),
      lost: judged.reduce((n, a) => n + a.lost, 0),
      windows: windows.length,
      judgedWindows: judged.length,
    };
  };
}

/** Is the judge switched on? `CW_NOTES_COVERAGE_JUDGE=0` is the kill switch. */
export function coverageJudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readRenamedEnv(env, 'CW_NOTES_COVERAGE_JUDGE') !== '0';
}

/** The real judge, or `null` when there is no key or the judge is off. */
export function haikuCoverageJudge(
  opts: { apiKey?: string | null; fetchImpl?: typeof fetch } = {},
): NotesCoverageJudge | null {
  if (!coverageJudgeEnabled()) return null;
  const resolved = resolveKeySlotFrom('meeting-notes-coverage', opts.apiKey, readKeychainPassword);
  if (!resolved) return null;
  return createCoverageJudge({
    apiKey: resolved.key,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    onError: (m) => console.error(`[meeting-notes] ${m}`),
  });
}

/**
 * The report with the model's reading in place of the lexical one.
 *
 * The coverage numbers become the judged ones, and the `coverage` flag is
 * raised when the share reaches the goal's bar and dropped when it does not
 * — the lexical flag says nothing the judged one does not say better. A
 * report whose notes could not be read is returned as it is: there was
 * nothing to judge.
 */
export function withJudgedCoverage(
  report: NotesQualityReport,
  judged: CoverageJudgement,
): NotesQualityReport {
  if (report.coverage.source === 'unreadable') return report;
  const share = judged.ideas >= MIN_IDEAS_FOR_COVERAGE ? judged.lost / judged.ideas : null;
  const coverage: NotesCoverage = {
    source: 'notes',
    ideas: judged.ideas,
    uncoveredIdeas: judged.lost,
    uncoveredShare: share,
  };
  const flags: NotesQualityFlag[] = report.flags.filter((f) => f.kind !== 'coverage');
  if (share !== null && share >= GOAL_LOST_IDEA_SHARE) {
    flags.push({
      kind: 'coverage',
      text: `${Math.round(share * 100)}% of what was said reached no note (${judged.lost} of ${judged.ideas} points, read by a model)`,
    });
  }
  return { ...report, coverage, flags };
}
