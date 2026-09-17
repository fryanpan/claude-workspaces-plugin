/**
 * Row projection for the two board reads — `list_tasks` and `next_tasks` —
 * MCP-handler-side only, on purpose.
 *
 * A real board's `list_tasks` came back at 122KB because every row hauled
 * reviews (quotes and answers), infoRequests, options, and evidence whether
 * or not the caller wanted them — enough to overflow a tool-result cap.
 * The REST route is deliberately untouched: an old bundle keeps calling it
 * forever and must keep reading the same shape. The trim happens here, in
 * the layer that ships WITH the caller.
 *
 * `next_tasks` had the same disease and none of the cure: it returned the
 * queue rows verbatim — every body, and every note of every drifting row's
 * discussion — and it ACCEPTED a `fields` argument it never declared, so a
 * caller that asked for three keys got the whole board and no word about it.
 * Both verbs project here now, and both refuse a field name they cannot
 * satisfy rather than dropping it in silence. A dropped field and a field
 * the row genuinely lacks are indistinguishable to the caller, which is the
 * same shape as a check that reports passed when it could not run.
 */

/**
 * Every key a `list_tasks` row can carry: the stored `Task` (see
 * `@claude-workspaces/core/task-wire`), the two the route resolves on top of
 * it (`ownerKind`, `ownerSession`), and the one this module computes
 * (`transitionCount`).
 *
 * Written down rather than derived because the check it backs is an error
 * message: a caller that asks for `goalTitle` here needs to be told that this
 * verb has no such key, and a list of what it does have is the cheapest way
 * to say so. Kept honest by `unsatisfiableFields` widening to the keys the
 * rows actually carry, so a field the server adds tomorrow is accepted today.
 */
export const LIST_TASK_FIELDS: readonly string[] = [
  'after',
  'afterEnforce',
  'answer',
  'answerHistory',
  'archiveReason',
  'archivedAt',
  'archivedBy',
  'archivedWithGoal',
  'artifactCheck',
  'assignee',
  'assigneeId',
  'assigneeKind',
  'body',
  'bodyWrittenAt',
  'createdAt',
  'createdBy',
  'decisionFiledBy',
  'decisionJudge',
  'decisionRevisions',
  'doneWhen',
  'dueAt',
  'effortEstimate',
  'externalWait',
  'goal',
  'id',
  'infoRequests',
  'kind',
  'links',
  'needs',
  'notes',
  'options',
  'order',
  'origin',
  'originDocRevision',
  'ownerKind',
  'ownerSession',
  'planHold',
  'possiblyStale',
  'quote',
  'readingTime',
  'recurrenceOf',
  'reviews',
  'schedule',
  'status',
  'title',
  'titleHead',
  'titleWrittenAt',
  'transitionCount',
  'transitions',
  'triagedAgainst',
  'unplacedSince',
  'untitled',
  'updatedAt',
  'wordsRevision',
  'workspaceId',
];

/**
 * Every key a `next_tasks` row can carry: the queue row `buildQueue` returns,
 * plus the two presence fields `/workspaces/<id>/next` resolves on top of it.
 *
 * Deliberately NOT the same vocabulary as `LIST_TASK_FIELDS`. The queue row
 * is a different object — it carries `goalTitle`, `ready` and `blocked`,
 * which a stored task knows nothing about, and it carries none of the review
 * machinery. A caller asking `next_tasks` for `reviews` is asking the wrong
 * verb, and being told so is the point.
 */
export const NEXT_TASK_FIELDS: readonly string[] = [
  'assignee',
  'assigneeId',
  'blocked',
  'blockedBy',
  'body',
  'bodyWrittenAt',
  'claimedBy',
  'goal',
  'goalInTriage',
  'goalTitle',
  'id',
  'inGoalBand',
  'needs',
  'ownerSession',
  'premise',
  'ready',
  'status',
  'title',
];

/**
 * The `fields` entries this verb cannot answer, in the order the caller gave
 * them — empty when every entry is satisfiable.
 *
 * Satisfiable means EITHER declared in the vocabulary above OR present on at
 * least one row that came back. The union is what makes the check safe in
 * both directions: a key the server adds and this module has not heard of
 * still arrives (the rows carry it), and a declared key that no row on this
 * particular board happens to hold — `archiveReason` with nothing archived —
 * is still accepted rather than reported as a mistake.
 */
export function unsatisfiableFields(
  fields: readonly string[],
  known: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const vocabulary = new Set(known);
  for (const row of rows) for (const key of Object.keys(row)) vocabulary.add(key);
  const missing: string[] = [];
  for (const field of fields) {
    if (!vocabulary.has(field) && !missing.includes(field)) missing.push(field);
  }
  return missing;
}

