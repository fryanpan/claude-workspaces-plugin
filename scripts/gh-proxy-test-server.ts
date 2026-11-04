/**
 * For `gh-proxy-wall.test.ts`: the gh proxy and a stand-in for
 * api.github.com, in a process of their own, because the test runs gh and
 * the `--check` rows with `spawnSync`, which would stop a proxy in the
 * test's own process from answering. Every request the stand-in gets is
 * appended to `GHP_SEEN` as a line of JSON; it prints `ready` once the
 * socket listens.
 *
 *   GHP_SOCKET=<path> GHP_CREDENTIAL=<fake> GHP_LEADS=<json> GHP_SEEN=<file> bun scripts/gh-proxy-test-server.ts
 */
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGhProxy } from './gh-proxy-server.ts';
import type { ProxyLead } from './git-proxy-lead.ts';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

const leads = new Map<string, ProxyLead>(
  (
    JSON.parse(env('GHP_LEADS')) as { token: string; name: string; repos: string[]; gh: boolean }[]
  ).map((l) => [l.token, { name: l.name, repos: new Set(l.repos), gh: l.gh }]),
);

const api = http.createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on('data', (d: Buffer) => parts.push(d));
  req.on('end', () => {
    const body = Buffer.concat(parts).toString('utf8');
    appendFileSync(
      env('GHP_SEEN'),
      `${JSON.stringify({ method: req.method, url: req.url, authorization: req.headers.authorization })}\n`,
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      body.includes('PullRequestByNumber')
        ? JSON.stringify({
            data: { repository: { pullRequest: { number: 5, title: 'Riverbend' } } },
          })
        : JSON.stringify({ answered: req.url }),
    );
  });
});

api.listen(0, '127.0.0.1', () => {
  const proxy = createGhProxy({
    credential: env('GHP_CREDENTIAL'),
    api: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    leads: () => leads,
    log: () => {},
  });
  proxy.listen(env('GHP_SOCKET'), () => process.stdout.write('ready\n'));
});
// Stops by itself if the test that started it never does.
setTimeout(() => process.exit(0), 180_000).unref();
