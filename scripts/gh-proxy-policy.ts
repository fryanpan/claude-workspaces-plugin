/**
 * What the gh proxy (`gh-proxy-server.ts`) lets a lead ask GitHub. Reads of
 * the repos in the lead's `githubRepos`, and gh's own PR create, comment and
 * edit on them. Anything else is refused, with a reason that names what to
 * add here if gh needs it.
 *
 * GraphQL is checked in four ways:
 *
 * - The operation's name and type must be in `OPERATIONS`, which lists what
 *   gh 2.102 sent from `gh pr view/list/status/checks/create/comment/edit`,
 *   and its root fields must be the ones that entry names.
 * - Every root field is scoped. `repository(owner, name)` must name a listed
 *   repo; `search` must name exactly one listed repo with `repo:` and no
 *   `org:`, `user:` or `owner:`; `node(id)` and each id in a mutation's
 *   input come back in `nodes`, for the server to resolve upstream before it
 *   forwards anything.
 * - Every field path must be in `gh-proxy-fields.json`, read from the same
 *   capture. A path below a pull request (`MOUNTS`) is checked against the
 *   pull request list wherever it appears. This is what refuses a walk from
 *   a listed repo to an unlisted one: `author { repositories }` is not a
 *   path gh asks for.
 * - A mutation's input may carry only the fields gh sends.
 *
 * REST: GET and HEAD under `/repos/<listed repo>`, except its settings.
 */
import { readFileSync } from 'node:fs';
import {
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  Kind,
  type OperationDefinitionNode,
  type SelectionSetNode,
  parse,
  valueFromASTUntyped,
} from 'graphql';

export type NodeType = 'Repository' | 'PullRequest';
export interface NodeCheck {
  id: string;
  type: NodeType;
}
export type GraphqlVerdict =
  | { ok: true; operation: string; nodes: NodeCheck[] }
  | { ok: false; why: string };

const WHERE = 'scripts/gh-proxy-policy.ts';

/** Each operation gh sends, its type, and the root fields it may use. */
export const OPERATIONS: Record<string, { type: 'query' | 'mutation'; roots: string[] }> = {
  PullRequestByNumber: { type: 'query', roots: ['repository'] },
  PullRequestForBranch: { type: 'query', roots: ['repository'] },
  PullRequestForRun: { type: 'query', roots: ['repository'] },
  PullRequestList: { type: 'query', roots: ['repository'] },
  PullRequestProjectItems: { type: 'query', roots: ['repository'] },
  PullRequestStatus: { type: 'query', roots: ['repository', 'search'] },
  PullRequestStatusChecks: { type: 'query', roots: ['node'] },
  PullRequest_fields: { type: 'query', roots: ['__type'] },
  PullRequest_fields2: { type: 'query', roots: ['__type'] },
  SearchType_enumValues: { type: 'query', roots: ['__type'] },
  RepositoryInfo: { type: 'query', roots: ['repository'] },
  UserCurrent: { type: 'query', roots: ['viewer'] },
  CommentCreate: { type: 'mutation', roots: ['addComment'] },
  PullRequestCreate: { type: 'mutation', roots: ['createPullRequest'] },
  PullRequestUpdate: { type: 'mutation', roots: ['updatePullRequest'] },
  ReplaceActorsForAssignable: { type: 'mutation', roots: ['replaceActorsForAssignable'] },
  RequestReviewsByLogin: { type: 'mutation', roots: ['requestReviewsByLogin'] },
};

/** Each mutation's input: the id it acts on, with its type, and the other fields gh sends. */
const MUTATION_INPUTS: Record<string, { id: string; type: NodeType; fields: string[] }> = {
  addComment: { id: 'subjectId', type: 'PullRequest', fields: ['body'] },
  createPullRequest: {
    id: 'repositoryId',
    type: 'Repository',
    fields: ['baseRefName', 'body', 'draft', 'headRefName', 'maintainerCanModify', 'title'],
  },
  updatePullRequest: {
    id: 'pullRequestId',
    type: 'PullRequest',
    fields: ['baseRefName', 'body', 'title'],
  },
  replaceActorsForAssignable: { id: 'assignableId', type: 'PullRequest', fields: ['actorLogins'] },
  requestReviewsByLogin: {
    id: 'pullRequestId',
    type: 'PullRequest',
    fields: ['botLogins', 'teamSlugs', 'union', 'userLogins'],
  },
};

/** Where a pull request sits in a query; paths below one are checked against `pullRequest`. */
const MOUNTS = [
  'repository.pullRequest',
  'repository.pullRequests.edges.node',
  'repository.pullRequests.nodes',
  'search.edges.node',
  'search.nodes',
  'node',
  'createPullRequest.pullRequest',
  'updatePullRequest.pullRequest',
];

