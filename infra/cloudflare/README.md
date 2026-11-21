# Cloudflare, in Terraform

Every Cloudflare resource this repo configures is declared here, so a change
is one reviewed plan and one apply instead of a script per surface. Only CI
applies (`.github/workflows/cloudflare.yml`): it plans every pull request and
applies when one merges to main, with nobody at a terminal. The merge is the
approval.

```bash
bun run cf:plan              # prod: reads the account, prints what would change, changes nothing
bun run cf:plan staging      # the same for staging
bun run cf:sync-config       # writes the router and share-link configs to CI and starts an apply
bun run cf:rotate-token NAME # dispatches cf-rotate-token.yml: a new secret for one service token
bun run cf:ci-secrets plan    # CI's deploy token and GitHub secrets: what would change
bun run cf:ci-secrets apply   # make the token and write the secrets ("CI's credentials" below)
bun run cf:app-secrets apply  # apps' secrets in cloudflare-prod; a GitHub token alone ("Apps' secrets" below)
bun run fly:ci-tokens apply   # one Fly token per app; runs in fly-ci-tokens.yml, which holds the org token
bun run handoff:pull         # stores what a workflow sealed to the Mac: service-token pairs, Fly app tokens
```

`bun run cf:apply` only prints where applies run now, and changes nothing.

## Layout

| Path | What it is |
| --- | --- |
| `modules/access` | One Access application per project, its people policy, its service-token policy, and every service token a project names |
| `modules/router-worker` | The board router Worker, a route and a proxied AAAA `100::` per project hostname |
| `modules/share-link` | The share-link Worker and its `/share/*` routes |
| `modules/tunnel` | Each project machine's tunnel, its ingress, its origin CNAME, and its token (read back) |
| `modules/stack` | The four wired together, plus the Access team domain (read back) |
| `deploys/prod` | Prod's root, and `imports.tf`, which adopts what already exists |
| `deploys/staging` | Staging's root: the same modules, no imports. Validated on every run, never applied yet |
| `ci-secrets` | CI's deploy token, and the GitHub Actions secrets that carry it. Local state, applied by hand ("CI's credentials") |
| `app-secrets` | The secrets apps' workflows read from `cloudflare-prod` (the GitHub provider alone). Local state, applied by hand ("Apps' secrets") |
| `fly-ci` | One GitHub Environment per Fly app CI deploys, main-only, each holding a token for that app alone (the GitHub provider alone). Local state, applied by `fly:ci-tokens` ("Fly's CI tokens") |
| `apps/signin-test` | One app's own root: the sign-in test app's D1, Turnstile widget, custom domain and mail DNS records. Applied by its own workflow ("An app's own root") |

The layout is HashiCorp's standard module structure. Each module has
`main.tf`, `variables.tf`, `outputs.tf`, `versions.tf` and a `README.md`. Each
root has `main.tf` (the provider and the `stack` call), `variables.tf`,
`outputs.tf`, `versions.tf` (Terraform `~> 1.10`, provider `~> 5.28`),
`backend.tf` and a committed `.terraform.lock.hcl`. Providers are configured
only in the roots.

No module names a real account, zone, host, person or resource. Each root's
committed `terraform.tfvars` names its Workers and the prefix on its Access
names (`staging board <project>`), so two deployments can share an account
without colliding. Everything else is a variable the wrapper
assembles:

| Variable | From |
| --- | --- |
| zone, one address, project origins and hostnames, board origins, tunnels | the board router's `router.local.json` |
| Access projects, their emails, domains and service tokens, session length | `infra/access-apps/access.local.json` |
| share-link routes | `infra/share-link-worker/wrangler.local.toml` |
| account and zone ids, ids to adopt (prod only; service tokens in both) | read from the account before every plan (`discover.ts`) |

Staging reads the same three configs from `deploys/staging/*.local.*`
(gitignored). In CI each config is a secret, handed in as `CF_ROUTER_CONFIG`,
`CF_ACCESS_CONFIG` and `CF_SHARE_LINK_CONFIG`.

## What stays outside, and why

- **Share applications.** The server makes one per share when a person shares
  a board, and deletes it when the share ends (`packages/server/src/share/cf-api.ts`).
  That is a runtime reaction to a person's action, not configuration.
