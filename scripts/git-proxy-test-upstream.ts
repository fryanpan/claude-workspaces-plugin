/**
 * A stand-in for GitHub, for `git-proxy.test.ts`: bare repos served over
 * smart HTTP by `git http-backend`, the compare API answered from the same
 * repos, and every request recorded. It refuses any request that does not
 * carry the fake credential it was started with.
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

export interface FakeGithub {
  url: string;
  seen: Recorded[];
  close(): Promise<void>;
}

const BACKEND = join(
  spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim(),
  'git-http-backend',
);

function readAll(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function cgi(root: string, req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://upstream.invalid');
  const child = spawn(BACKEND, [], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      REMOTE_USER: 'upstream-owner',
      REQUEST_METHOD: req.method ?? 'GET',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.replace(/^\?/, ''),
      CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
      CONTENT_LENGTH: String(body.length),
      HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
      HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
    },
  });
  const out: Buffer[] = [];
  child.stdout.on('data', (d: Buffer) => out.push(d));
  child.stderr.resume();
  // http-backend can exit before it reads the whole body (a refused or no-op
  // push), and the write then fails with EPIPE; the response is still on stdout.
  child.stdin.on('error', () => {});
  child.stdin.end(body);
  child.on('close', () => {
    const all = Buffer.concat(out);
    let split = all.indexOf('\r\n\r\n');
    let gap = 4;
    if (split < 0) {
      split = all.indexOf('\n\n');
      gap = 2;
    }
    const head = all.subarray(0, Math.max(split, 0)).toString('utf8');
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      const name = line.slice(0, at).trim().toLowerCase();
      const value = line.slice(at + 1).trim();
      if (name === 'status') status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.end(all.subarray(split + gap));
  });
}

function compare(root: string, path: string, res: http.ServerResponse) {
  const m = /^\/api\/repos\/([^/]+)\/([^/]+)\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(path);
  if (!m) {
    res.writeHead(404).end();
    return;
  }
  const gitDir = join(root, m[1] as string, `${m[2]}.git`);
  const git = (...args: string[]) => spawnSync('git', ['--git-dir', gitDir, ...args]).status;
  const [base, head] = [m[3] as string, m[4] as string];
  if (
    git('cat-file', '-e', `${base}^{commit}`) !== 0 ||
    git('cat-file', '-e', `${head}^{commit}`) !== 0
  ) {
    res.writeHead(404).end('{"message":"Not Found"}');
    return;
  }
  const status =
    base === head
      ? 'identical'
      : git('merge-base', '--is-ancestor', base, head) === 0
        ? 'ahead'
        : git('merge-base', '--is-ancestor', head, base) === 0
          ? 'behind'
          : 'diverged';
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status }));
}

/**
 * Serve `root/<owner>/<name>.git`. A repo named `echo` answers every request
 * with a 500 whose body repeats the request's Authorization header, so a
 * test can prove the proxy strips it.
 */
export function startFakeGithub(root: string, credential: string): Promise<FakeGithub> {
  const seen: Recorded[] = [];
  const basic = `Basic ${Buffer.from(`x-access-token:${credential}`).toString('base64')}`;
  const server = http.createServer(async (req, res): Promise<void> => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const body = await readAll(req);
    const path = new URL(req.url ?? '/', 'http://upstream.invalid').pathname;
    if (path.startsWith('/api/')) {
      if (req.headers.authorization !== `Bearer ${credential}`) res.writeHead(401).end();
      else compare(root, path, res);
    } else if (req.headers.authorization !== basic) res.writeHead(401).end('bad credentials');
    else if (path.includes('/echo.git/'))
      res
        .writeHead(500, { 'content-type': 'text/plain' })
        .end(`upstream saw ${req.headers.authorization} (${credential})`);
    else cgi(root, req, body, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
