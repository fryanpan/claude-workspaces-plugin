/**
 * The gh proxy's request handler. A walled lead's gh sends its GitHub API
 * calls here, over a unix socket, with the lead's own token; this checks
 * each call against `gh-proxy-policy.ts` and sends the ones it allows to
 * GitHub with the owner's credential. It runs in the git proxy's process
 * (`git-proxy.ts`), so the credential is read once and held in one place.
 *
 * What it answers, in order: a Host other than api.github.com, 421; no
 * token, or one that no lead with the `gh` tool holds, 401; a call the
 * policy refuses, 403 with its reason; a node id that does not resolve to a
 * pull request or repo in the lead's list, 403. Everything else goes
 * upstream, and its answer comes back with a short list of headers.
 *
 * A redirect from GitHub to its own file storage (a run's logs, an
 * artifact) is followed here, without the credential, because the lead's gh
 * could only follow it back through this socket.
 *
 * The credential is held in memory only, sent to the API host and nowhere
 * else, and every log line and error text passes through `redact`.
 */
import http from 'node:http';
import https from 'node:https';
import { type NodeCheck, checkGraphql, checkRest } from './gh-proxy-policy.ts';
import { type ProxyLead, findLead } from './git-proxy-lead.ts';
import { credentialForms, redact } from './git-proxy-lib.ts';

export interface GhProxyOptions {
  /** The owner's GitHub credential. Never logged, stored or returned. */
  credential: string;
  /** `https://api.github.com`, or a test's own server. */
  api: string;
  /** Token to lead, read on every request. */
  leads(): Map<string, ProxyLead>;
  log(line: string): void;
  /** Where a redirect may lead; GitHub's file storage over HTTPS unless a test says otherwise. */
  follow?: (url: URL) => boolean;
}

/** What a node id resolved to: its type and, for a repo or pull request, its repo. */
export interface Resolved {
  type: string;
  repo: string | null;
}

const MAX_BODY = 1024 * 1024;
const SEND_UP = [
  'accept',
  'content-type',
  'user-agent',
  'x-github-api-version',
  'graphql-features',
];
const PASS_BACK = [
  'content-type',
  'link',
  'etag',
  'last-modified',
  'x-github-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-used',
  'x-ratelimit-resource',
];
const RESOLVE = `query GhProxyNodes($ids: [ID!]!) { nodes(ids: $ids) { __typename
  ... on Repository { nameWithOwner } ... on PullRequest { repository { nameWithOwner } } } }`;

/** GitHub's own storage for logs and artifacts, over HTTPS. */
export function githubStorage(url: URL): boolean {
  const host = url.hostname;
  return (
    url.protocol === 'https:' &&
    (host.endsWith('.actions.githubusercontent.com') ||
      host === 'objects.githubusercontent.com' ||
      host.endsWith('.blob.core.windows.net'))
  );
}

