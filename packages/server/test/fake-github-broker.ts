/**
 * A stand-in for the GitHub broker (`~/dev/github-claude-channel/broker.ts`),
 * for tests that must never reach GitHub.
 *
 * The real broker polls GitHub with whatever token it resolves, and an empty
 * `GITHUB_TOKEN` falls back to `gh auth token` — the owner's own. So a test
 * cannot run it. This one answers the same five routes the same way, read off
 * broker.ts as of its #13:
 *
 *  - `POST /register {repos}` → `{id}`, a new in-memory session;
 *  - `POST /watch` and `/unwatch {id, repo}` → `{ok:true}`, or `{ok:false}`
 *    for a session it does not know;
 *  - `POST /poll {id}` → `{events}`, emptied; `{events:[]}` for a session it
 *    does not know — which is why a forgotten session looks like a quiet one;
 *  - `GET /state` → `{sessions:[{id, repos}]}`.
 *
 * Plus one route the real one lacks, `POST /inject {repo, line}`, which
 * queues the line on every session watching the repo, as `deliver` does.
 * Sessions live in the process, so `stop` then `start` on the same port is a
 * broker restart.
 */
export interface FakeBroker {
  port: number;
  url: string;
  /** Queue a line on every session watching `repo`; how many it reached. */
  inject(repo: string, line: string): Promise<number>;
  /** Every live session, as `/state` names them. */
  state(): Promise<Array<{ id: string; repos: string[] }>>;
  stop(): Promise<void>;
}

export function startFakeBroker(port = 0): FakeBroker {
  const sessions = new Map<string, { repos: Set<string>; queue: string[] }>();
  let next = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/state') {
        return Response.json({
          sessions: [...sessions].map(([id, s]) => ({
            id,
            repos: [...s.repos],
            queueDepth: s.queue.length,
          })),
        });
      }
      if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const s = sessions.get(body.id as string);
      switch (path) {
        case '/register': {
          next += 1;
          const id = `s${port}-${next}-${Math.random().toString(36).slice(2, 8)}`;
          const repos = Array.isArray(body.repos) ? (body.repos as string[]) : [];
          sessions.set(id, { repos: new Set(repos), queue: [] });
          return Response.json({ id });
        }
        case '/poll':
          return Response.json({ events: s ? s.queue.splice(0) : [] });
        case '/watch':
          if (!s) return Response.json({ ok: false });
          s.repos.add(body.repo as string);
          return Response.json({ ok: true });
        case '/unwatch':
          if (!s) return Response.json({ ok: false });
          s.repos.delete(body.repo as string);
          return Response.json({ ok: true });
        case '/inject': {
          let reached = 0;
          for (const t of sessions.values()) {
            if (t.repos.has(body.repo as string)) {
              t.queue.push(body.line as string);
              reached += 1;
            }
          }
          return Response.json({ reached });
        }
        default:
          return new Response('Not Found', { status: 404 });
      }
    },
  });
  const actual = server.port as number;
  const url = `http://127.0.0.1:${actual}`;
  return {
    port: actual,
    url,
    async inject(repo, line) {
      const res = await fetch(`${url}/inject`, {
        method: 'POST',
        body: JSON.stringify({ repo, line }),
      });
      return ((await res.json()) as { reached: number }).reached;
    },
    async state() {
      return (
        (await (await fetch(`${url}/state`)).json()) as {
          sessions: Array<{ id: string; repos: string[] }>;
        }
      ).sessions;
    },
    async stop() {
      await server.stop(true);
    },
  };
}
