/**
 * The delay a person waits for a spoken answer, per setup — the number the
 * voice plan picks a setup by.
 *
 * Measured by the PAGE, because only the page hears both ends: the moment the
 * speaker's voice stopped (the last loud capture frame) and the moment the
 * first audible sample of the reply played. It reports that as `delayMs`,
 * with the three legs in between, and this module keeps them in three
 * places, each for a different reader:
 *
 *  - one log line per answer, `[spoken-reply] setup=N delay=…ms`, for
 *    whoever is reading the server's log while trying the setups. It ends
 *    with `note-lead=…ms` when the reply had notes: per noted point, when the
 *    note showed minus when its point's first word played (negative = early);
 *  - `<dataDir>/spoken-reply-timings.jsonl`, one row per answer, so the
 *    numbers survive a restart and can be summarised afterwards;
 *  - `summary()`, served by `GET /workspaces/<ws>/voice/timings` and shown in
 *    the reply panel's footer, so the person trying the setups on an iPad sees
 *    the median beside the switch without a terminal.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import {
  SPOKEN_SETUPS,
  type SpokenSetup,
  type SpokenTimingRow,
  type SpokenTimingSummary,
  spokenSetupKey,
} from '@claude-workspaces/core/spoken-reply';

export const SPOKEN_TIMINGS_FILE = 'spoken-reply-timings.jsonl';

export interface SpokenTimingSample {
  setup: SpokenSetup;
  delayMs: number;
  endpointMs?: number;
  replyMs?: number;
  audioMs?: number;
  /** Per noted point: note shown minus first word played, on the page. */
  noteLeadMs?: number[];
  at: number;
}

/** Keep this many answers per setup in memory; the file keeps them all. */
const KEPT_PER_SETUP = 200;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)] ?? 0;
}

export function summarize(samples: readonly SpokenTimingSample[]): SpokenTimingSummary {
  const out: SpokenTimingSummary = {};
  for (const setup of SPOKEN_SETUPS) {
    const mine = samples.filter((s) => s.setup === setup);
    const last = mine[mine.length - 1];
    if (!last) continue;
    const sorted = mine.map((s) => s.delayMs).sort((a, b) => a - b);
    const row: SpokenTimingRow = {
      n: mine.length,
      medianMs: percentile(sorted, 50),
      p90Ms: percentile(sorted, 90),
      lastMs: last.delayMs,
    };
    out[spokenSetupKey(setup)] = row;
  }
  return out;
}

export class SpokenTimings {
  private samples: SpokenTimingSample[] = [];

  /** `file` absent: memory only (tests, and a server with no data dir). */
  constructor(
    private readonly file?: string,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const s = parseSample(line);
        if (s) this.samples.push(s);
      }
      this.trim();
    }
  }

  record(sample: SpokenTimingSample): void {
    this.samples.push(sample);
    this.trim();
    const legs = [
      sample.endpointMs !== undefined ? `endpoint=${sample.endpointMs}ms` : '',
      sample.replyMs !== undefined ? `reply=${sample.replyMs}ms` : '',
      sample.audioMs !== undefined ? `audio=${sample.audioMs}ms` : '',
      sample.noteLeadMs?.length ? `note-lead=${sample.noteLeadMs.join(',')}ms` : '',
    ].filter((s) => s);
    this.log(
      `[spoken-reply] setup=${sample.setup} delay=${sample.delayMs}ms ${legs.join(' ')}`.trim(),
    );
    if (!this.file) return;
    try {
      appendFileSync(this.file, `${JSON.stringify(sample)}\n`);
    } catch {
      // A full disk loses a measurement, not the answer.
    }
  }

  summary(): SpokenTimingSummary {
    return summarize(this.samples);
  }

  private trim(): void {
    for (const setup of SPOKEN_SETUPS) {
      const mine = this.samples.filter((s) => s.setup === setup);
      if (mine.length <= KEPT_PER_SETUP) continue;
      const drop = new Set(mine.slice(0, mine.length - KEPT_PER_SETUP));
      this.samples = this.samples.filter((s) => !drop.has(s));
    }
  }
}

function parseSample(line: string): SpokenTimingSample | null {
  if (!line.trim()) return null;
  try {
    const raw = JSON.parse(line) as Partial<SpokenTimingSample>;
    if (!SPOKEN_SETUPS.includes(raw.setup as SpokenSetup)) return null;
    if (typeof raw.delayMs !== 'number' || typeof raw.at !== 'number') return null;
    return raw as SpokenTimingSample;
  } catch {
    return null;
  }
}
