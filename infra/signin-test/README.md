# The sign-in test app

The sign-in template (`templates/signin`) deployed for real at
https://signin-test.fryanpan.com, so a person can sign in by password, magic
link or Google, and so CI proves after every deploy that each one works.
Everything is made from CI; nobody runs a step by hand after the one-time
`cf:app-secrets apply`.

## What it is

| Path | What it is |
| --- | --- |
| `src/worker.ts` | The Worker: the template's app, unchanged, with Resend as its mail transport |
| `src/live-app.ts` | Adds the sign-in page at `/` and the smoke gate |
| `src/page.ts` | The sign-in page: password, magic link, Google, one file |
| `src/smoke-gate.ts` | The smoke test's one way past Turnstile (below) |
| `deploy.ts` | Puts it live, in order, from CI |
| `resend.ts` | The Resend calls: sending domain, its records, verification, the app's send-only key |
| `smoke.ts` | The checks run against the live app after each deploy |
| `../cloudflare/apps/signin-test/` | Its Terraform root: D1, Turnstile, the custom domain, the mail DNS records |
| `../../.github/workflows/signin-test.yml` | `workflow_dispatch` on main, in the `cloudflare-prod` environment |

## Putting it live

1. Once, on the Mac: `GITHUB_TOKEN=… bun run cf:app-secrets apply`
   (`infra/cloudflare/README.md`, "Apps' secrets"). It reads
   `resend-api-key`, `signin-test-google-client-id` and
   `signin-test-google-client-secret` from the Keychain, plain or as the
   board's secret card, and writes them to `cloudflare-prod` as
   `RESEND_API_KEY`, `SIGNIN_TEST_GOOGLE_CLIENT_ID` and
   `SIGNIN_TEST_GOOGLE_CLIENT_SECRET`. The deploy token must already hold D1
   Write and Turnstile Sites Write (`CF_APPLY_PERMISSIONS` in
   `packages/server/src/keeper/keeper-setup-ci.ts`).
2. Dispatch `signin-test` on main: `gh workflow run signin-test.yml --ref main`.

The run (`deploy.ts`):

1. Finds or makes the Resend domain `mail.fryanpan.com` and reads the DNS
   records it needs. A record that would land outside that subdomain stops
   the run, so the root domain's MX, SPF and DMARC are never touched.
2. Applies `infra/cloudflare/apps/signin-test` with the deploy token: the D1
   database, the Turnstile widget, a placeholder Worker the first time, the
   custom domain `signin-test.fryanpan.com`, and the mail records. Its state
   is `cloudflare/signin-test.tfstate` in the R2 state bucket.
3. Sets the Worker's secrets through the Cloudflare API: the Google client
   id and secret, the Turnstile secret, a session secret made the first time
   only, and a send-only Resend key for `mail.fryanpan.com`, made the first
   time only (or again when the run's `rotate_mail_key` input is ticked,
   which deletes the older one).
4. Applies the template's D1 migrations and deploys the Worker with wrangler.
5. Asks Resend to verify the domain and waits up to ten minutes. On the
   first run the DNS records are minutes old; if Resend has not verified them
   by then, the run fails and says so, and the next dispatch carries on.
6. Runs `smoke.ts` against https://signin-test.fryanpan.com.

## The smoke test

It checks that `/health` and the page answer, that a sign-in without a
Turnstile token is refused, and that Google's start redirect goes to
accounts.google.com with the configured client id and the redirect URI
`https://signin-test.fryanpan.com/api/auth/callback/google`. It does not sign
in to Google. Then it signs up by password, checks that a wrong password and
an unverified address are refused, follows the verification mail, signs in,
and signs in again by magic link.

Its addresses are `delivered+<run>-…@resend.dev`, Resend's test inbox, which
accepts mail and delivers it nowhere. It reads each link back with Resend's
list and retrieve endpoints, using the full-access key.

A script cannot pass a live Turnstile widget, so the Worker has one narrow
exception (`src/smoke-gate.ts`). A request carrying the Worker's `SMOKE_KEY`
is checked against Cloudflare's published always-pass test secret instead of
the widget's. It applies only to sign-up, password sign-in and magic-link
requests for a `resend.dev` address. The key is 32 random bytes made by the
run, set just before the smoke and deleted just after it, pass or fail, so
between deploys the Worker has none and the exception is closed.

## The Google client

The OAuth client in Google Cloud must list the redirect URI above. That is
the one step outside this repo; the smoke test fails on a client id that
does not match, but only a person's sign-in shows a missing redirect URI.
