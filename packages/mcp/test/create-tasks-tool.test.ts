/**
 * `create_tasks` is the canonical create, and what it learned reaches peers.
 *
 * Two things this guards, both of which have gone wrong here before:
 *
 *  - **The bundle.** `.mcp.json` loads the committed
 *    `packages/plugin/mcp/index.js`, not the source. A description edited in
 *    `mcp.ts` and never rebuilt is invisible to every peer — which is exactly
 *    how PR #69 shipped a schema change nobody received. A tool description IS
 *    the deliverable when the change is "steer the agent to the other verb":
 *    there is no behaviour to notice, so nothing else would report the miss.
 *  - **The forwarding.** The server routes are covered end to end
 *    (task-placement.test.ts), but nothing yet checked that the MCP handler
 *    passes `placement` on rather than dropping it — the same "one layer away
 *    from where it's consumed" failure as a route that accepts a param and
 *    discards it.
 *
 * Both were read out of files: a slice of `mcp.ts`, and
 * `BUNDLE.toContain('placement')` over the built artifact. The bundle half was
 * the weakest assertion in this package — the word `placement` is in that file
 * whether or not a single row is ever marked placed. The harness runs the
 * committed bundle as a real MCP server against a recording stub, so the
 * declaration is what a client is handed and the forwarding is what comes back
 * out of a real call. All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, type Recorded, startBundle } from './harness/mcp-bundle.ts';

/**
 * The batch route's answer: two rows, one of them placed in a goal band and
 * one left out of every band.
 */
const batchReply = {
  tasks: [
    { id: 't-1', title: 'Ship the search revamp', status: 'todo', goal: 'g-1' },
    { id: 't-2', title: 'Rename the export button', status: 'todo' },
  ],
  failures: [],
  placement: { unplaced: ['t-2'], goals: [{ id: 'g-1', title: 'Faster review loop' }] },
};

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle((req: Recorded) => (req.path.endsWith('/tasks/batch') ? batchReply : {}));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

const createTwo = () =>
  mcp.call('create_tasks', {
    workspaceId: 'w-1',
    tasks: [
      { title: 'Ship the search revamp', goal: 'g-1' },
      { title: 'Rename the export button' },
    ],
  });

describe('create_tasks is the canonical create verb', () => {
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_agents')).toBeDefined();
    expect(mcp.tool('create_tasks_batch')).toBeUndefined();
  });

  it('says so in its own description, and says a single task is a one-row list', () => {
    // The steering has to be in the description, because the description is
    // the only thing an agent reads at the moment it is about to file work.
    const desc = mcp.tool('create_tasks')?.description ?? '';
    expect(desc).toContain('the only create verb');
    expect(desc).toContain('one-item list');
  });

  it('carries the per-row field contract on its own schema', () => {
    // The single-row `create_task` declaration used to hold every field
    // description, and `tasks` merely pointed at it ("a create_task body
    // without workspaceId"). Deleting that tool without moving these would
    // have left a schema that still validates and documents nothing — the kind
    // of regression no assertion about the deleted tool can catch.
    const schema = JSON.stringify(mcp.tool('create_tasks')?.inputSchema ?? {});
    expect(schema).toContain('<persona> can <do x> so that <goal y>'); // the body rule
    expect(schema).toContain("bare word 'agent'"); // the owner refusal
    expect(schema).toMatch(/decision-shaped `body`|REQUIRED and has a different shape/);
    expect(schema).toContain('must also appear in `after`'); // the afterEnforce subset rule
  });

  it('documents the batch-local dependency reference on the row schema', () => {
    const schema = JSON.stringify(mcp.tool('create_tasks')?.inputSchema ?? {});
    expect(schema).toContain('`key` labels a task'); // the field that makes a reference possible
    expect(schema).toContain('#seed'); // the spelling
    expect(schema).toContain('depend on one above it'); // and the direction rule
  });
});

