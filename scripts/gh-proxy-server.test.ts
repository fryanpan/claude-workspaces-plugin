/**
 * The gh proxy's handler (`gh-proxy-server.ts`) on a real unix socket, in
 * front of a stand-in for api.github.com that records every request. The
 * owner credential is a random string made here; nothing reaches GitHub.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGhProxy } from './gh-proxy-server.ts';
import type { ProxyLead } from './git-proxy-lead.ts';

const CREDENTIAL = `fake-owner-${randomBytes(12).toString('hex')}`;
const LEAD_TOKEN = randomBytes(32).toString('base64url');
const NO_GH_TOKEN = randomBytes(32).toString('base64url');

/** What the stand-in knows about each node id. */
const NODES: Record<string, { __typename: string; repo: string }> = {
  PR_listed: { __typename: 'PullRequest', repo: 'a/b' },
  PR_other: { __typename: 'PullRequest', repo: 'other/x' },
  R_listed: { __typename: 'Repository', repo: 'a/b' },
  I_listed: { __typename: 'Issue', repo: 'a/b' },
};

interface Seen {
  method: string;
  url: string;
  authorization: string;
  body: string;
}

let dir: string;
let socket: string;
let proxy: http.Server;
let api: http.Server;
let storage: http.Server;
let storageUrl: string;
const seen: Seen[] = [];
const storageSeen: Seen[] = [];
const logs: string[] = [];

function listen(s: http.Server): Promise<string> {
  return new Promise((done) =>
    s.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)),
  );
}

function record(into: Seen[], req: http.IncomingMessage): Promise<Seen> {
  return new Promise((done) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => {
      const s = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: String(req.headers.authorization ?? ''),
        body: Buffer.concat(parts).toString('utf8'),
      };
      into.push(s);
      done(s);
    });
  });
}