- **The share-link Worker's `SHARE_LINK_KEY`.** Set once with `wrangler secret
  put` (`../share-link-worker/README.md`); `keep_bindings` keeps it across an
  apply, so the key never enters the state.
- **Fly.** The Fly Terraform provider is archived, and a `local-exec` keeps no
  state, so Fly stays on `machine:deploy`. `.github/workflows/fly.yml` runs it
  on main for each machine's image, and `fly-provision.yml` makes a project's
  app, volume, bucket and push keys (`docs/process/project-machine.md`). The
  provider could not make Fly's CI tokens either, so `fly-ci-tokens.yml` cuts
  them and `fly-ci/` writes them.
- **CI's plan credentials.** The repository's read-only `CLOUDFLARE_API_TOKEN`
  and R2 pair, for pull request plans, were made by the retired keeper's `CI
  credentials` step and stay as they are. The write credentials are
  `ci-secrets/`'s (below).

## How a run goes

`run.ts` does, in order:

1. Assemble the variables from the environment's configs (`vars.ts`).
2. Take the credentials (`credentials.ts`): `CLOUDFLARE_API_TOKEN`, and the
   state bucket's `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Each comes
   from the environment. The Cloudflare token comes from nowhere else: since
   the keeper retired only `cloudflare-prod` holds a write token, and a plan
   on the Mac takes a read token from the shell. The state key falls back to
   the Keychain entry `cloudflare-r2-tfstate` (JSON
   `{accessKeyId, secretAccessKey}`). Without `cloudflare-r2-tfstate`, the
   state key comes from the board secret card's two entries
   `r2-tfstate-access-key-id` and `r2-tfstate-secret-access-key`.
3. Read the account (`discover.ts`), and stop before terraform runs on
   anything that a plan would repoint or shadow: a project host under an
   Access application the config does not own (prod's sign-in application),
   an Access application over a tunnel's origin, a tunnel origin's record that
   points anywhere but its own tunnel, a route another Worker holds, two
   resources where the config names one, an origin of the Mac's with no
   proxied record, a project hostname no certificate covers. A service token
   the config names and the account lacks is not refused (below).
4. Write the run's tfvars and the `-backend-config` file (bucket, key
   `cloudflare/<env>.tfstate`, endpoint) to `state/<env>/`, mode 600.
5. `terraform init` against the R2 state, then `plan`; in CI on main, the
   saved plan's `apply`.

The credentials reach terraform in its environment and nowhere else: never an
argument, a variable or a file, so neither is in the state.

**Changing the gitignored configs.** CI reads the configs from repository
secrets, so a change to domains, session length or a project's service tokens
reaches CI through `bun run cf:sync-config` (`sync-config.ts`). It checks the
configs the way a plan reads them, writes `CF_ROUTER_CONFIG` and
`CF_SHARE_LINK_CONFIG` with Bryan's `gh` login (each value on stdin, never an
argument or a file), and dispatches `cloudflare.yml` on main, which applies.
`CF_ACCESS_CONFIG` is not written: the Access email lists retire with Better
Auth, so that secret keeps its last value. Staging is planned, never applied:
CI applies prod only.

**Adopting what exists.** `deploys/prod/imports.tf` imports each live resource
`discover.ts` found by the name this config gives it, so the first apply
updates it in place rather than making a second one. An import of a resource
already in state does nothing. Read the first plan closely: an adopted
resource shows every field the config sets differently. The share-link
Worker's workers.dev address is not managed, so it stays as it is.

**Service tokens.** Terraform owns every token a project names
(`cloudflare_zero_trust_access_service_token`, named `<name_prefix><name>`),
but the provider never makes one, because it would keep the new token's
`client_secret` in the state. A plan shows a missing token as an add. The CI apply
makes it (`run.ts` `mintMissing`, through `service-tokens.ts`) with the apply
token, seals its client id and secret to the Mac at once (`CW_HANDOFF_OUT`,
`infra/handoff/`), uploads them as the artifact `handoff-mac`, and reads the
account again so the import finds it. It refuses, making nothing, when no
sink is set or the Mac's key is not committed. `bun run handoff:pull` then
puts the pair into the Keychain as `cw-<name>-access-client-id` and
`cw-<name>-access-secret` (the name lower-cased, spaces as dashes; `agent moi`
becomes `cw-agent-moi-access-secret`), the services `CW_ACCESS_SECRET_SERVICE`
and the relay configs name. Neither value is printed or written unsealed. The
apply imports the token by id, and an imported token has no secret in the
state: Cloudflare returns it only to the call that made it. A plan, which
holds no write token, lists a missing token and makes nothing. `bun run
cf:rotate-token "<name>"` dispatches `cf-rotate-token.yml`, which gives an
existing token a new secret with the apply token, keeps the old secret
working for 24 hours, and seals the new pair to the Mac the same way.
Tokens carry `prevent_destroy`.