describe('the create handler forwards placement rather than dropping it', () => {
  it('POSTs the batch route with the rows the caller sent', async () => {
    const res = await createTwo();
    expect(res.isError).toBe(false);
    const batch = res.sent.find((r) => r.path.endsWith('/tasks/batch'));
    expect(batch?.method).toBe('POST');
    expect(batch?.path).toBe('/workspaces/w-1/tasks/batch');
    expect((batch?.body as { tasks: unknown[] }).tasks).toHaveLength(2);
  });

  it('returns the placement block once, not once per row', async () => {
    const res = await createTwo();
    const out = res.json as { placement?: { unplaced: string[] }; created: unknown[] };
    expect(out.placement).toEqual(batchReply.placement);
    expect(out.created).toHaveLength(2);
  });

  it('marks each returned row placed or not from the unplaced set', async () => {
    const res = await createTwo();
    const created = (res.json as { created: Array<Record<string, unknown>> }).created;
    const byTitle = new Map(created.map((c) => [c.title as string, c]));
    // The row the server left out of every band must be visibly unplaced, and
    // the one it placed must say so — the whole point of forwarding the set.
    expect(byTitle.get('Ship the search revamp')?.placed).toBe(true);
    expect(byTitle.get('Rename the export button')?.placed).toBe(false);
    // The id has to ride along or the caller cannot act on either verdict.
    expect(byTitle.get('Rename the export button')?.taskId).toBe('t-2');
  });
});

/**
 * The single-row `create_task` is GONE, and gone from the artifact peers
 * actually load — `.mcp.json` runs `packages/plugin/mcp/index.js`, so a
 * source-only removal would leave every peer still seeing the tool on its next
 * restart. That is the exact shape of PR #69, which edited mcp.ts and never
 * rebuilt.
 *
 * The removal check used to be a regex over the bundle text, with a word
 * boundary to keep `create_task` from matching inside `create_tasks`. What the
 * removal is FOR is that no session can call the singular verb, so that is
 * what is asserted now: it is off the tool list a client receives, and the
 * running bundle refuses the call.
 */
describe('create_task is removed from the surface peers load', () => {
  it('is not among the tools a client is offered', () => {
    // Positive control in the same read: the batch verb IS offered, so a
    // harness that listed nothing would fail here rather than satisfy the
    // absence assertion vacuously.
    expect(mcp.tool('create_tasks')).toBeDefined();
    expect(mcp.tool('create_task')).toBeUndefined();
    expect(mcp.tools.filter((t) => t.name === 'create_task')).toHaveLength(0);
  });

  it('refuses the call rather than quietly doing something with it', async () => {
    const res = await mcp.call('create_task', {
      workspaceId: 'w-1',
      title: 'Ship the search revamp',
    });
    expect(res.isError).toBe(true);
    // And nothing reached the server: a removed verb must not fall through to
    // a route on its way to failing.
    expect(res.sent).toEqual([]);
  });
});

/**
 * Where the schema tells an agent to write the completion criteria.
 *
 * The criteria are a FIELD. The board counts `doneWhen`, draws one entry per
 * line, and refuses a move to done while an entry is open. Prose under a
 * "Done when" heading in the description does none of that — and the schema
 * is what an agent reads in the second it decides where to put them, while
 * the skill that says the same thing is three screens away. `create_tasks`
 * body used to read 'plus "done when" criteria …' and `rewrite_task` body
 * 'state a falsifiable done-when', so both tools were steering the author
 * into the description the field exists to replace.
 *
 * `rewrite_task` rides in this file rather than in one of its own because it
 * is the other verb that writes a task body, and the bundle the harness runs
 * already serves it — a second harness would pay another process spawn to
 * read the same declaration list.
 */
