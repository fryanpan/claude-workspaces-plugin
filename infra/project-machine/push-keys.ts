/**
 * The deploy's `make-push-keys` step: one write deploy key per repo for the
 * project's server, made in fly-provision.yml's `fly-org` job.
 *
 * That job holds the two credentials it needs: GITHUB_TOKEN (the environment's
 * GH_ADMIN_TOKEN, a classic token with `repo` scope) registers each public
 * half, and the org token sets the private halves on the app as
 * `CW_GITHUB_PUSH_KEYS`. Each pair is made in memory (`ed25519Pair`); a
 * private half goes to that Fly secret and nowhere else, and a failed run
 * deletes every key it registered (`makePushKeys` in
 * `packages/server/src/keeper/keeper-push-keys.ts`, the function the keeper
 * ran, run here as it is).
 *
 * Its lines also name, per repo, the Actions secret names a workflow pushed
 * with the new key could read (`keeper-push-exposure.ts`), names only.
 */
import { isRepoName } from '../../packages/server/src/git-push/policy.ts';
import { exposureLines } from '../../packages/server/src/keeper/keeper-push-exposure.ts';
import {
  type GithubApi,
  MAX_PUSH_REPOS,
  type PushKeysDeps,
  ed25519Pair,
  makePushKeys as makeAndRegister,
} from '../../packages/server/src/keeper/keeper-push-keys.ts';
import { fly } from './mac-ops.ts';

/** GitHub's REST API with one token, under https://api.github.com. */
export function githubApi(token: string, fetchImpl: typeof fetch = fetch): GithubApi {
  return async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.text() };
  };
}

function realDeps(env: Record<string, string | undefined>): PushKeysDeps {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'push deploy keys need GITHUB_TOKEN, which fly-provision.yml takes from the fly-org environment (GH_ADMIN_TOKEN)',
    );
  }
  return {
    github: githubApi(token),
    keygen: async (comment) => ed25519Pair(comment),
    fly: async (args, input) => fly(args, input === undefined ? {} : { input }),
  };
}

/** Make, register and set the keys; the lines to print. Throws when nothing was set. */
export async function makePushKeys(
  app: string,
  repos: readonly string[],
  deps?: PushKeysDeps,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  if (repos.length === 0 || repos.length > MAX_PUSH_REPOS) {
    throw new Error(`push keys need 1-${MAX_PUSH_REPOS} repos`);
  }
  if (!repos.every(isRepoName)) throw new Error('every push repo must be owner/name');
  const r = await makeAndRegister(deps ?? realDeps(env), app, repos);
  let body: {
    error?: string;
    keys?: { repo: string; id: number }[];
    retired?: string[];
    exposure?: unknown;
  } = {};
  try {
    body = JSON.parse(r.body);
  } catch {}
  if (r.status !== 200) throw new Error(`no push keys for ${app}: ${body.error ?? r.status}`);
  return [
    ...(body.keys ?? []).map((k) => `${k.repo}: write deploy key ${k.id}`),
    ...(body.retired ?? []).map((k) => `${k}: older key removed`),
    ...(Array.isArray(body.exposure) ? exposureLines(body.exposure) : []),
  ];
}
