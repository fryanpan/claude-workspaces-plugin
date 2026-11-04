/**
 * The deploy's `make-push-keys` step: ask the keeper to make the project's
 * push deploy keys (`packages/server/src/keeper/keeper-push-keys.ts`).
 *
 * The keeper holds the GitHub token that registers each key, makes each key
 * pair, and sets the private halves on the app as `CW_GITHUB_PUSH_KEYS`, so
 * neither the token nor a private half passes through this process. Without
 * a keeper (`CW_KEEPER_URL`) the step refuses: there is no other place that
 * holds the token and may run it.
 */
import { KEEPER_URL_ENV, keeperPushKeys } from '../../packages/server/src/keeper/keeper-client.ts';

export async function makePushKeysThroughKeeper(
  app: string,
  repos: readonly string[],
  ask: typeof keeperPushKeys = keeperPushKeys,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const origin = env[KEEPER_URL_ENV]?.trim();
  if (!origin) {
    throw new Error(
      `push deploy keys are made by the keeper, which holds the GitHub token; set ${KEEPER_URL_ENV} (docs/process/keeper.md)`,
    );
  }
  const r = await ask(origin, app, repos, {
    requester: `machine:deploy push keys for ${app}`,
    onHeld: (h) => console.log(`[deploy] approve with your passkey: ${h.approveUrl}`),
  });
  let body: { error?: string; keys?: { repo: string; id: number }[]; retired?: string[] } = {};
  try {
    body = JSON.parse(r.body);
  } catch {}
  if (r.status !== 200) {
    throw new Error(`the keeper made no push keys for ${app}: ${body.error ?? r.status}`);
  }
  return [
    ...(body.keys ?? []).map((k) => `${k.repo}: write deploy key ${k.id}`),
    ...(body.retired ?? []).map((k) => `${k}: older key removed`),
  ];
}
