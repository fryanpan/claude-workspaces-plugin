/**
 * The git the push runs, in a bare repository the server owns, one per
 * upstream repo (`<dataDir>/git-push/repos/`). Nothing here runs git in a
 * folder a lead can write: the lead's commits arrive as a bundle, which git
 * reads as objects and refs only.
 *
 * Every call takes `git-hardening.ts`'s arguments and environment (no system
 * or global config, no inherited `GIT_*`), and the calls that reach upstream
 * allow one protocol, the remote's own. The credential goes to git as an
 * `http.<url>.extraheader` setting in the child's environment, never as an
 * argument: any user on the machine can read any process's arguments.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { hardenedGitArgs, hardenedGitEnv } from '../git-hardening.ts';

export interface GitCall {
  args: string[];
  env: Record<string, string>;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git. Injected so a test can record every call; the default is real git. */
export type GitRunner = (call: GitCall) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 120_000;

export const realGit: GitRunner = async ({ args, env }) => {
  const proc = Bun.spawn(['git', ...args], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

/** The `Authorization` header GitHub takes for a token over https. */
export function basicAuthHeader(token: string): string {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

/** `text` with the token, and the header form of it, replaced. */
export function redact(text: string, token: string | null): string {
  if (!token) return text;
  const header = basicAuthHeader(token).slice('Authorization: Basic '.length);
  return text.split(token).join('[credential]').split(header).join('[credential]');
}

export interface Upstream {
  url: string;
  token: string;
}

/** The scheme git may use for `url`, or null for one it may not. */
function schemeOf(url: string): string | null {
  const m = /^(https|file):\/\//.exec(url);
  return m ? (m[1] ?? null) : null;
}

export class ScratchRepo {
  constructor(
    readonly gitDir: string,
    private readonly run: GitRunner,
  ) {}

  private env(upstream?: Upstream): Record<string, string> {
    const env = hardenedGitEnv();
    env.GIT_TERMINAL_PROMPT = '0';
    if (upstream) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = `http.${upstream.url}.extraheader`;
      env.GIT_CONFIG_VALUE_0 = basicAuthHeader(upstream.token);
    }
    return env;
  }

  /** git with this repo, hardened; `upstream` adds the credential and one protocol. */
  async git(args: string[], upstream?: Upstream): Promise<GitResult> {
    const proto: string[] = [];
    if (upstream) {
      const scheme = schemeOf(upstream.url);
      if (!scheme) return { code: 128, stdout: '', stderr: 'remote scheme not allowed' };
      proto.push('-c', 'protocol.allow=never', '-c', `protocol.${scheme}.allow=always`);
    }
    return this.run({
      args: hardenedGitArgs([...proto, `--git-dir=${this.gitDir}`, ...args]),
      env: this.env(upstream),
    });
  }

  async ensure(): Promise<boolean> {
    if (existsSync(this.gitDir)) return true;
    mkdirSync(this.gitDir, { recursive: true, mode: 0o700 });
    const r = await this.run({
      args: hardenedGitArgs(['init', '--bare', '--quiet', this.gitDir]),
      env: this.env(),
    });
    return r.code === 0;
  }

  /**
   * Upstream's default branch and the tip of `branch` there (null when the
   * branch does not exist yet). Null when upstream cannot be read.
   */
  async upstreamState(
    upstream: Upstream,
    branch: string,
  ): Promise<{ defaultBranch: string; tip: string | null } | { error: string }> {
    const r = await this.git(
      ['ls-remote', '--symref', upstream.url, 'HEAD', `refs/heads/${branch}`],
      upstream,
    );
    if (r.code !== 0) return { error: lastLine(r.stderr) };
    const head = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout);
    if (!head?.[1]) return { error: 'upstream names no default branch' };
    const tip = new RegExp(`^([0-9a-f]{40})\\trefs/heads/${escape(branch)}$`, 'm').exec(r.stdout);
    return { defaultBranch: head[1], tip: tip?.[1] ?? null };
  }

  /** Fetch upstream's `branch` into `refs/up/<branch>` here. */
  async fetchUpstream(upstream: Upstream, branch: string): Promise<GitResult> {
    return this.git(
      ['fetch', '--quiet', '--no-tags', upstream.url, `+refs/heads/${branch}:refs/up/${branch}`],
      upstream,
    );
  }

  /** The refs a bundle carries, as `[sha, ref]` pairs; null for a file that is not one. */
  async bundleHeads(bundle: string): Promise<[string, string][] | null> {
    const r = await this.git(['bundle', 'list-heads', bundle]);
    if (r.code !== 0) return null;
    const out: [string, string][] = [];
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      const m = /^([0-9a-f]{40}) (\S+)$/.exec(line);
      if (!m?.[1] || !m[2]) return null;
      out.push([m[1], m[2]]);
    }
    return out;
  }

  /** Whether every commit the bundle builds on is already here. */
  async bundleApplies(bundle: string): Promise<boolean> {
    return (await this.git(['bundle', 'verify', '--quiet', bundle])).code === 0;
  }

  /** Bring the bundle's `ref` in as `refs/incoming/<id>`. */
  async fetchBundle(bundle: string, ref: string, id: string): Promise<boolean> {
    const r = await this.git([
      'fetch',
      '--quiet',
      '--no-tags',
      bundle,
      `+${ref}:refs/incoming/${id}`,
    ]);
    return r.code === 0;
  }

  async isAncestor(older: string, newer: string): Promise<boolean> {
    return (await this.git(['merge-base', '--is-ancestor', older, newer])).code === 0;
  }

  /** Commit subjects in `base..tip`, newest first, at most `max`. */
  async subjects(base: string | null, tip: string, max: number): Promise<string[]> {
    const range = base ? `${base}..${tip}` : tip;
    const r = await this.git(['log', '--format=%s', `--max-count=${max}`, range]);
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  }

  /** Push `sha` to `refs/heads/<branch>`: no `+`, no `--force`, so upstream
   *  refuses anything but a fast-forward or a new branch. */
  async push(upstream: Upstream, sha: string, branch: string): Promise<GitResult> {
    return this.git(
      ['push', '--porcelain', '--no-verify', upstream.url, `${sha}:refs/heads/${branch}`],
      upstream,
    );
  }

  async dropIncoming(id: string): Promise<void> {
    await this.git(['update-ref', '-d', `refs/incoming/${id}`]);
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return (lines[lines.length - 1] ?? '').slice(0, 300);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
