/**
 * What the gh proxy lets a lead ask GitHub (`gh-proxy-policy.ts`). The
 * operations in `fixtures/gh-proxy/` are gh 2.102's own requests, captured
 * from `gh pr view/list/status/checks/create/comment/edit` against a stub,
 * with `a/b` as the repo.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPERATIONS, checkGraphql, checkRest } from './gh-proxy-policy.ts';

interface Sample {
  op: string;
  query: string;
  variables: Record<string, unknown>;
}

const SAMPLES: Sample[] = JSON.parse(
  readFileSync(new URL('./fixtures/gh-proxy/gh-2.102-operations.json', import.meta.url), 'utf8'),
);
const LISTED = new Set(['a/b']);
const sample = (op: string): Sample => {
  const s = SAMPLES.find((x) => x.op === op);
  if (!s) throw new Error(`no sample for ${op}`);
  return s;
};
const refusal = (body: unknown, repos: ReadonlySet<string> = LISTED): string => {
  const v = checkGraphql(body, repos);
  return v.ok ? 'allowed' : v.why;
};

describe('checkGraphql: what gh itself sends', () => {
  it('allows every operation gh 2.102 sent, and the list names exactly those', () => {
    for (const s of SAMPLES) expect(refusal(s), s.op).toBe('allowed');
    expect(Object.keys(OPERATIONS).sort()).toEqual(SAMPLES.map((s) => s.op).sort());
  });

  it('asks for every node id a query or mutation names to be resolved, with the type it must be', () => {
    const checks = checkGraphql(sample('PullRequestStatusChecks'), LISTED);
    expect(checks.ok && checks.nodes).toEqual([{ id: 'PR_stub', type: 'PullRequest' }]);
    const create = checkGraphql(sample('PullRequestCreate'), LISTED);
    expect(create.ok && create.nodes).toEqual([{ id: 'R_stub', type: 'Repository' }]);
    const comment = checkGraphql(sample('CommentCreate'), LISTED);
    expect(comment.ok && comment.nodes).toEqual([{ id: 'PR_stub', type: 'PullRequest' }]);
  });

  it('matches a listed repo without case, as GitHub does', () => {
    const s = sample('RepositoryInfo');
    expect(refusal({ ...s, variables: { owner: 'A', name: 'B' } })).toBe('allowed');
  });
});

describe('checkGraphql: what it refuses', () => {
  it('refuses an operation that is not on the list, naming it and where the list is', () => {
    const why = refusal({ query: 'query Mystery { viewer { login } }' });
    expect(why).toContain('Mystery');
    expect(why).toContain('scripts/gh-proxy-policy.ts');
    expect(refusal({ query: '{ viewer { login } }' })).toContain('(unnamed)');
  });

  it('refuses an `author { repositories }` walk out of a listed repo', () => {
    const query = `query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!) {
      repository(owner: $owner, name: $repo) { pullRequest(number: $pr_number) {
        author { login ... on User { repositories(first: 100) { nodes { nameWithOwner } } } } } } }`;
    const why = refusal({ query, variables: { owner: 'a', repo: 'b', pr_number: 1 } });
    expect(why).toContain('PullRequestByNumber');
    expect(why).toContain('repository.pullRequest.author.repositories');
  });

  it('refuses the same walk hidden in a fragment or under an alias', () => {
    const query = `query PullRequestByNumber($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) { pullRequest(number: 1) { ...F } } }
      fragment F on PullRequest { title author { owned: repositories(first: 5) { totalCount } } }`;
    expect(refusal({ query, variables: { owner: 'a', repo: 'b' } })).toContain(
      'author.repositories',
    );
  });

  it('refuses a repo the lead does not list, from a variable or a literal', () => {
    const s = sample('RepositoryInfo');
    expect(refusal({ ...s, variables: { owner: 'other', name: 'repo' } })).toContain('other/repo');
    const literal = 'query RepositoryInfo { repository(owner: "other", name: "repo") { name } }';
    expect(refusal({ query: literal })).toContain('other/repo');
  });

  it('refuses a root field its operation does not use', () => {
    const query =
      'query UserCurrent { viewer { login } repository(owner: "a", name: "b") { name } }';
    expect(refusal({ query })).toContain('repository');
  });

  it("refuses a root field gh's operations never ask for", () => {
    const query = 'query UserCurrent { organization(login: "x") { name } }';
    expect(refusal({ query })).toContain('organization');
  });

  it('refuses a search that does not name exactly one listed repo', () => {
    const s = sample('PullRequestStatus');
    const withQuery = (q: string) => ({
      ...s,
      variables: { ...s.variables, viewerQuery: q, reviewerQuery: 'repo:a/b is:pr' },
    });
    expect(refusal(withQuery('repo:a/b state:open is:pr author:@me'))).toBe('allowed');
    expect(refusal(withQuery('state:open is:pr author:@me'))).toContain('search');
    expect(refusal(withQuery('repo:a/b repo:other/x is:pr'))).toContain('search');
    expect(refusal(withQuery('repo:other/x is:pr'))).toContain('search');
    expect(refusal(withQuery('repo:a/b org:other is:pr'))).toContain('search');
  });

  it('refuses a mutation that is not a PR create, comment or edit', () => {
    const merge =
      'mutation PullRequestMerge($input: MergePullRequestInput!) { mergePullRequest(input: $input) { __typename } }';
    expect(refusal({ query: merge, variables: { input: { pullRequestId: 'PR_x' } } })).toContain(
      'PullRequestMerge',
    );
    const disguised =
      'mutation CommentCreate($input: AddCommentInput!) { deleteRepository(input: $input) { __typename } }';
    expect(refusal({ query: disguised, variables: { input: { repositoryId: 'R_x' } } })).toContain(
      'deleteRepository',
    );
  });

  it('refuses a mutation input field gh does not send, such as moving a PR to another repo', () => {
    const s = sample('PullRequestCreate');
    const input = { ...(s.variables.input as object), headRepositoryId: 'R_other' };
    expect(refusal({ ...s, variables: { input } })).toContain('headRepositoryId');
  });

  it('refuses an input it cannot read, a second operation, and a subscription', () => {
    expect(refusal('not an object')).toContain('JSON');
    expect(refusal({ query: 'query {' })).toContain('parse');
    const two = 'query UserCurrent { viewer { login } } query Other { viewer { login } }';
    expect(refusal({ query: two })).toContain('one operation');
    expect(refusal({ query: 'subscription UserCurrent { viewer { login } }' })).toContain(
      'UserCurrent',
    );
  });

  it('refuses an operationName that is not the operation it sends', () => {
    expect(refusal({ ...sample('UserCurrent'), operationName: 'Other' })).toContain('Other');
  });
});

describe('checkRest', () => {
  const ok = (method: string, url: string) => checkRest(method, url, LISTED);
  it('allows reads under a listed repo', () => {
    expect(ok('GET', '/repos/a/b/pulls/5')).toEqual({ ok: true });
    expect(ok('GET', '/repos/A/B/actions/runs?per_page=20')).toEqual({ ok: true });
    expect(ok('HEAD', '/repos/a/b')).toEqual({ ok: true });
  });

  it('refuses a write, another repo, a path out of the repo, and its settings', () => {
    expect(ok('POST', '/repos/a/b/issues')).toMatchObject({ ok: false });
    expect(ok('DELETE', '/repos/a/b')).toMatchObject({ ok: false });
    expect(ok('GET', '/repos/other/x/pulls')).toMatchObject({ ok: false });
    expect(ok('GET', '/user/repos')).toMatchObject({ ok: false });
    expect(ok('GET', '/repos/a/b/../../other/x')).toMatchObject({ ok: false });
    expect(ok('GET', '/repos/a/b%2F..%2F..%2Fother%2Fx')).toMatchObject({ ok: false });
    expect(ok('GET', '/repos/a/b/hooks')).toMatchObject({ ok: false });
    expect(ok('GET', '/repos/a/b/actions/secrets')).toMatchObject({ ok: false });
    expect(ok('GET', '/repos/a/b/keys')).toMatchObject({ ok: false });
  });
});
