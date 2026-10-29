/**
 * The GitHub proxy's request handler: a lead's git talks smart HTTP to it
 * with the lead's own token, and it talks to the upstream with the owner's
 * credential. The CLI is `git-proxy.ts`; the protocol reading is
 * `git-proxy-lib.ts`; the fast-forward check is `git-proxy-push.ts`.
 *
 * What it answers, in order: a path that is not one repo's smart-HTTP
 * endpoint, 404; no token or an unknown one, 401; a repo the lead's list
 * does not name, 403; a push that deletes a ref or moves one other than
 * forward on the repo's default branch, 403. Any other branch may be
 * force-pushed: a rebase needs it. Everything else goes upstream.
 *
 * The credential is held in memory only. It is sent upstream and nowhere
 * else: a client's headers are never echoed, the upstream's are filtered to
 * the few git needs, an upstream refusal is replaced by fixed text, and any
 * other error text and every log line pass through `redact`.
 */
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import type { ProxyLead } from './git-proxy-lead.ts';
import {
  type RepoRequest,
  addNoThin,
  basicHeader,
  basicPassword,
  credentialForms,
  headSymref,
  isZero,
  parseReceivePack,
  parseRepoRequest,
  redact,
} from './git-proxy-lib.ts';
import { type Ancestry, githubAncestry, isFastForward, packCommits } from './git-proxy-push.ts';

export interface GitProxyOptions {
  /** The owner's GitHub credential. Never logged, stored or returned. */
  credential: string;
  /** `https://github.com`, or a test's own server. */
  upstream: string;
  /** `https://api.github.com`, for the fast-forward check. */
  api: string;
  /** Token to lead, read on every request. */
  leads(): Map<string, ProxyLead>;
  log(line: string): void;
  /** Largest push body it reads, in bytes. GitHub's own limit is 2 GiB. */
  maxPushBytes?: number;
  /** For tests: what answers "is old an ancestor of this commit". */
  ancestry?: (repo: string) => Ancestry;
}

const PASS_BACK = ['content-type', 'cache-control', 'expires', 'pragma', 'content-encoding'];