function tokenOf(header: string | undefined): string | null {
  const m = /^(?:token|bearer)\s+(\S+)$/i.exec(header ?? '');
  return m?.[1] ?? null;
}

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
      } else parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export function createGhProxy(opts: GhProxyOptions): http.Server {
  const secrets = credentialForms(opts.credential);
  const clean = (s: string) => redact(s, secrets);
  const log = (line: string) => opts.log(clean(line));
  const base = new URL(opts.api);
  const follow = opts.follow ?? githubStorage;
  const resolved = new Map<string, Resolved>();

  const answer = (res: http.ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: `gh proxy: ${clean(message)}` }));
  };

  const send = (
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: Buffer | null,
  ): Promise<http.IncomingMessage> =>
    new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http;
      const up = client.request(url, { method, headers }, resolve);
      up.on('error', reject);
      up.end(body ?? undefined);
    });

  /** A request to the API host: the client's few safe headers, and the owner's credential. */
  const upstream = (
    given: http.IncomingHttpHeaders,
    method: string,
    path: string,
    body: Buffer | null,
  ) => {
    const headers: Record<string, string> = {
      authorization: `token ${opts.credential}`,
      'accept-encoding': 'identity',
    };
    for (const h of SEND_UP) if (typeof given[h] === 'string') headers[h] = given[h] as string;
    if (body) headers['content-length'] = String(body.length);
    return send(new URL(path, base), method, headers, body);
  };

  const relay = (res: http.ServerResponse, up: http.IncomingMessage, status = up.statusCode) => {
    const headers: Record<string, string> = {};
    for (const h of PASS_BACK)
      if (typeof up.headers[h] === 'string') headers[h] = up.headers[h] as string;
    res.writeHead(status ?? 502, headers);
    up.pipe(res);
    return status ?? 502;
  };

  /** Each id's type and repo, asked upstream once and then remembered. */
  const resolve = async (ids: string[]): Promise<Map<string, Resolved>> => {
    const missing = [...new Set(ids)].filter((id) => !resolved.has(id));
    if (missing.length > 0) {
      const body = Buffer.from(JSON.stringify({ query: RESOLVE, variables: { ids: missing } }));
      const up = await upstream({ 'content-type': 'application/json' }, 'POST', '/graphql', body);
      const parts: Buffer[] = [];
      for await (const d of up) parts.push(d as Buffer);
      const got = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') as {
        data?: {
          nodes?: ({
            __typename?: string;
            nameWithOwner?: string;
            repository?: { nameWithOwner?: string };
          } | null)[];
        };
      };
      const nodes = got.data?.nodes ?? [];
      missing.forEach((id, i) => {
        const n = nodes[i];
        if (!n?.__typename) return;
        const repo = n.nameWithOwner ?? n.repository?.nameWithOwner ?? null;
        if (resolved.size >= 10_000) resolved.clear();
        resolved.set(id, { type: n.__typename, repo: repo?.toLowerCase() ?? null });
      });
    }
    return resolved;
  };

  /** Null when every id is the type its place needs, in a listed repo; otherwise why not. */
  const nodeRefusal = async (nodes: NodeCheck[], lead: ProxyLead): Promise<string | null> => {
    if (nodes.length === 0) return null;
    const known = await resolve(nodes.map((n) => n.id));
    for (const n of nodes) {
      const r = known.get(n.id);
      if (!r) return `node ${n.id} does not resolve`;
      if (r.type !== n.type) return `node ${n.id} is a ${r.type}, not a ${n.type}`;
      if (!r.repo || !lead.repos.has(r.repo))
        return `node ${n.id} is not in a repo in ${lead.name}'s githubRepos`;
    }
    return null;
  };

  const graphql = async (req: http.IncomingMessage, res: http.ServerResponse, lead: ProxyLead) => {
    const body = await readBody(req);
    if (body === null) return answer(res, 413, `a GraphQL body over ${MAX_BODY} bytes is refused`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      parsed = null;
    }
    const verdict = checkGraphql(parsed, lead.repos);
    if (!verdict.ok) {
      log(`403 ${lead.name} graphql: ${verdict.why}`);
      return answer(res, 403, verdict.why);
    }
    const why = await nodeRefusal(verdict.nodes, lead);
    if (why) {
      log(`403 ${lead.name} graphql ${verdict.operation}: ${why}`);
      return answer(res, 403, `${verdict.operation}: ${why}`);
    }
    const up = await upstream(req.headers, 'POST', '/graphql', body);
    log(`${relay(res, up)} ${lead.name} graphql ${verdict.operation}`);
  };

  const rest = async (req: http.IncomingMessage, res: http.ServerResponse, lead: ProxyLead) => {
    const method = req.method ?? '';
    const url = req.url ?? '/';
    const verdict = checkRest(method, url, lead.repos);
    if (!verdict.ok) {
      log(`403 ${lead.name} ${method} ${url}: ${verdict.why}`);
      return answer(res, 403, verdict.why);
    }
    let up = await upstream(req.headers, method, url, null);
    for (let hop = 0; hop < 3; hop++) {
      const status = up.statusCode ?? 502;
      const location = up.headers.location;
      if (status < 300 || status >= 400 || typeof location !== 'string') break;
      up.resume();
      const next = new URL(location, base);
      if (next.host === base.host) return answer(res, 403, 'a redirect inside the API is refused');
      if (!follow(next)) return answer(res, 502, `a redirect to ${next.host} is refused`);
      up = await send(next, 'GET', { 'user-agent': 'claude-workspaces-gh-proxy' }, null);
    }
    log(`${relay(res, up)} ${lead.name} ${method} ${url}`);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== 'api.github.com')
      return answer(res, 421, `only api.github.com is proxied, not ${host}`);
    const lead = findLead(opts.leads(), tokenOf(req.headers.authorization));
    if (!lead?.gh) {
      log(`401 ${req.method} ${req.url}: no token, or one no lead with gh holds`);
      return answer(res, 401, 'a lead token is needed, from a lead whose tools list gh');
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/graphql' && req.method === 'POST') return graphql(req, res, lead);
    return rest(req, res, lead);
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const text = clean(err instanceof Error ? err.message : String(err));
      opts.log(`500 ${req.method} ${req.url}: ${text}`);
      if (!res.headersSent) answer(res, 500, `the proxy failed: ${text}`);
      else res.destroy();
    });
  });
}
