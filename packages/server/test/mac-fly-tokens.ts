/**
 * Give the tests' "Mac" the per-app Fly tokens fly-ci-tokens.yml would have
 * handed it (`infra/handoff/mac-store.ts`), in a temp handoff folder named by
 * CW_HANDOFF_DIR. With them `mac-ops.fly()` runs a command naming one of the
 * apps without an org token and without pulling. Returns the restore.
 */
import { join } from 'node:path';
import { storeAppToken } from '../../../infra/handoff/mac-store.ts';

export function giveMacFlyTokens(tmp: string, apps: readonly string[]): () => void {
  const saved = {
    dir: process.env.CW_HANDOFF_DIR,
    token: process.env.FLY_API_TOKEN,
  };
  const dir = join(tmp, 'handoff');
  const notAfter = Math.floor(Date.now() / 1000) + 14 * 86_400;
  for (const app of apps) storeAppToken(dir, app, { token: `fm2_fixture_${app}`, notAfter });
  process.env.CW_HANDOFF_DIR = dir;
  Reflect.deleteProperty(process.env, 'FLY_API_TOKEN');
  return () => {
    for (const [name, value] of [
      ['CW_HANDOFF_DIR', saved.dir],
      ['FLY_API_TOKEN', saved.token],
    ] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
}
