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
import type { Task } from '@claude-workspaces/core/task-wire';

/**
 * Every key a `list_tasks` row can carry: the stored `Task`, the two the
 * route resolves on top of it (`ownerKind`, `ownerSession`, see
 * `routes/tasks-list-create.ts`), and the one this module computes
 * (`transitionCount`).
 *
 * Written down rather than derived because the check it backs is an error
 * message: a caller that asks for `goalTitle` here needs to be told that this
 * verb has no such key, and a list of what it does have is the cheapest way
 * to say so.
 *
 * A TABLE rather than an array, and the type is the point. `Record<keyof
 * Task | …, true>` is exhaustive in both directions: a field added to `Task`
 * fails to compile until it is listed here, and a name listed here that is
 * not a key of `Task` fails too. A plain `string[]` would have let a typo or
 * a removed field sit unnoticed until a caller was refused a name that is
 * real — which is the failure this whole module exists to stop, reappearing
 * in the check itself.
 */
const LIST_TASK_FIELD_TABLE: Record<
  keyof Task | 'ownerKind' | 'ownerSession' | 'transitionCount',
  true
> = {
  after: true,
  afterEnforce: true,
  answer: true,
  answerHistory: true,
  archiveReason: true,
  archivedAt: true,
  archivedBy: true,
  archivedWithGoal: true,
  artifactCheck: true,
  assignee: true,
  assigneeId: true,
  assigneeKind: true,
  body: true,
  bodyWrittenAt: true,
  createdAt: true,
  createdBy: true,
  decisionFiledBy: true,
  decisionJudge: true,
  decisionRevisions: true,
  doneWhen: true,
  dueAt: true,
  effortEstimate: true,
  externalWait: true,
  goal: true,
  id: true,
  infoRequests: true,
  kind: true,
  links: true,
  needs: true,
  notes: true,
  options: true,
  order: true,
  origin: true,
  originDocRevision: true,
  ownerKind: true,
  ownerSession: true,
  planHold: true,
  possiblyStale: true,
  quote: true,
  readingTime: true,
  recurrenceOf: true,
  reviews: true,
  schedule: true,
  status: true,
  title: true,
  titleHead: true,
  titleWrittenAt: true,
  transitionCount: true,
  transitions: true,
  triagedAgainst: true,
  unplacedSince: true,
  untitled: true,
  updatedAt: true,
  wordsRevision: true,
  workspaceId: true,
};

export const LIST_TASK_FIELDS: readonly string[] = Object.keys(LIST_TASK_FIELD_TABLE);

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
 * least one row that came back. Each half covers a different drift: the
 * declared list accepts a real key that no row on this board happens to hold
 * (`archiveReason` with nothing archived), and the row scan accepts a key the
 * server has added since this module was written.
 *
 * **The row scan is worth exactly what the result set is worth.** On an empty
 * result — a queue where everything is blocked, `list_tasks(status: 'done')`
 * on a board with none — there are no keys to widen with, so a server-added
 * field this module has not heard of IS refused, by name, though it is real.
 * That is the narrow hole, and the refusal says so rather than leaving the
 * caller to work it out: the check's verdict depends on whether there was
 * anything to check, which is the failure class this module exists to stop,
 * so it is stated aloud instead of being papered over. Accepting every name
 * on an empty result is the other direction and worse — a typo would then go
 * unreported exactly where the caller has no rows to notice it in.
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
  /** How many rows the check could scan. Zero changes what the refusal
   *  MEANS — see `unsatisfiableFields` — so it changes what it says. */
  rowsSeen = 1,
): string {
  const plural = missing.length === 1 ? 'field' : 'fields';
  const named = missing.map((m) => `\`${m}\``).join(', ');
  const because =
    rowsSeen === 0
      ? `no such key on a ${verb} row, and this call returned no rows to check it against — ` +
        'a key newer than this bundle cannot be recognised on an empty result'
      : `no such key on a ${verb} row, and no row returned carries it`;
  return `${verb} cannot return the ${plural} ${named} — ${because}. Ask for any of: ${[...known].sort().join(', ')}.`;
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
 * The drift warning without its transcript: the dates, the gap, the headline,
 * HOW MANY notes there are, and advice rewritten for a row that does not
 * carry them.
 *
 * The server's own `advice` cannot ride along, because its first sentence is
 * "read the N notes below" and a row saying that while carrying no notes is
 * exactly the answer-a-caller-cannot-tell-from-a-correct-one this projection
 * exists to stop. But its SECOND sentence is load-bearing and nothing else
 * carries it: "this says nothing about whether the task is done" is the guard
 * behind `decidePremiseDrift`'s first silence, which exists so a stale
 * premise can never be read as a finished task. So the sentence is kept
 * verbatim and only the pointer is re-aimed, at the call that really does
 * bring the notes.
 */
function summarizePremise(premise: Record<string, unknown>): Record<string, unknown> {
  const { notes, advice: _advice, ...rest } = premise;
  const count = Array.isArray(notes) ? notes.length : 0;
  return {
    ...rest,
    noteCount: count,
    advice:
      `Read the ${count} note${count === 1 ? '' : 's'} with ` +
      'next_tasks(fields: ["id","premise"]) before you reproduce what the description ' +
      'claims — they postdate it and may already have corrected it. ' +
      'This says nothing about whether the task is done.',
  };
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