describe('the task-writing verbs point completion criteria at the field', () => {
  /** A field's `description`, from a tool's top-level schema. */
  const field = (tool: string, name: string): string =>
    mcp.tool(tool)?.inputSchema?.properties?.[name]?.description ?? '';

  /** A field's `description`, from a `create_tasks` row. */
  const rowField = (name: string): string => {
    const tasks = mcp.tool('create_tasks')?.inputSchema?.properties?.tasks as
      | { items?: { properties?: Record<string, { description?: string }> } }
      | undefined;
    return tasks?.items?.properties?.[name]?.description ?? '';
  };

  /**
   * Text that asks the author to put criteria in the field it describes: the
   * two shapes that shipped ("plus … criteria", "state a … done-when"), and
   * the ones a future edit is likeliest to reach for. A redirect reads
   * "criteria … go in `doneWhen`" and matches none of them.
   */
  const ASKS_FOR_CRITERIA_HERE =
    /\b(plus|state a|include the|add the)\b[^.]*?(done.when|criteria)/i;

  it('POSITIVE CONTROL: the running bundle serves both verbs with described bodies', () => {
    expect(mcp.tool('rewrite_task')).toBeDefined();
    expect(rowField('body').length).toBeGreaterThan(40);
    expect(field('rewrite_task', 'body').length).toBeGreaterThan(40);
  });

  it('create_tasks sends the author to `doneWhen`, not to the body', () => {
    const body = rowField('body');
    expect(body).not.toMatch(ASKS_FOR_CRITERIA_HERE);
    // The redirect has to be in the body field's OWN text. A correction that
    // lives only in the doneWhen field is not read by an agent who has
    // already decided the description is where criteria go.
    expect(body).toMatch(/criteria[^.]*`doneWhen`/);
  });

  it('rewrite_task sends the author to `doneWhen`, not to the body', () => {
    const body = field('rewrite_task', 'body');
    expect(body).not.toMatch(ASKS_FOR_CRITERIA_HERE);
    expect(body).toMatch(/criteria[^.]*`doneWhen`/);
  });

  /** One described field of one tool, with the path the sweep found it at. */
  type Field = { path: string; name: string; description: string };

  /** As much of a JSON Schema node as the sweep walks. */
  type SchemaNode = {
    description?: string;
    properties?: Record<string, SchemaNode>;
    items?: SchemaNode;
  };

  /**
   * Every described field of every tool the bundle serves, nested rows
   * included — `create_tasks` keeps the row contract under `tasks.items`, so
   * a sweep that only read top-level properties would miss the field this
   * whole change is about.
   */
  const everyField = (): Field[] => {
    const out: Field[] = [];
    const walk = (path: string, name: string, node: SchemaNode | undefined): void => {
      if (!node) return;
      if (typeof node.description === 'string')
        out.push({ path, name, description: node.description });
      for (const [key, child] of Object.entries(node.properties ?? {}))
        walk(`${path}.${key}`, key, child);
      if (node.items) walk(`${path}[]`, name, node.items);
    };
    for (const t of mcp.tools) walk(t.name, t.name, t.inputSchema as SchemaNode | undefined);
    return out;
  };

  /** Task-completion criteria, however they are spelled. Not the review-item
   *  criteria `set_review_item_criteria` sets, which are a different feature
   *  and say only the bare word. */
  const MENTIONS_CRITERIA = /done[-\s]?when|completion criteria|acceptance criteria/i;
  /** The redirect: the description names the field the criteria belong to. */
  const NAMES_THE_FIELD = /`doneWhen`/;

  it('no field anywhere mentions the criteria without pointing at the field', () => {
    // The guard above names two rows, which is a guard that expires the next
    // time somebody adds a filing verb — and the old wording lived on a verb
    // nobody thought to name. So: sweep every tool.
    //
    // What the sweep means is deliberately narrow. A description that merely
    // says the words passes; `report_done_when` is about the criteria and is
    // not telling anyone where to write them. What fails is a field that
    // brings the criteria up and does NOT send the author to `doneWhen` —
    // which is exactly what both old sentences did, and neither of them
    // named the field. The first run over this schema flagged nothing: only
    // two fields mention the criteria at all, and both redirect.
    const fields = everyField();
    // Positive control, in the same read: the sweep walked real schemas and
    // reached the NESTED row. A walker that returned nothing would satisfy
    // the emptiness below while checking nothing at all.
    expect(fields.length).toBeGreaterThan(200);
    expect(fields.map((f) => f.path)).toContain('create_tasks.tasks[].doneWhen');

    const offenders = fields
      .filter((f) => f.name !== 'doneWhen')
      .filter((f) => MENTIONS_CRITERIA.test(f.description))
      .filter((f) => !NAMES_THE_FIELD.test(f.description))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('describes `doneWhen` on both verbs as the field, written at filing time', () => {
    const created = rowField('doneWhen');
    // It exists and says what it is for: one outcome per entry, and the
    // moment to write it.
    expect(created).toMatch(/one outcome per entry/i);
    expect(created).toMatch(/when you file the task/i);
    expect(created).toMatch(/refuses a move to done/i);

    const rewritten = field('rewrite_task', 'doneWhen');
    expect(rewritten).toMatch(/one outcome per entry/i);
    expect(rewritten).toMatch(/not in the body/i);
  });
});