const FIELDS: { pullRequest: string[]; root: string[] } = JSON.parse(
  readFileSync(new URL('./gh-proxy-fields.json', import.meta.url), 'utf8'),
);
const PR_PATHS = new Set(FIELDS.pullRequest);
const ROOT_PATHS = new Set(FIELDS.root);

function pathAllowed(path: string): boolean {
  if (MOUNTS.includes(path) || ROOT_PATHS.has(path)) return true;
  const mount = MOUNTS.find((m) => path.startsWith(`${m}.`));
  return mount !== undefined && PR_PATHS.has(path.slice(mount.length + 1));
}

const MAX_QUERY = 100_000;

type Vars = Record<string, unknown>;

function arg(field: FieldNode, name: string, vars: Vars): unknown {
  const a = field.arguments?.find((x) => x.name.value === name);
  return a ? valueFromASTUntyped(a.value, vars) : undefined;
}

/** Null when a search names exactly one listed repo and no owner; otherwise why not. */
function searchRefusal(q: unknown, repos: ReadonlySet<string>): string | null {
  if (typeof q !== 'string') return 'search needs a query string';
  const words = q.split(/\s+/).map((w) => w.replace(/^["(-]+|[")]+$/g, '').toLowerCase());
  const named = words.filter((w) => w.startsWith('repo:')).map((w) => w.slice(5));
  if (words.some((w) => /^(org|user|owner):/.test(w)))
    return 'search may not name an org, user or owner';
  if (named.length !== 1) return 'search must name exactly one repo with repo:';
  return repos.has(named[0] ?? '') ? null : `search names ${named[0]}, which is not listed`;
}

/** Every field path under `set`, through fragments; the first one not allowed, or null. */
function badPath(
  set: SelectionSetNode,
  prefix: string,
  frags: Map<string, FragmentDefinitionNode>,
  seen: readonly string[],
): string | null {
  for (const s of set.selections) {
    if (s.kind === Kind.FIELD) {
      if (s.name.value === '__typename') continue;
      const path = prefix ? `${prefix}.${s.name.value}` : s.name.value;
      if (!pathAllowed(path)) return path;
      const below = s.selectionSet ? badPath(s.selectionSet, path, frags, seen) : null;
      if (below) return below;
    } else if (s.kind === Kind.INLINE_FRAGMENT) {
      const below = badPath(s.selectionSet, prefix, frags, seen);
      if (below) return below;
    } else {
      const name = s.name.value;
      const f = frags.get(name);
      if (!f || seen.includes(name)) return `${prefix}...${name}`;
      const below = badPath(f.selectionSet, prefix, frags, [...seen, name]);
      if (below) return below;
    }
  }
  return null;
}

/** The root fields of an operation, with top-level fragments opened. */
function rootFields(
  set: SelectionSetNode,
  frags: Map<string, FragmentDefinitionNode>,
  seen: readonly string[] = [],
): FieldNode[] | null {
  const out: FieldNode[] = [];
  for (const s of set.selections) {
    if (s.kind === Kind.FIELD) out.push(s);
    else {
      const name = s.kind === Kind.FRAGMENT_SPREAD ? s.name.value : null;
      const inner =
        s.kind === Kind.INLINE_FRAGMENT
          ? s.selectionSet
          : name
            ? frags.get(name)?.selectionSet
            : null;
      if (!inner || (name && seen.includes(name))) return null;
      const more = rootFields(inner, frags, name ? [...seen, name] : seen);
      if (!more) return null;
      out.push(...more);
    }
  }
  return out;
}

/** The verdict on one root field; ids it names are pushed onto `nodes`. */
function rootRefusal(
  op: string,
  field: FieldNode,
  vars: Vars,
  repos: ReadonlySet<string>,
  nodes: NodeCheck[],
): string | null {
  const name = field.name.value;
  if (name === 'repository') {
    const owner = arg(field, 'owner', vars);
    const repo = arg(field, 'name', vars);
    const full = `${String(owner)}/${String(repo)}`;
    if (typeof owner !== 'string' || typeof repo !== 'string' || !repos.has(full.toLowerCase()))
      return `${op}: repository ${full} is not in the lead's githubRepos`;
    return null;
  }
  if (name === 'search') {
    const why = searchRefusal(arg(field, 'query', vars), repos);
    return why ? `${op}: ${why}` : null;
  }
  if (name === 'node') {
    const id = arg(field, 'id', vars);
    if (typeof id !== 'string') return `${op}: node needs one id`;
    nodes.push({ id, type: 'PullRequest' });
    return null;
  }
  const input = MUTATION_INPUTS[name];
  if (input) {
    const given = arg(field, 'input', vars);
    if (typeof given !== 'object' || given === null || Array.isArray(given))
      return `${op}: ${name} needs an input object`;
    const fields = given as Record<string, unknown>;
    const extra = Object.keys(fields).filter(
      (k) => k !== input.id && k !== 'clientMutationId' && !input.fields.includes(k),
    );
    if (extra.length > 0)
      return `${op}: ${name} input field ${extra.join(', ')} is not on the gh proxy's list (${WHERE})`;
    const id = fields[input.id];
    if (typeof id !== 'string') return `${op}: ${name} needs input.${input.id}`;
    nodes.push({ id, type: input.type });
  }
  return null;
}

