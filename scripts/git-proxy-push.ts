/**
 * Whether a pushed ref update is a fast-forward, for the GitHub proxy.
 *
 * The client's old sha cannot decide it: git sends the ref's current value
 * as old for a force-push too. So the proxy asks whether old is an ancestor
 * of new. The new commits are not on GitHub yet, so it reads them from the
 * pushed pack (whole, since the proxy advertised `no-thin`), walks from new
 * down to the commits GitHub already has, and asks GitHub's compare API
 * whether each of those descends from old. Anything it cannot read is
 * refused.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Whether `old` is an ancestor of (or equal to) `commit`, as the upstream knows them. */
export type Ancestry = (old: string, commit: string) => Promise<boolean>;

function run(
  args: string[],
  cwd: string,
  input?: Buffer | string,
): Promise<{ status: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    child.on('error', (e) => resolve({ status: null, stdout: Buffer.alloc(0), stderr: e.message }));
    child.on('close', (status) => resolve({ status, stdout: Buffer.concat(out), stderr: err }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** Each commit in the pack, with its parents. An empty pack has none. */
export async function packCommits(pack: Buffer): Promise<Map<string, string[]>> {
  const commits = new Map<string, string[]>();
  if (pack.length === 0) return commits;
  const dir = mkdtempSync(join(tmpdir(), 'git-proxy-pack-'));
  try {
    const init = await run(['init', '--bare', '-q', '.'], dir);
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
    const index = await run(['index-pack', '--stdin'], dir, pack);
    if (index.status !== 0)
      throw new Error(`the pushed pack could not be read on its own: ${index.stderr.trim()}`);
    const list = await run(
      ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'],
      dir,
    );
    const shas = list.stdout
      .toString('utf8')
      .split('\n')
      .filter((l) => l.endsWith(' commit'))
      .map((l) => l.split(' ')[0] as string);
    if (shas.length === 0) return commits;
    const batch = await run(['cat-file', '--batch'], dir, `${shas.join('\n')}\n`);
    let at = 0;
    const buf = batch.stdout;
    while (at < buf.length) {
      const nl = buf.indexOf(10, at);
      if (nl < 0) break;
      const [sha, , size] = buf.toString('utf8', at, nl).split(' ');
      const len = Number(size);
      if (!Number.isFinite(len)) break;
      const body = buf.toString('utf8', nl + 1, nl + 1 + len);
      at = nl + 1 + len + 1;
      const parents: string[] = [];
      for (const line of body.split('\n')) {
        if (line === '') break;
        if (line.startsWith('parent ')) parents.push(line.slice(7));
      }
      if (sha) commits.set(sha, parents);
    }
    return commits;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether moving a ref from `old` to `neu` loses no commit. Walks from `neu`
 * through the pushed commits; every commit it reaches that the pack does
 * not hold is one the upstream has, and `ancestry` is asked about it. Old
 * reached on the way decides it at once.
 */
export async function isFastForward(
  old: string,
  neu: string,
  commits: Map<string, string[]>,
  ancestry: Ancestry,
): Promise<boolean> {
  if (old === neu) return true;
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const stack = [neu];
  while (stack.length > 0) {
    const c = stack.pop() as string;
    if (seen.has(c)) continue;
    seen.add(c);
    if (c === old) return true;
    const parents = commits.get(c);
    if (parents) stack.push(...parents);
    else boundary.add(c);
  }
  for (const b of boundary) if (await ancestry(old, b)) return true;
  return false;
}

/**
 * GitHub's answer, from `GET /repos/{repo}/compare/{old}...{commit}`:
 * `ahead` or `identical` means old is an ancestor. Any other status, or any
 * failure, is no.
 */
export function githubAncestry(
  api: string,
  repo: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Ancestry {
  return async (old, commit) => {
    const url = `${api.replace(/\/+$/, '')}/repos/${repo}/compare/${old}...${commit}?per_page=1`;
    try {
      const res = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'claude-workspaces-git-proxy',
        },
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { status?: unknown };
      return json.status === 'ahead' || json.status === 'identical';
    } catch {
      return false;
    }
  };
}
