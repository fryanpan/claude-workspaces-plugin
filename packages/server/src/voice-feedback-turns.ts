/**
 * The words of one voice feedback recording, as the engine revises them, and
 * which of them a note already holds.
 *
 * An engine grows each turn word by word and may rewrite a word before the
 * turn settles, so the relay cannot keep a flat transcript: it keeps every
 * turn as last reported and, per turn, the words a tick has already taken.
 * Three readings come off that:
 *
 * - `take` — the settled words no tick has had, handed to the next one;
 * - `untaken` — every word no tick has had, still-provisional ones included,
 *   which is what keeps a pause timer running;
 * - `waiting` — the words said that no note holds yet: `untaken`, plus what
 *   the tick in flight took. The page shows these under the note until the
 *   note comes back with them folded in, so words never vanish in between.
 */
import type { EngineTurn } from './transcribe.ts';
import { normWord, unusedWords } from './voice-feedback-tidy.ts';

interface Turn {
  text: string;
  final: boolean;
  settled: string;
  /** Normalised words of this turn already handed to a tick. */
  used: string[];
}

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

export class VoiceTurns {
  private readonly turns = new Map<number, Turn>();
  /** What the tick in flight took; empty when none is. */
  private taking = '';

  /** Record an engine frame. True when it is the first final frame of a turn
   *  with words — the moment the log writes what was heard. */
  update(t: EngineTurn): boolean {
    const prev = this.turns.get(t.turn);
    this.turns.set(t.turn, {
      text: t.text,
      final: t.final,
      settled: t.final ? t.text : (t.settledText ?? ''),
      used: prev?.used ?? [],
    });
    return t.final && t.text.trim() !== '' && !prev?.final;
  }

  /** The last few seconds of everything heard. */
  tail(): string {
    return [...this.turns.values()]
      .map((x) => x.text)
      .join(' ')
      .slice(-240);
  }

  /** Every word no tick has taken, in order, provisional ones included. */
  untaken(): string[] {
    const out: string[] = [];
    for (const turn of this.turns.values()) out.push(...unusedWords(words(turn.text), turn.used));
    return out;
  }

  /** Settled words no tick has taken, now marked taken and held as in flight. */
  take(): string {
    const out: string[] = [];
    for (const turn of this.turns.values()) {
      const all = words(turn.settled);
      out.push(...unusedWords(all, turn.used));
      turn.used = all.map(normWord);
    }
    this.taking = out.join(' ');
    return this.taking;
  }

  /** The tick in flight came back: its words are in a note, or dropped as filler. */
  done(): void {
    this.taking = '';
  }

  /** The words said that no note holds yet. */
  waiting(): string {
    return [this.taking, ...this.untaken()].filter(Boolean).join(' ');
  }
}