export function checkGraphql(body: unknown, repos: ReadonlySet<string>): GraphqlVerdict {
  if (typeof body !== 'object' || body === null)
    return { ok: false, why: 'the body is not a JSON object' };
  const { query, variables, operationName } = body as Record<string, unknown>;
  if (typeof query !== 'string' || query.length > MAX_QUERY)
    return { ok: false, why: 'the body needs a query of at most 100 kB' };
  const vars = (typeof variables === 'object' && variables !== null ? variables : {}) as Vars;
  let doc: DocumentNode;
  try {
    doc = parse(query, { noLocation: true });
  } catch (err) {
    return { ok: false, why: `the query does not parse: ${(err as Error).message}` };
  }
  const ops = doc.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  );
  const frags = new Map<string, FragmentDefinitionNode>();
  for (const d of doc.definitions)
    if (d.kind === Kind.FRAGMENT_DEFINITION) frags.set(d.name.value, d);
  if (ops.length !== 1) return { ok: false, why: 'the query must hold one operation' };
  const operation = ops[0] as OperationDefinitionNode;
  const op = operation.name?.value ?? '(unnamed)';
  if (operationName !== undefined && operationName !== null && operationName !== op)
    return {
      ok: false,
      why: `operationName ${String(operationName)} is not the operation sent, ${op}`,
    };
  const entry = Object.hasOwn(OPERATIONS, op) ? OPERATIONS[op] : undefined;
  if (!entry || entry.type !== operation.operation)
    return {
      ok: false,
      why: `GraphQL ${operation.operation} ${op} is not on the gh proxy's list; if gh needs it, add it to OPERATIONS in ${WHERE}`,
    };
  const roots = rootFields(operation.selectionSet, frags);
  if (!roots) return { ok: false, why: `${op}: a fragment at the root cannot be read` };
  const nodes: NodeCheck[] = [];
  for (const field of roots) {
    if (!entry.roots.includes(field.name.value))
      return {
        ok: false,
        why: `${op}: root field ${field.name.value} is not one this operation uses`,
      };
    const why = rootRefusal(op, field, vars, repos, nodes);
    if (why) return { ok: false, why };
  }
  const bad = badPath(operation.selectionSet, '', frags, []);
  if (bad)
    return {
      ok: false,
      why: `${op}: field ${bad} is not on the gh proxy's list (scripts/gh-proxy-fields.json)`,
    };
  return { ok: true, operation: op, nodes };
}

/** Folders under a repo that hold its settings or its secrets' names. */
const SETTINGS = [
  'hooks',
  'keys',
  'invitations',
  'environments',
  'actions/secrets',
  'actions/variables',
  'actions/runners',
  'dependabot/secrets',
  'codespaces/secrets',
];

export function checkRest(
  method: string,
  url: string,
  repos: ReadonlySet<string>,
): { ok: true } | { ok: false; why: string } {
  if (method !== 'GET' && method !== 'HEAD')
    return { ok: false, why: `REST ${method} is refused: the gh proxy passes reads only` };
  const path = url.split('?')[0] ?? '';
  if (/%2f|%2e|%5c|\\/i.test(path) || path.split('/').some((p) => p === '.' || p === '..'))
    return { ok: false, why: `REST path ${path} is refused: it is encoded or climbs` };
  const parts = path.split('/');
  if (parts[1] !== 'repos' || !parts[2] || !parts[3])
    return { ok: false, why: `REST ${path} is refused: only /repos/<listed repo> is passed` };
  const repo = `${parts[2]}/${parts[3]}`.toLowerCase();
  if (!repos.has(repo)) return { ok: false, why: `${repo} is not in the lead's githubRepos` };
  const rest = parts.slice(4).join('/');
  if (SETTINGS.some((s) => rest === s || rest.startsWith(`${s}/`)))
    return { ok: false, why: `REST ${path} is refused: it reads the repo's settings` };
  return { ok: true };
}
