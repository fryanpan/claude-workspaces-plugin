/**
 * What a tidy-up did, in the words a person reads.
 *
 * WHY IT IS HERE AND NOT IN THE DIALOG. Three surfaces answer the same
 * question about one pass — the offer dialog a person is looking at when a
 * recording stops, the rerun harness's report file, and the server's own log
 * line — and on 2026-09-15 the first of them said nothing at all: sixteen
 * edits proposed, sixteen refused, and a dialog that closed over unchanged
 * notes. PR 1034 gave the pass a REASON per dropped edit. This is the half a
 * person reads, written once so the dialog and the report cannot drift into
 * saying different things about the same reply.
 *
 * WHAT IT REFUSES TO DO. It never invents a verdict the reply did not carry.
 * A reply from a server that predates a field is read the old way — see
 * `changed` — because a missing field is not a claim.
 *
 * THE FOUR OUTCOMES ARE FOUR, NOT TWO. "Nothing changed" is the same sentence
 * for a pass that found the notes already good, a pass whose every edit was
 * out of reach, and a pass whose model call never answered; they are
 * different news and they need different things from the reader, so each gets
 * its own kind, its own headline and its own recovery line.
 */

/** The cleanup route's reply, as a hostile reader sees it: every field may be
 *  missing, because a server may predate any of them. */
export interface NotesCleanupReply {
  ok?: boolean;
  /** The server's own sum over every kind of change one pass can make.
   *  Absent from an older server, and absence is read as "it does not say". */
  changed?: boolean;
  /** Why a pass never got as far as composing — `compose-failed`,
   *  `no-composer`, `recording`, … */
  reason?: string;
  error?: string;
  proposed?: number;
  refused?: number;
  /** One line per dropped edit, `"<op> <id>: <rule>"`. */
  refusals?: readonly string[];
  failed?: number;
  /** One line per kept edit that did not land, `"<op>: <reason>"`. */
  failures?: readonly string[];
}

/**
 * Which of the four happened.
 *
 * `changed` is the only one with a receipt of its own — the notes behind the
 * dialog moved — so it is the only one that needs no words here.
 */
export type NotesCleanupOutcomeKind =
  | 'changed'
  | 'nothing-to-change'
  | 'nothing-landed'
  | 'could-not-run';

/** One rule, and how many edits it dropped. Block ids are deliberately not
 *  here: the rule is the part a person can act on, and sixteen ids are
 *  sixteen things to read past on the way to it. */
export interface NotesCleanupReasonGroup {
  rule: string;
  count: number;
}

export interface NotesCleanupReport {
  kind: NotesCleanupOutcomeKind;
  /** One sentence, said first. */
  headline: string;
  /** Why, grouped by rule, commonest first. Empty when the reply carried no
   *  per-edit reason — an older server, or a pass that dropped nothing. */
  reasons: NotesCleanupReasonGroup[];
  /** What the person can do, or what will happen on its own. Empty ONLY for
   *  an outcome where there is genuinely nothing to do. */
  recovery: string;
  /**
   * Whether running the pass again could plausibly answer differently.
   *
   * THE MACHINE-READABLE HALF OF THE RECOVERY LINE, so a surface can put the
   * answer in the control rather than in a sentence about the control — the
   * offer's button reads "Try again" on a pass worth repeating and stays
   * "Tidy up" on one that will answer the same way for ever. A recovery line
   * therefore never names a button; the button names itself.
   */
  retry: boolean;
}

/** What a pass that never composed says, and what to do about it. Keyed on
 *  the route's own `reason`, so a reason this build has never heard of falls
 *  through to the generic pair below rather than being rendered as a code. */
const REFUSAL_WORDS: Record<string, { headline: string; recovery: string; retry: boolean }> = {
  'compose-failed': {
    headline: 'The tidy-up could not run — the model did not answer.',
    recovery: 'The notes are unchanged, and nothing runs it again on its own.',
    retry: true,
  },
  'no-composer': {
    headline: 'The tidy-up could not run — this server has no model key configured.',
    recovery: 'The notes are unchanged, and it will answer the same way until a key is set.',
    retry: false,
  },
  recording: {
    headline: 'The tidy-up could not run — a recording is going on this doc.',
    recovery: 'The notes are unchanged. Stop the recording, and it can run.',
    retry: true,
  },
  'no-section': {
    headline: 'The tidy-up could not run — this meeting has no notes section to read.',
    recovery: 'The notes are unchanged, and there is nothing to retry on this meeting.',
    retry: false,
  },
  'no-transcript': {
    headline: 'The tidy-up could not run — this meeting left no transcript.',
    recovery: 'The notes are unchanged, and there is nothing to retry on this meeting.',
    retry: false,
  },
  'transcript-too-long': {
    headline: 'The tidy-up could not run — this meeting is longer than one pass carries.',
    recovery: 'The notes are unchanged, and there is nothing to retry on this meeting.',
    retry: false,
  },
  'no-doc': {
    headline: 'The tidy-up could not run — the document is no longer here.',
    recovery: 'The notes are unchanged, and there is nothing to retry on this meeting.',
    retry: false,
  },
};

