# Sign-in template

A Cloudflare Worker that gives a new app public sign-up and sign-in. It runs
[Hono](https://hono.dev/) and [Better Auth](https://better-auth.com/), and
keeps users, sessions and rate-limit counts in [D1](https://developers.cloudflare.com/d1/).

People can sign in four ways: password, magic link, Google, or by being
registered by an admin or an admin's agent. Password sign-in, sign-up,
magic links and password-reset requests sit behind Turnstile and two rate
limits.

## Copy it into a new app

1. Copy this folder into the new repository, including `migrations/` and
   `test/`. It does not depend on anything else in this repo.
2. Run `bun install` (or `npm install`). The versions are pinned.
3. Create the database with `wrangler d1 create <name>`, then put its id in
   `wrangler.jsonc` in place of `REPLACE_ME_D1_DATABASE_ID`. Rename `name`
   and `database_name` too.
4. Replace the other `REPLACE_ME` values in `wrangler.jsonc`, and set the
   three secrets with `wrangler secret put` (see the config table below).
5. Wire a mail provider in `src/mail.ts`. Until you do, a deployed Worker
   refuses to send mail instead of dropping it silently.
6. Apply the migrations with `wrangler d1 migrations apply DB --remote`.
7. Make the first admin (see below).

To run it on your machine, copy `.dev.vars.example` to `.dev.vars`, then run
`bun run db:migrate:local` and `bun run dev`. `MAIL_TRANSPORT=log` prints
every mail, link included, to the terminal. Turn off wrangler's usage
metrics with `wrangler telemetry disable` if you want a run that sends
nothing to Cloudflare.

## Config

| Name | Kind | What it is |
| --- | --- | --- |
| `DB` | D1 binding | The database. `migrations/` creates its tables. |
| `BETTER_AUTH_URL` | var | The Worker's public origin, such as `https://app.example.com`. It is the only origin Better Auth trusts. |
| `BETTER_AUTH_SECRET` | secret | 32 or more random bytes. Signs session cookies and encrypts stored tokens. |
| `GOOGLE_CLIENT_ID` | var | From a Google Cloud OAuth client. Its redirect URI is `<BETTER_AUTH_URL>/api/auth/callback/google`. |
| `GOOGLE_CLIENT_SECRET` | secret | From the same OAuth client. |
| `TURNSTILE_SITE_KEY` | var | Public. The sign-in page's Turnstile widget uses it. |
| `TURNSTILE_SECRET_KEY` | secret | The Worker checks each Turnstile token with it. |
| `MAIL_TRANSPORT` | var, optional | Set to `log` for local runs only. |

Secrets never go in `wrangler.jsonc` or in git. `.dev.vars` is gitignored.

## What the front end does

- Every Better Auth route is under `/api/auth/`. The Better Auth client
  (`better-auth/client`) calls them for you.
- The four Turnstile-guarded routes are `/sign-up/email`, `/sign-in/email`,
  `/sign-in/magic-link` and `/request-password-reset`. Each one needs the
  widget's token in an `x-captcha-response` header. A request with no token
  gets a 400, and a token that fails the check gets a 403.
- "Sign out everywhere" is `POST /api/auth/revoke-sessions`. It ends every
  session that person has.
- A person has to verify their email before they can sign in with a
  password. Sign-up sends the verification link.

## Rate limits

They are counted in D1, so every Worker isolate sees the same counts. Better
Auth's own limiter is turned off because it counts in memory, separately in
each isolate.

- **20 auth requests per minute per IP.** The IP comes from the
  `CF-Connecting-IP` header, which Cloudflare sets on every request and a
  client cannot override. Behind any other proxy, read the IP from a header
  that proxy controls instead.
- **3 attempts per email address per 15 minutes**, counted together across
  the four routes above. A legitimate person who signs up, signs in, asks for
  a reset and then signs in again uses four, so the last one waits. To count
  each route separately, add the route path to the key in `src/app.ts`.

A refused request gets a 429 with a `Retry-After` header. Refused attempts
are not counted, so hammering a locked address does not extend its lockout.
`src/rate-limit.ts` explains why the check and the write are one statement:
D1 has no interactive transactions.

## Linking sign-in methods

If someone who already has an account signs in with Google under the same
email address, the Google sign-in joins that person only when both of these
hold:

- Google says the email is verified.
- The existing account has already verified the email.

Otherwise the sign-in is refused with `account_not_linked`. The second rule
stops this attack: someone signs up with your address and a password of
their choosing, never verifies it, and waits for you to sign in with Google.
Without the rule, your Google sign-in would join the account whose password
they know.

## Admins and agents

Make the first admin with one SQL statement after that person has signed up:

```bash
wrangler d1 execute DB --remote --command "UPDATE user SET role = 'admin' WHERE email = 'alice@example.com'"
```

- `POST /api/agent-keys` (admin session only) creates an API key whose only
  permission is `users:create`. The response shows the key once; the
  database stores only its hash.
- `POST /api/users` with `{ email, name, password? }` registers a plain user.
  An admin can call it with their session, and an agent can call it with
  that key in an `x-api-key` header. Anyone else gets a 403, as does a key
  without the permission or a key whose owner is no longer an admin.
- A key never gives the agent a session, so it reaches nothing but
  `/api/users`.
- Each key may make 10 requests a day, Better Auth's API-key default. The
  11th gets a 429. To change it, pass `rateLimitMax` and
  `rateLimitTimeWindow` where `/api/agent-keys` creates the key.

## Schema changes

Better Auth's CLI cannot reach D1, so `bun run db:auth-sql` prints the SQL
for the current `src/auth.ts` config, run against an empty local D1. When you
add a Better Auth plugin:

1. Run `bun scripts/auth-schema-sql.ts --apply-existing`. With that flag it
   prints only the new tables and columns.
2. Save the output as the next numbered file in `migrations/`.

`test/schema.test.ts` fails while the migrations and the config disagree.

## Tests

`bun run test` runs everything locally, in about ten seconds. The app runs in
Node against an in-memory D1 that workerd provides through wrangler. A local
HTTP stub stands in for Google's token and userinfo endpoints and for
Turnstile's siteverify. The stub answers the way Cloudflare does for its
published test secrets, one that always passes and one that always fails.
Mail is captured in memory, and an injected clock moves the rate-limit
windows without sleeping. `test/worker.test.ts` also bundles `src/index.ts`
and runs it in workerd, which catches a dependency that only breaks on the
Workers runtime.

Nothing in the tests calls Cloudflare, Google or a mail service.

## Deliberately left out

- **A mail provider.** Wire yours in `src/mail.ts`.
- **Sign-in pages.** This is the API. Build the pages in your app with the
  Better Auth client and the Turnstile widget.
- **Passkeys, two-factor, organisations and other Better Auth plugins.** Add
  them in `src/auth.ts`, then write a migration as described above.
- **Better Auth's in-Worker migration route.** Tables come from Wrangler
  migrations, so there is no route that can change the schema.
- **Session caching in KV.** Each session check reads D1. Add Better Auth's
  `secondaryStorage` if that becomes a cost.
- **Sign-up limits beyond the two rate limits**, such as an allowlist of
  domains or closed registration. Better Auth's `disableSignUp` turns public
  sign-up off.