function call(
  method: string,
  path: string,
  opts: { token?: string; host?: string; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((done, fail) => {
    const req = http.request(
      {
        socketPath: socket,
        method,
        path,
        headers: {
          host: opts.host ?? 'api.github.com',
          ...(opts.token ? { authorization: `token ${opts.token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (d: Buffer) => parts.push(d));
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }),
        );
      },
    );
    req.on('error', fail);
    req.end(body);
  });
}

const graphql = (query: string, variables: Record<string, unknown> = {}) =>
  call('POST', '/graphql', { token: LEAD_TOKEN, body: { query, variables } });

beforeAll(async () => {
  // /tmp, not os.tmpdir(): a unix socket path may be at most 104 bytes. Linux has no /private.
  dir = mkdtempSync('/tmp/ghp-');
  socket = join(dir, 'api.sock');
  storage = http.createServer(async (req, res) => {
    await record(storageSeen, req);
    res.end('the run log');
  });
  storageUrl = await listen(storage);
  api = http.createServer(async (req, res) => {
    const s = await record(seen, req);
    if (s.url === '/graphql' && s.body.includes('GhProxyNodes')) {
      const ids: string[] = JSON.parse(s.body).variables.ids;
      const nodes = ids.map((id) => {
        const n = NODES[id];
        if (!n) return null;
        return n.__typename === 'Repository'
          ? { __typename: n.__typename, nameWithOwner: n.repo }
          : { __typename: n.__typename, repository: { nameWithOwner: n.repo } };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { nodes } }));
    } else if (s.url.endsWith('/logs')) {
      res.writeHead(302, { location: `${storageUrl}/signed/log.zip` });
      res.end();
    } else if (s.url.endsWith('/moved')) {
      res.writeHead(301, { location: '/repositories/1/pulls' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'x=1' });
      res.end(JSON.stringify({ answered: s.url }));
    }
  });
  const leads = new Map<string, ProxyLead>([
    [LEAD_TOKEN, { name: 'riverbend', repos: new Set(['a/b']), gh: true }],
    [NO_GH_TOKEN, { name: 'saltmarsh', repos: new Set(['a/b']), gh: false }],
  ]);
  proxy = createGhProxy({
    credential: CREDENTIAL,
    api: await listen(api),
    leads: () => leads,
    log: (line) => logs.push(line),
    follow: (url) => url.origin === storageUrl,
  });
  await new Promise<void>((done) => proxy.listen(socket, done));
});

afterAll(() => {
  for (const s of [proxy, api, storage]) s?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the gh proxy', () => {
  it('sends a listed repo read upstream with the owner credential in place of the lead token', async () => {
    seen.length = 0;
    const r = await call('GET', '/repos/a/b/pulls/5', { token: LEAD_TOKEN });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ answered: '/repos/a/b/pulls/5' });
    expect(seen.map((s) => s.authorization)).toEqual([`token ${CREDENTIAL}`]);
  });

  it('refuses an unlisted repo, no token, a lead without gh, and another host, sending nothing', async () => {
    seen.length = 0;
    expect((await call('GET', '/repos/other/x/pulls', { token: LEAD_TOKEN })).status).toBe(403);
    expect((await call('GET', '/repos/a/b/pulls')).status).toBe(401);
    expect((await call('GET', '/repos/a/b/pulls', { token: NO_GH_TOKEN })).status).toBe(401);
    const host = await call('GET', '/repos/a/b', { token: LEAD_TOKEN, host: 'uploads.github.com' });
    expect(host.status).toBe(421);
    expect(seen).toEqual([]);
  });

  it('refuses an `author { repositories }` walk before anything goes upstream', async () => {
    seen.length = 0;
    const r = await graphql(
      `query PullRequestByNumber($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) {
        pullRequest(number: 1) { author { ... on User { repositories(first: 50) { nodes { name } } } } } } }`,
      { owner: 'a', repo: 'b' },
    );
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).message).toContain('author.repositories');
    expect(seen).toEqual([]);
  });

  it('refuses a node id from an unlisted repo, after asking upstream only what it is', async () => {
    seen.length = 0;
    const checks =
      'query PullRequestStatusChecks($id: ID!) { node(id: $id) { ... on PullRequest { number } } }';
    const r = await graphql(checks, { id: 'PR_other' });
    expect(r.status).toBe(403);
    const message = JSON.parse(r.body).message;
    expect(message).toContain("not in a repo in riverbend's githubRepos");
    // It does not say which repo: that would name a private repo from its id.
    expect(message).not.toContain('other/x');
    expect(seen.map((s) => s.body.includes('GhProxyNodes'))).toEqual([true]);
    const ok = await graphql(checks, { id: 'PR_listed' });
    expect(ok.status).toBe(200);
  });

  it('refuses a comment on something that is not a pull request, and an id that does not resolve', async () => {
    const comment =
      'mutation CommentCreate($input: AddCommentInput!) { addComment(input: $input) { __typename } }';
    const issue = await graphql(comment, { input: { subjectId: 'I_listed', body: 'hi' } });
    expect(issue.status).toBe(403);
    expect(JSON.parse(issue.body).message).toContain('Issue');
    const gone = await graphql(comment, { input: { subjectId: 'PR_gone', body: 'hi' } });
    expect(gone.status).toBe(403);
    const ok = await graphql(comment, { input: { subjectId: 'PR_listed', body: 'hi' } });
    expect(ok.status).toBe(200);
  });

  it("follows a redirect to GitHub's storage without the credential, and refuses one inside the API", async () => {
    storageSeen.length = 0;
    const logsCall = await call('GET', '/repos/a/b/actions/runs/1/logs', { token: LEAD_TOKEN });
    expect(logsCall).toEqual({ status: 200, body: 'the run log' });
    expect(storageSeen.map((s) => [s.url, s.authorization])).toEqual([['/signed/log.zip', '']]);
    expect((await call('GET', '/repos/a/b/moved', { token: LEAD_TOKEN })).status).toBe(403);
  });

  it('never returns or logs the credential, and drops headers it does not list', async () => {
    const r = await call('GET', '/repos/a/b', { token: LEAD_TOKEN });
    expect(r.body).not.toContain(CREDENTIAL);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(CREDENTIAL);
    for (const line of logs) expect(line).not.toContain(LEAD_TOKEN);
    await new Promise<void>((done) =>
      http
        .get(
          {
            socketPath: socket,
            path: '/repos/a/b',
            headers: { host: 'api.github.com', authorization: `token ${LEAD_TOKEN}` },
          },
          (res) => {
            expect(res.headers['set-cookie']).toBeUndefined();
            res.resume();
            res.on('end', done);
          },
        )
        .on('error', done),
    );
  });
});