const GENERIC_FAILURE = {
  headline: 'The tidy-up could not run.',
  recovery: 'The notes are unchanged, and nothing runs it again on its own.',
  retry: true,
};

/**
 * What to do about the rule that dropped the most edits.
 *
 * Only the rules a PERSON can act on are here. Everything else is the model
 * having addressed a block it should not have, which is nothing the reader
 * did and nothing they can fix — those get the generic line, which at least
 * says the notes are untouched and that pressing again is allowed.
 */
const RECOVERY_BY_RULE: ReadonlyArray<{ match: string; recovery: string }> = [
  {
    match: 'somebody has commented on the block',
    recovery:
      'Those notes are under discussion, so the tidy-up left them alone. Resolve the threads on them and run it again.',
  },
  {
    match: 'the document does not record the block as the note-taker',
    recovery:
      'Those notes are not recorded as the note-taker’s own, so it may not rewrite them. Editing them yourself is the way to change them.',
  },
  {
    match: 'the block is not in the document',
    recovery:
      'The notes moved while the tidy-up was reading them. Running it again reads them as they now stand.',
  },
];

const NOTHING_LANDED_FALLBACK = 'The notes are unchanged, and nothing changes them on its own.';

/**
 * Split `"<op> <id>: <rule>"` — and `"<op>: <reason>"`, which the failures
 * carry — into the rule alone, on the FIRST colon-space only. The rules
 * themselves hold no colon, and splitting on the last one would cut a reason
 * that does.
 */
function ruleOf(line: string): string {
  const at = line.indexOf(': ');
  return at === -1 ? line.trim() : line.slice(at + 2).trim();
}

/**
 * Group dropped-edit lines by their rule, commonest first.
 *
 * Ties break alphabetically rather than by arrival, so two runs over the same
 * pass render the same list and a screenshot of one is a reading of the
 * other.
 */
export function groupCleanupReasons(
  lines: readonly string[] | undefined,
): NotesCleanupReasonGroup[] {
  const counts = new Map<string, number>();
  for (const line of lines ?? []) {
    const rule = ruleOf(line);
    if (rule.length === 0) continue;
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return [...counts]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

/** The recovery line for a set of dropped edits: the biggest group's, when
 *  that group names something a person can do; the generic one otherwise. */
function recoveryFor(groups: readonly NotesCleanupReasonGroup[]): string {
  const top = groups[0];
  if (top === undefined) return NOTHING_LANDED_FALLBACK;
  return (
    RECOVERY_BY_RULE.find((r) => top.rule.includes(r.match))?.recovery ?? NOTHING_LANDED_FALLBACK
  );
}

/**
 * Read one reply into the four outcomes, with words for each.
 *
 * The order of the tests is the order of the questions: did it run at all,
 * did the document move, and only then which of the two nothings it was.
 */
export function readCleanupReply(reply: NotesCleanupReply): NotesCleanupReport {
  if (reply.ok !== true) {
    // A sentence the server wrote outranks anything chosen here — it is the
    // one that knows the specifics, and the reason codes below are the
    // fallback for a refusal that carries none.
    const words =
      (reply.reason !== undefined ? REFUSAL_WORDS[reply.reason] : undefined) ?? GENERIC_FAILURE;
    return {
      kind: 'could-not-run',
      headline: reply.error ?? words.headline,
      reasons: groupCleanupReasons(reply.refusals),
      recovery: words.recovery,
      retry: words.retry,
    };
  }
  // ONLY AN EXPLICIT `false` IS A CLAIM THAT NOTHING MOVED. A server that
  // predates the field says nothing, and nothing is not "it changed nothing".
  if (reply.changed !== false) {
    return { kind: 'changed', headline: '', reasons: [], recovery: '', retry: false };
  }
  const dropped = groupCleanupReasons([...(reply.refusals ?? []), ...(reply.failures ?? [])]);
  // TRIED AND COULD NOT, versus READ IT AND FOUND IT FINISHED. `proposed` is
  // what tells them apart: a pass that proposed nothing had nothing to be
  // refused.
  if ((reply.proposed ?? 0) > 0) {
    return {
      kind: 'nothing-landed',
      headline: 'Nothing changed — none of these edits could be made to the notes.',
      reasons: dropped,
      recovery: recoveryFor(dropped),
      // ALWAYS WORTH ANOTHER PRESS. Every rule that drops an edit is a fact
      // about the document as it stood, and the document is live: a thread
      // resolved, a bullet moved back, a line the person edited themselves
      // all change the answer.
      retry: true,
    };
  }
  return {
    kind: 'nothing-to-change',
    headline: 'Nothing changed — the tidy-up read the whole meeting and found nothing to improve.',
    reasons: [],
    // Genuinely nothing to do, and inventing a step here would turn a
    // success into a chore.
    recovery: '',
    retry: false,
  };
}

/** One group as a line: "12 edits — <rule>". The count leads because it is
 *  what a reader scans; the singular is worth the branch. */
export function cleanupReasonLine(group: NotesCleanupReasonGroup): string {
  return `${group.count} ${group.count === 1 ? 'edit' : 'edits'} — ${group.rule}`;
}