**Removing.** An entry removed from a config is destroyed at the next apply,
and the plan lists it as a destroy first. Access applications, service
tokens and tunnels carry `prevent_destroy`, so a plan that would remove or replace one fails.
To remove one on purpose, take its `lifecycle` block off in a reviewed
change first.

## CI

`.github/workflows/cloudflare.yml` runs on changes under `infra/cloudflare/`,
to either Worker's `worker.js`, or to itself:

- **Pull request:** `check:cloudflare-tf`, then `run.ts plan prod --ci`, which
  saves the plan, takes no state lock, and posts a summary to the PR. The plan
  job is skipped, not failed, when its secrets are absent (a fork's PR).
- **Push to main:** the same check, then `run.ts apply prod --ci` in the
  GitHub Environment `cloudflare-prod` (concurrency group `cloudflare-prod`,
  never cancelled midway). The environment has no required reviewer: the
  merged pull request is the approval.
- **Dispatch:** the same as a push when run on main. `cf:sync-config`
  dispatches it after it writes the config secrets. On any other branch it
  runs the check and applies nothing.

The repo is public, so its logs and comments are too. With `--ci`,
terraform's own output is not printed. A plan is reported as resource
addresses and verbs only (`plan-summary.ts`), and addresses carry project
labels and Worker names, never a hostname: routes and records are keyed by
label. terraform's errors still print.

Each credential is set twice under one name. The repository's copy is
read-only, for pull request plans. The `cloudflare-prod` environment's copy
can write, and GitHub gives it precedence in the jobs that use that
environment. If the environment's copy is missing, apply runs with the
read-only one and fails.

| Secret | Repository | `cloudflare-prod` |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | read-only token | the apply token (permissions below) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Object Read on the state bucket | Object Read and Write on the state bucket |
| `CF_ROUTER_CONFIG`, `CF_ACCESS_CONFIG`, `CF_SHARE_LINK_CONFIG` | the three configs' contents (they hold the Access email lists) | |

`bun run cf:ci-secrets apply` writes the environment's three credentials and
the three configs ("CI's credentials" below); the retired keeper's `CI
credentials` step wrote the repository's read-only three; `cf:sync-config`
writes the router and share-link configs. Each R2 key is
an API token on the state bucket: its access key id is the token's id and its
secret the SHA-256 of the token's value.

The jobs hand the R2 pair to terraform as `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, the names the S3 backend reads. `CF_TFSTATE_BUCKET`
is an optional repository variable; the default bucket is
`claude-workspaces-tfstate`. `cloudflare-prod` must allow deployments from
`main` only: that rule keeps its write tokens out of a pull request's reach,
including one that edits this workflow. `cf:ci-secrets` refuses to write the
environment's secrets unless that rule is in place. The apply job hands the
write token and the read-write key to the "Apply prod" step only, so `bun
install` never sees them.

## CI's credentials

`ci-secrets/` is a root of its own. One apply makes the CI deploy token
(`cloudflare_account_token.ci_deploy`) and writes, through the GitHub provider:

| Secret | Where | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `cloudflare-prod` | the deploy token |
| `R2_ACCESS_KEY_ID` | `cloudflare-prod` | the token's id |
| `R2_SECRET_ACCESS_KEY` | `cloudflare-prod` | the SHA-256 of the token's value |
| `CF_ROUTER_CONFIG`, `CF_ACCESS_CONFIG`, `CF_SHARE_LINK_CONFIG` | repository | the three gitignored configs, each when present |

The token gets the apply permissions below plus Workers R2 Storage Bucket
Item Write on the state bucket alone, and no API Tokens permission, so it
cannot make a wider token. CI never runs this root, so the token never
manages itself. It writes no Fly token and no owner address: `fly.yml` runs in
`fly-<project>` environments that hold one app's token each ("Fly's CI
tokens"). An apply after an earlier one wrote them deletes `FLY_API_TOKEN` and
`CW_SECRET_CW_BOARD_OWNER_EMAIL` from `cloudflare-prod`, with `--drop`.

```bash
CLOUDFLARE_API_TOKEN=… GITHUB_TOKEN=… bun run cf:ci-secrets apply
```

`CLOUDFLARE_API_TOKEN` here must hold Account API Tokens Edit (an
account-owned token, made under Manage Account > Account API Tokens), the one
permission no other token here holds, on purpose. `GITHUB_TOKEN` is a
classic token with `repo` scope. Each reaches terraform in its environment
only; the run prints resource addresses and verbs, never a value. Every
output that carries a value is `sensitive`.

**The state is local, and holds the token's value.** It sits in
`~/.local/state/claude-workspaces/ci-secrets/` (mode 700, files 600), outside
every checkout so deleting a worktree cannot lose it, or under
`$CW_TF_WORK_DIR` when that is set, never in the R2 bucket: the repository's read-only state key,
which every same-repo pull request's plan holds, reads the whole bucket. Whoever
can read that folder can read the token; that is the cost of Terraform owning
it. A lost state makes the next apply mint a second token and leave the first
active, so delete the old one in the dashboard if that happens. The saved
plan holds the values too and is removed when the run ends.

**An apply that deletes anything is refused** unless `--drop` is given. A
missing input deletes what an earlier apply wrote: run from a checkout without
the configs and the plan drops that secret, after which the workflows skip
their deploys rather than fail.
The token also refuses to be made unless `cloudflare-prod` allows
deployments from `main` alone, and an apply that
finds the token with no value in its state stops before writing anything.

The deploy token and R2 pair in `cloudflare-prod` today were written by the
retired keeper's `CI credentials` step, not by this root, which needs a token with Account API Tokens Edit that
nobody on the Mac holds. Apps' secrets and Fly's CI tokens are therefore
roots of their own.

## Apps' secrets

`app-secrets/` writes the secrets an app's workflow reads from
`cloudflare-prod`, through the GitHub provider alone. It needs only
`GITHUB_TOKEN`, a classic token with `repo` scope: no Cloudflare token, and
nothing in it can change or delete the deploy token or the R2 pair.

| Secret | Read by | Value, the first found |
| --- | --- | --- |
| `RESEND_API_KEY` | `signin-test.yml` | `$RESEND_API_KEY`; the Keychain item `resend-api-key`; the secret card `resend-api-key` |
| `SIGNIN_TEST_GOOGLE_CLIENT_ID` | `signin-test.yml` | `$SIGNIN_TEST_GOOGLE_CLIENT_ID`; `signin-test-google-client-id`; its card |
| `SIGNIN_TEST_GOOGLE_CLIENT_SECRET` | `signin-test.yml` | `$SIGNIN_TEST_GOOGLE_CLIENT_SECRET`; `signin-test-google-client-secret`; its card |

A Keychain item is account `claude-workspaces`, stored plain. A secret card is
what the board stores when a person saves a value through a review item's
secret field: base64, under `claude-workspaces-secret.<name>`, same account
(`packages/core/src/secret-name.ts`). The wrapper decodes it. A new app adds
its rows to `APP_SECRETS` in `app-secrets.ts`; the root needs no change.

```bash
GITHUB_TOKEN=… bun run cf:app-secrets plan    # what would change, and where each value was found
GITHUB_TOKEN=… bun run cf:app-secrets apply
```

Each value reaches terraform in its environment only, as `TF_VAR_secrets`
(JSON); the run prints resource addresses and verbs, and for each secret the
place it was found, never a value. The root has no output that carries a
value. The state holds the values, so like `ci-secrets/` it is local, in
`~/.local/state/claude-workspaces/app-secrets/` (mode 700, files 600), or
under `$CW_TF_WORK_DIR`, and the saved plan is removed when the run ends.

A secret the run cannot find is left out of the plan, which deletes a copy an
earlier apply wrote, so **an apply whose plan deletes anything is refused**
unless `--drop` is given. A secret is refused unless `cloudflare-prod` allows
deployments from `main` alone, as above, and an empty value or a lower-case
name fails the variable's validation.

## Fly's CI tokens

`fly-ci/` makes one GitHub Environment per Fly app CI deploys and writes one
secret to each, `FLY_DEPLOY_TOKEN`, through the GitHub provider alone:

| Environment | App | Read by |
| --- | --- | --- |
| `fly-<project>`, each project in `infra/project-machine/machines.json` | `cw-<project>` | `fly.yml`'s deploy job for that project |
| `fly-appkit-staging` | `cw-appkit-trial-staging` | `app-kit-staging.yml` |

Each environment admits deployments from `main` alone (custom branch
policies, one rule `main`), set by the root itself, with no required reviewer
and no wait timer. Each token is cut in `fly-ci-tokens.yml` from the org token by
`fly tokens attenuate`, which works offline: the app's id with the actions a
deploy takes, the org feature `builder` and no other (so no `wg`, which
`fly ssh` needs, and no `deletion` or `membership`), valid 90 days
(`infra/project-machine/ci-tokens.ts`). The app and the feature sit in one
`IfPresent` caveat: an access names an app or a feature, never both, and a
bare `Apps` beside a bare `FeatureSet` refuses every access. A job holds one app's token and
nothing else from Cloudflare or Fly.

```bash
GITHUB_TOKEN=… bun run fly:ci-tokens plan    # what would change; cuts tokens, writes nothing
GITHUB_TOKEN=… bun run fly:ci-tokens apply
```

The org token is `FLY_API_TOKEN`, which only the GitHub Environment
`fly-org` holds, so the apply runs in `fly-ci-tokens.yml` (weekly, and after
`fly-provision.yml` makes an app); without it the run refuses. The same run
cuts each project app a 14-day token for the Mac's own `fly ssh` and `fly
logs` (`builder` and `wg`) and seals it to the Mac, and one 14-day
read-only token, `FLY_READ_TOKEN` in the environment `fly-org-read` (read on
every app and the org, nothing else, so no `wg`), for `wall-read.yml`'s daily
`fly apps list` (`TF_VAR_read_token`). The org token reaches `fly` and Fly's API (each app's numeric id)
only. Each cut token goes from `fly`'s stdout into terraform's environment
(`TF_VAR_deploy_tokens`) and nowhere else; the run refuses an attenuate that
printed nothing, more than one line, or the org token. The state holds the
tokens, so it is local, in `~/.local/state/claude-workspaces/fly-ci/` (mode
700, files 600), and the saved plan is removed when the run ends. An app the
org does not have is skipped, which deletes its environment, so **an apply
whose plan deletes anything is refused** unless `--drop` is given.

Every apply cuts new tokens, so a monthly run keeps each one inside its
90-day window; it runs from the board's scheduled tasks. An attenuated token
cannot be revoked alone: revoking means revoking the org token it was cut
from, and the window bounds a leaked one until then. The daily wall report
(`machine:wall-report`) fails if a `fly-<project>` environment is missing,
admits another branch, or holds no token or one older than 45 days, and if
any GitHub secret outside the `fly-org` environment is named `FLY_API_TOKEN`.

## State

Remote, in a private R2 bucket shared by CI and the Mac, one key per
environment (`cloudflare/prod.tfstate`, `cloudflare/staging.tfstate`), through
terraform's S3 backend. The committed backend block holds only the settings R2
needs; the bucket, key and endpoint come from `state/<env>/backend.hcl`, which
the wrapper writes. `use_lockfile` takes a lock object beside the state for
each apply, so the Mac and CI cannot apply at once.

The state holds hostnames, ids and the Access email lists. It holds no
credential:
- No tunnel token. `machine:deploy` reads a tunnel's token from the API with the id in `terraform output tunnels`. Every same-repo pull request's plan holds the read-only state key, and that key must not unlock a token.
- No tunnel secret. `tunnel_secret` is left unset, so Cloudflare generates it and the provider stores none; `config_src = "cloudflare"` keeps the ingress in Cloudflare.
- No share-link key. The `SHARE_LINK_KEY` binding is kept by `keep_bindings` and never declared.
- The Access applications are `self_hosted`, so the provider's `saas_app.client_secret` stays empty.
- No service token secret. The provider would store `client_secret` for a token it made, so it makes none: `cf:sync-config` makes a missing token through the API, puts its pair in the Keychain, and terraform imports it by id. An import reads the token back, and Cloudflare never returns a secret on a read.

The router Worker's plain-text vars are hostname tables, not secrets.

## The token's permissions

On the account: Access: Apps and Policies Edit, Access: Service Tokens Edit (terraform updates the tokens it owns with it),
Access: Organizations Read, Cloudflare Tunnel Edit (`machine:deploy`'s
tunnel token read needs it, when it runs on the Mac with this token), Workers Scripts Edit,
D1 Edit and Turnstile Sites Edit (an app's own root, below). On the zone: Zone Read, DNS Edit, SSL and
Certificates Read, Workers Routes Edit. The plan token has the Read form of
each.

## An app's own root

`apps/<name>/` holds one app's Cloudflare resources, apart from prod's stack,
because they change with the app rather than with the boards. Each is applied
only by its app's workflow, with the `cloudflare-prod` deploy token, against
its own key in the state bucket (`cloudflare/<name>.tfstate`). The one today
is the sign-in test app (`infra/signin-test/README.md`, which also says how a
new app gets its sign-in live):

- **What Terraform makes:** the D1 database (`prevent_destroy`), the Turnstile
  widget, the Worker's custom domain, and the DNS records Resend asks for. The
  Worker's code is wrangler's: Terraform makes a placeholder script once, so
  the custom domain has something to point at, and ignores it afterwards.
- **What it does not:** Resend's domain and keys. Resend has no maintained
  Terraform provider, so the app's deploy script makes the domain if it is
  missing and passes its records in as a variable. A record outside the mail
  subdomain fails the variable's validation, so the zone's own mail records
  are never touched.
- **What it reads from `cloudflare-prod`:** the deploy token, the R2 pair,
  and the app's own secrets, which `cf:app-secrets` writes ("Apps' secrets").
- **What its state holds:** the Turnstile widget's secret, because the
  provider reads it back. That secret lets its holder check a Turnstile token
  for that widget, not pass one. Prod's state still holds no credential.

## Fly

`.github/workflows/fly.yml` deploys each project machine's image from main
with `machine:deploy`, one job per project in that project's `fly-<project>`
environment, with its `FLY_DEPLOY_TOKEN` and no Cloudflare credential ("Fly's
CI tokens"). Server code still reaches machines as the signed releases
`.github/workflows/server-release.yml` publishes.

## Tests

`bun run check:cloudflare-tf`, a member of `bun run verify`, a step of CI's
`gates` job and the first job of `cloudflare.yml`: `terraform fmt -check`,
`terraform validate` on each root, and `deploys/prod/tests/plan.tftest.hcl`,
which plans the root and each module from a fixture against a mock provider
(no token, no state, no network call beyond the provider download), and
`ci-secrets/tests/apply.tftest.hcl`, which applies the CI credentials root
against mock Cloudflare and GitHub providers,
`app-secrets/tests/apply.tftest.hcl`, which applies the apps' secrets root
against a mock GitHub provider, `fly-ci/tests/apply.tftest.hcl`, which
applies the Fly environments root the same way, and each app root's
`tests/plan.tftest.hcl`.
In `packages/server/test`: `cloudflare-ci-secrets.test.ts` checks what
`cf:ci-secrets` hands terraform and prints; `cloudflare-app-secrets.test.ts`
the same for `cf:app-secrets`, and the order it looks for each value in; `fly-ci-tokens.test.ts`
what `fly:ci-tokens` cuts and where each token goes; `cloudflare-ci-credentials.test.ts`
the R2 key and account id CI's steps take from the token; `cloudflare-tf-discover.test.ts` runs the adoption
and the refusals against a fake account; `cloudflare-tf-service-tokens.test.ts`
a missing token through plan and CI apply; `cloudflare-tf-wrapper.test.ts` the
variable assembly, where each credential goes, what CI prints, the file
modes, the local `cf:apply` pointer, and the apply's minting;
`cloudflare-sync-config.test.ts` what `cf:sync-config` writes and dispatches;
`cloudflare-rotate-token.test.ts` both halves of `cf:rotate-token`;
`cloudflare-workflow.test.ts` which events reach the apply job, and the
workflows that replaced the keeper; `cloudflare-tf-outputs.test.ts` the credential sources, the plan
summary and the outputs `machine:deploy` reads. What only the real account
can show: the import id formats (read from the provider's own documentation
strings; the mock provider cannot run an import), R2's acceptance of the
lock file, and the first plan's diff.