function findLead(leads: Map<string, ProxyLead>, password: string | null): ProxyLead | null {
  if (password === null) return null;
  const given = Buffer.from(password, 'utf8');
  let found: ProxyLead | null = null;
  for (const [token, lead] of leads) {
    const want = Buffer.from(token, 'utf8');
    if (want.length === given.length && timingSafeEqual(want, given)) found = lead;
  }
  return found;
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > max) {
        resolve(null);
        req.destroy();
      } else parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export function createGitProxy(opts: GitProxyOptions): http.Server {
  const secrets = credentialForms(opts.credential);
  const clean = (s: string) => redact(s, secrets);
  const log = (line: string) => opts.log(clean(line));
  const ancestryFor =
    opts.ancestry ?? ((repo: string) => githubAncestry(opts.api, repo, opts.credential));
  const maxPush = opts.maxPushBytes ?? 1024 * 1024 * 1024;
  const base = new URL(opts.upstream);
  const client = base.protocol === 'https:' ? https : http;

  const answer = (res: http.ServerResponse, status: number, text: string, extra = {}) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...extra });
    res.end(`${clean(text)}\n`);
  };

  /** One request upstream, with the owner's credential and the headers git needs, nothing else. */
  const upstream = (
    given: http.IncomingHttpHeaders,
    r: RepoRequest,
    body: Buffer | http.IncomingMessage | null,
  ): Promise<http.IncomingMessage> => {
    const path =
      r.kind === 'refs'
        ? `/${r.repo}.git/info/refs?service=${r.service}`
        : `/${r.repo}.git/${r.service}`;
    const headers: Record<string, string> = {
      authorization: basicHeader(opts.credential),
      'user-agent': String(given['user-agent'] ?? 'git/claude-workspaces-git-proxy'),
      'accept-encoding': 'identity',
    };
    for (const h of ['accept', 'content-type'])
      if (typeof given[h] === 'string') headers[h] = given[h] as string;
    // Protocol v2 is a fetch thing; a push stays on v0, where the check reads it.
    if (r.service === 'git-upload-pack' && typeof given['git-protocol'] === 'string')
      headers['git-protocol'] = given['git-protocol'];
    if (Buffer.isBuffer(body)) headers['content-length'] = String(body.length);
    else if (body && typeof given['content-encoding'] === 'string')
      headers['content-encoding'] = given['content-encoding'];
    return new Promise((resolve, reject) => {
      const up = client.request(
        new URL(path, base),
        { method: r.kind === 'refs' ? 'GET' : 'POST', headers },
        resolve,
      );
      up.on('error', reject);
      if (body === null) up.end();
      else if (Buffer.isBuffer(body)) up.end(body);
      else body.pipe(up);
    });
  };

  /** The upstream's answer, passed back; a refusal or an error is replaced or redacted. */
  const relay = async (
    res: http.ServerResponse,
    up: http.IncomingMessage,
    rewrite?: (b: Buffer) => Buffer | null,
  ): Promise<number> => {
    const status = up.statusCode ?? 502;
    if (status === 401 || status === 403) {
      up.resume();
      answer(res, 502, 'GitHub refused the proxy: its credential is missing a grant, or expired.');
      return 502;
    }
    const headers: Record<string, string> = {};
    for (const h of PASS_BACK)
      if (typeof up.headers[h] === 'string') headers[h] = up.headers[h] as string;
    if (status !== 200 || rewrite) {
      const parts: Buffer[] = [];
      for await (const d of up) parts.push(d as Buffer);
      let body: Buffer = Buffer.concat(parts);
      if (status !== 200) {
        answer(res, status, body.toString('utf8').slice(0, 2000));
        return status;
      }
      const { 'content-encoding': encoding, ...plain } = headers;
      if (encoding === 'gzip') body = gunzipSync(body, { maxOutputLength: maxPush });
      const rewritten = rewrite?.(body) ?? null;
      if (!rewritten) {
        answer(res, 502, 'the upstream did not answer with a ref advertisement');
        return 502;
      }
      res.writeHead(200, { ...plain, 'content-length': String(rewritten.length) });
      res.end(rewritten);
      return 200;
    }
    res.writeHead(200, headers);
    up.pipe(res);
    return 200;
  };

  /**
   * The repo's default branch, from upstream's HEAD symref, or null when it
   * cannot be read. Asked in protocol v0 (no `Git-Protocol` header), whose
   * first line carries `symref=HEAD:<ref>`.
   */
  const defaultBranch = async (req: http.IncomingMessage, repo: string): Promise<string | null> => {
    const r: RepoRequest = { repo, kind: 'refs', service: 'git-upload-pack' };
    const up = await upstream({ 'user-agent': req.headers['user-agent'] }, r, null);
    const parts: Buffer[] = [];
    for await (const d of up) parts.push(d as Buffer);
    if (up.statusCode !== 200) return null;
    let body: Buffer = Buffer.concat(parts);
    if (up.headers['content-encoding'] === 'gzip')
      body = gunzipSync(body, { maxOutputLength: maxPush });
    return headSymref(body);
  };

  /**
   * Null if every update may go; otherwise why not. A delete is refused
   * anywhere; a move other than forward only on the default branch, and on
   * every branch when the default cannot be read.
   */
  const refusePush = async (
    req: http.IncomingMessage,
    repo: string,
    body: Buffer,
  ): Promise<string | null> => {
    const parsed = parseReceivePack(body);
    if (!parsed.ok) return parsed.error;
    for (const u of parsed.updates)
      if (isZero(u.new)) return `deleting ${u.ref} is refused by the proxy`;
    const moves = parsed.updates.filter((u) => !isZero(u.old));
    if (moves.length === 0) return null;
    const head = await defaultBranch(req, repo);
    const guarded = moves.filter((u) => head === null || u.ref === head);
    if (guarded.length === 0) return null;
    const commits = await packCommits(parsed.pack);
    const ancestry = ancestryFor(repo);
    for (const u of guarded)
      if (!(await isFastForward(u.old, u.new, commits, ancestry)))
        return head === null
          ? `${u.ref}: the default branch could not be read, so only a fast-forward is allowed`
          : `${u.ref} is the default branch: only a fast-forward is allowed through the proxy`;
    return null;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const r = parseRepoRequest(req.method ?? '', req.url ?? '');
    if (!r) return answer(res, 404, 'not a smart-HTTP git request for one repo');
    const lead = findLead(opts.leads(), basicPassword(req.headers.authorization));
    if (!lead) {
      log(`401 ${r.repo} ${r.service}: no token, or one no lead holds`);
      return answer(res, 401, 'a lead token is needed', {
        'www-authenticate': 'Basic realm="claude-workspaces git proxy"',
      });
    }
    const who = `${lead.name} ${r.repo} ${r.service}`;
    if (!lead.repos.has(r.repo.toLowerCase())) {
      log(`403 ${who}: not in the lead's githubRepos`);
      return answer(res, 403, `${r.repo} is not in ${lead.name}'s githubRepos`);
    }
    if (r.kind === 'refs') {
      const up = await upstream(req.headers, r, null);
      const status = await relay(res, up, r.service === 'git-receive-pack' ? addNoThin : undefined);
      return log(`${status} ${who} refs`);
    }
    if (r.service === 'git-upload-pack') {
      const up = await upstream(req.headers, r, req);
      return log(`${await relay(res, up)} ${who}`);
    }
    let body = await readBody(req, maxPush);
    if (body === null) {
      log(`413 ${who}: over ${maxPush} bytes`);
      return answer(res, 413, `a push over ${maxPush} bytes is refused`);
    }
    if (req.headers['content-encoding'] === 'gzip')
      body = gunzipSync(body, { maxOutputLength: maxPush });
    const why = await refusePush(req, r.repo, body);
    if (why) {
      log(`403 ${who}: ${why}`);
      return answer(res, 403, why);
    }
    const up = await upstream(req.headers, r, body);
    log(`${await relay(res, up)} ${who}`);
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
