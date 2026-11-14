import type { D1Database } from '@cloudflare/workers-types';

/**
 * The Worker's bindings. Plain values live in wrangler.jsonc `vars`; the three
 * secrets are set with `wrangler secret put` and, for local runs, in a
 * gitignored `.dev.vars`.
 */
export interface Env {
  DB: D1Database;
  /** The public origin of this Worker, e.g. https://app.example.com. */
  BETTER_AUTH_URL: string;
  /** Secret. Signs session cookies and encrypts tokens: 32+ random bytes. */
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  /** Secret. */
  GOOGLE_CLIENT_SECRET: string;
  /** Public. The page's Turnstile widget uses it. */
  TURNSTILE_SITE_KEY: string;
  /** Secret. */
  TURNSTILE_SECRET_KEY: string;
  /** "log" prints mail to the Worker log. For local development only. */
  MAIL_TRANSPORT?: string;
}
