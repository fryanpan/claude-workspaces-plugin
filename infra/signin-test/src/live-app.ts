import { type AppOptions, createApp } from '../../../templates/signin/src/app.ts';
import type { Env } from '../../../templates/signin/src/env.ts';
import { signInPage } from './page.ts';
import { TURNSTILE_TEST_PASS_SECRET, isSmokeRequest } from './smoke-gate.ts';

/**
 * The sign-in test app: the template's Worker, unchanged, plus a sign-in page
 * at `/` and the deploy smoke's narrow way past Turnstile (`smoke-gate.ts`).
 */
export interface LiveEnv extends Env {
  /** Set only while a deploy's smoke test runs. */
  SMOKE_KEY?: string;
}

type Ctx = Parameters<ReturnType<typeof createApp>['fetch']>[2];

export function createLiveApp(options: AppOptions) {
  const app = createApp(options);
  // One substitute bindings object per real one, so createApp builds the
  // smoke's Better Auth instance once per isolate, as it does the real one.
  const smokeEnvs = new WeakMap<LiveEnv, LiveEnv>();
  const smokeEnvOf = (env: LiveEnv): LiveEnv => {
    let e = smokeEnvs.get(env);
    if (!e) {
      e = { ...env, TURNSTILE_SECRET_KEY: TURNSTILE_TEST_PASS_SECRET };
      smokeEnvs.set(env, e);
    }
    return e;
  };

  return {
    async fetch(req: Request, env: LiveEnv, ctx?: Ctx): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/') {
        return new Response(signInPage(env.TURNSTILE_SITE_KEY), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy':
              "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
            'cache-control': 'no-store',
          },
        });
      }
      const use = (await isSmokeRequest(req, env.SMOKE_KEY)) ? smokeEnvOf(env) : env;
      return app.fetch(req, use, ctx);
    },
  };
}