/**
 * The sentence a caller gets instead of a quietly incomplete row. It names
 * the entries that could not be answered FIRST, because that is what the
 * caller has to change, and then the whole vocabulary, because the usual
 * cause is asking one verb for the other verb's key.
 */
export function unknownFieldsMessage(
  verb: string,
  missing: readonly string[],
  known: readonly string[],
): string {
  const plural = missing.length === 1 ? 'field' : 'fields';
  return (
    `${verb} cannot return the ${plural} ${missing.map((m) => `\`${m}\``).join(', ')} — ` +
    `no such key on a ${verb} row, and no row returned carries it. ` +
    `Ask for any of: ${[...known].sort().join(', ')}.`
  );
}

/**
 * With no `fields` (or an empty list), the historical default: drop `body`
 * and `transitions`, keep everything else, add `transitionCount`. With
 * `fields`, each row carries exactly the picked keys — `id` always included
 * so a row stays addressable, keys the row lacks omitted rather than null.
 * `transitionCount` is computed on demand, and an explicit pick of a heavy
 * field (even `body`) is honored: projection filters, it does not censor.
 *
 * Generic rather than an indexed type: the caller's row type (TaskPayload)
 * is a plain interface with no index signature.
 */
export function projectTaskRows<T extends { transitions?: unknown[] }>(
  tasks: T[],
  fields?: string[],
): Array<Record<string, unknown>> {
  const rows = tasks as Array<T & Record<string, unknown>>;
  if (!fields || fields.length === 0) {
    return rows.map(({ body: _body, transitions, ...rest }) => ({
      ...rest,
      transitionCount: transitions?.length ?? 0,
    }));
  }
  const picked = new Set(['id', ...fields]);
  return rows.map((t) => {
    const row: Record<string, unknown> = {};
    for (const key of picked) {
      if (key === 'transitionCount') {
        row.transitionCount = t.transitions?.length ?? 0;
      } else if (key in t) {
        row[key] = t[key];
      }
    }
    return row;
  });
}

/**
 * What a `next_tasks` row carries when the caller names no fields: enough to
 * PICK with, and nothing that has to be read to pick.
 *
 * The queue answers "what should I do next", so the default is the picker's
 * shape — which row, whose it is, which band, whether it is ready, and who is
 * already on it. What it leaves out is the two fields that carry text a
 * picker does not read until it has chosen: `body`, and the verbatim
 * discussion inside `premise`. Both come back when asked for by name.
 */
const NEXT_DEFAULT_KEYS: readonly string[] = [
  'id',
  'title',
  'status',
  'assignee',
  'assigneeId',
  'needs',
  'goal',
  'goalTitle',
  'inGoalBand',
  'goalInTriage',
  'ready',
  'blocked',
  'blockedBy',
  'bodyWrittenAt',
  'ownerSession',
  'claimedBy',
];

/**
 * The drift warning without its transcript: the dates, the gap, the headline
 * and HOW MANY notes there are.
 *
 * `advice` is dropped along with the notes on purpose. The server writes it
 * as "read the N notes below", and a row saying that while carrying no notes
 * is exactly the answer-a-caller-cannot-tell-from-a-correct-one this
 * projection exists to stop. `noteCount` states the same fact without
 * pointing at content that is not there, and the tool description says which
 * call brings the notes themselves.
 */
function summarizePremise(premise: Record<string, unknown>): Record<string, unknown> {
  const { notes, advice: _advice, ...rest } = premise;
  return { ...rest, noteCount: Array.isArray(notes) ? notes.length : 0 };
}

/**
 * The `next_tasks` half. Same contract as `projectTaskRows` — `id` always
 * included, an explicit pick honored verbatim — over a different default and
 * a different vocabulary.
 *
 * An explicit `fields` gets the RAW value, `premise` included: projection
 * filters, it does not censor, so a caller that wants the discussion asks for
 * it by name and gets every note.
 */
export function projectQueueRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  fields?: string[],
): Array<Record<string, unknown>> {
  const isDefault = !fields || fields.length === 0;
  const picked = isDefault ? new Set(NEXT_DEFAULT_KEYS) : new Set(['id', ...fields]);
  return rows.map((t) => {
    const row: Record<string, unknown> = {};
    for (const key of picked) {
      if (key in t) row[key] = t[key];
    }
    // Present only on a row whose description has stood still while the task
    // was discussed, so it is absent from most rows and nothing here fires.
    if (isDefault && typeof t.premise === 'object' && t.premise !== null) {
      row.premise = summarizePremise(t.premise as Record<string, unknown>);
    }
    return row;
  });
}
