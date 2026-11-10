/**
 * Reading Soniox's token batches: one token off the wire, a speaker's number
 * as the letter the product speaks, and a turn's language from its words'
 * tags. Split from `transcribe-soniox.ts`, which assembles the turns.
 */

/**
 * Soniox numbers its speakers ("1", "2"); the rest of the product — the
 * rename UI, the roster, the record — speaks AssemblyAI's letters ("A",
 * "B"). One deterministic map so a turn's speaker means the same thing
 * whichever engine labelled it; a label past "Z" or non-numeric passes
 * through untouched rather than being invented around.
 */
export function speakerLetter(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= 26) return String.fromCharCode(64 + n);
  return s;
}

/** The language most final words were tagged; the first on a tie. */
export function mostTagged(counts: Map<string, number>): string | undefined {
  let best: [string, number] | undefined;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  return best?.[0];
}

/** One token as the wire carries it, reduced to what this adapter reads. */
export interface SonioxToken {
  text: string;
  isFinal: boolean;
  speaker?: string;
  endMs?: number;
  language?: string;
}

export function readToken(raw: unknown): SonioxToken | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.text !== 'string') return null;
  const endMs = typeof t.end_ms === 'number' && Number.isFinite(t.end_ms) ? t.end_ms : undefined;
  return {
    text: t.text,
    isFinal: t.is_final === true,
    ...(speakerLetter(t.speaker) !== undefined ? { speaker: speakerLetter(t.speaker) } : {}),
    ...(endMs !== undefined ? { endMs } : {}),
    ...(typeof t.language === 'string' && t.language ? { language: t.language } : {}),
  };
}
