# Cloudflare, in Terraform

Every Cloudflare resource this repo configures is declared here, so a change
is one reviewed plan and one apply instead of a script per surface. Only CI
applies (`.github/workflows/cloudflare.yml`): it plans every pull request and
applies when one merges to main, with nobody at a terminal. The merge is the
approval.

```bash
bun run cf:plan              # prod: reads the account, prints what would change, changes nothing
bun run cf:plan staging      # the same for staging
bun run cf:sync-config       # sends the gitignored configs to CI and starts an apply; one passkey tap
bun run cf:rotate-token NAME # a new secret for one service token; one passkey tap
bun run cf:ci-secrets plan    # CI's deploy token and GitHub secrets: what would change
bun run cf:ci-secrets apply   # make the token and write the secrets ("CI's credentials" below)
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
- **The keeper's Cloudflare token.** `keeper-setup` still mints it through the
  API after the person confirms. In Terraform its value would sit in the
  state; the keeper exists so that no such file holds it.
- **The share-link Worker's `SHARE_LINK_KEY`.** Set once with `wrangler secret
  put` (`../share-link-worker/README.md`); `keep_bindings` keeps it across an
  apply, so the key never enters the state.
- **Fly.** The Fly Terraform provider is archived, and a `local-exec` keeps no
  state, so Fly stays on `machine:deploy`. `.github/workflows/fly.yml` runs it
  on main for each machine's image; a project's first deploy still runs on the
  Mac (`docs/process/project-machine.md`).
- **CI's plan credentials.** The repository's read-only `CLOUDFLARE_API_TOKEN`
  and R2 pair, for pull request plans, are made by `keeper-setup`'s `CI
  credentials` step and written through the keeper
  (`packages/server/src/keeper/keeper-setup-ci.ts`). The write credentials are
  `ci-secrets/`'s (below).

## How a run goes

`run.ts` does, in order:

1. Assemble the variables from the environment's configs (`vars.ts`).
2. Take the credentials (`credentials.ts`): `CLOUDFLARE_API_TOKEN`, and the
   state bucket's `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Each comes
   from the environment when set (CI), else from the Keychain entries
   `cloudflare-api-token` and `cloudflare-r2-tfstate` (JSON
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

**The keeper.** The provider cannot send the keeper's request header, so on
the Mac the keeper runs terraform itself, from its own release, with its own
token (`keeper-run.ts`). With `CW_KEEPER_URL` set and no `--ci`, `cf:plan`
hands off to `keeper-wrapper.ts`, which sends the keeper the configs and the
state bucket's credential, reads no Cloudflare token, and prints the plan at
once. The keeper refuses an apply. Without `CW_KEEPER_URL`, or with
`CLOUDFLARE_API_TOKEN` set, `cf:plan` runs terraform here. Runbook:
`docs/process/keeper.md`.

**Changing the gitignored configs.** CI reads the three configs from
repository secrets, so a change to people, domains, session length or a
project's service tokens reaches CI through `bun run cf:sync-config`
(`sync-config.ts`). It sends the configs to the keeper, which plans them
first. The approval page names the secrets it will write, who each project's
sign-in list gains or loses, and any service token it will make. One tap
makes the missing tokens, writes `CF_ROUTER_CONFIG`, `CF_ACCESS_CONFIG` and
`CF_SHARE_LINK_CONFIG`, and dispatches `cloudflare.yml` on main, which
applies. Each new token's pair comes back to `cf:sync-config` alone, which
puts it in the Keychain. Staging is planned, never applied: CI applies prod
only.

**Adopting what exists.** `deploys/prod/imports.tf` imports each live resource
`discover.ts` found by the name this config gives it, so the first apply
updates it in place rather than making a second one. An import of a resource
already in state does nothing. Read the first plan closely: an adopted
resource shows every field the config sets differently. The share-link
Worker's workers.dev address is not managed, so it stays as it is.

**Service tokens.** Terraform owns every token a project names
(`cloudflare_zero_trust_access_service_token`, named `<name_prefix><name>`),
but the provider never makes one, because it would keep the new token's
`client_secret` in the state. A plan shows a missing token as an add. `cf:sync-config`
makes it: the keeper's token run (`keeper-run.ts tokens`, through
`service-tokens.ts`) makes it through the API, and `cf:sync-config` puts its
client id and secret straight into the Keychain as `cw-<name>-access-client-id` and `cw-<name>-access-secret` (the
name lower-cased, spaces as dashes; `agent moi` becomes
`cw-agent-moi-access-secret`), the services `CW_ACCESS_SECRET_SERVICE` and the
relay configs name. Neither value is printed or written to a file. The apply
then imports the token by id, in staging too, and an imported token has no
secret in the state: Cloudflare returns it only to the call that made it. A
Keychain service already taken, or one two names would share, is refused
before the keeper is asked. A CI apply refuses a missing token, since CI has
no Keychain; the error names `cf:sync-config`. `bun run cf:rotate-token
"<name>"` gives an existing token a new secret on one tap, keeps the old
secret working for 24 hours, and replaces the pair in the Keychain.
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
- **Dispatch:** the same as a push when run on main. The keeper dispatches it
  after `cf:sync-config` writes the config secrets. On any other branch it
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
the three configs ("CI's credentials" below); `keeper-setup`'s `CI
credentials` step writes the repository's read-only three; `cf:sync-config`
also writes the configs. Each R2 key is
an API token on the state bucket: its access key id is the token's id and its
secret the SHA-256 of the token's value.

The jobs hand the R2 pair to terraform as `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, the names the S3 backend reads. `CF_TFSTATE_BUCKET`
is an optional repository variable; the default bucket is
`claude-workspaces-tfstate`. `cloudflare-prod` must allow deployments from
`main` only: that rule keeps its write tokens out of a pull request's reach,
including one that edits this workflow. The keeper refuses to write the
environment's secrets unless that rule is in place. The apply job hands the
write token and the read-write key to the "Apply prod" step only, so `bun
install` never sees them.

## CI's credentials

`ci-secrets/` is a root of its own. One apply makes the CI deploy token
(`cloudflare_api_token.ci_deploy`) and writes, through the GitHub provider:

| Secret | Where | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `cloudflare-prod` | the deploy token |
| `R2_ACCESS_KEY_ID` | `cloudflare-prod` | the token's id |
| `R2_SECRET_ACCESS_KEY` | `cloudflare-prod` | the SHA-256 of the token's value |
| `FLY_API_TOKEN` | `cloudflare-prod` | `FLY_API_TOKEN` from the runner's environment, when set |
| `CF_ROUTER_CONFIG`, `CF_ACCESS_CONFIG`, `CF_SHARE_LINK_CONFIG` | repository | the three gitignored configs, each when present |

The token gets the apply permissions below plus Workers R2 Storage Bucket
Item Write on the state bucket alone, and no API Tokens permission, so it
cannot make a wider token. CI never runs this root, so the token never
manages itself.

```bash
CLOUDFLARE_API_TOKEN=… GITHUB_TOKEN=… bun run cf:ci-secrets apply
```

`CLOUDFLARE_API_TOKEN` here must hold User > API Tokens > Edit, the one
permission the keeper's token lacks on purpose
(`packages/server/src/keeper/keeper-setup-cloudflare.ts`). `GITHUB_TOKEN` is a
classic token with `repo` scope. Each reaches terraform in its environment
only; the run prints resource addresses and verbs, never a value. Every
output that carries a value is `sensitive`.

**The state is local, and holds the token's value.** It sits in
`~/.local/state/claude-workspaces/ci-secrets/` (mode 700, files 600), outside
every checkout so deleting a worktree cannot lose it, or under
`$CW_TF_WORK_DIR` when the keeper runs it, never in the R2 bucket: the repository's read-only state key,
which every same-repo pull request's plan holds, reads the whole bucket. Whoever
can read that folder can read the token; that is the cost of Terraform owning
it. A lost state makes the next apply mint a second token and leave the first
active, so delete the old one in the dashboard if that happens. The saved
plan holds the values too and is removed when the run ends.

**An apply that deletes anything is refused** unless `--drop` is given. A
missing input deletes what an earlier apply wrote: run without
`FLY_API_TOKEN`, or from a checkout without the configs, and the plan drops
that secret, after which the workflows skip their deploys rather than fail.
The token also refuses to be made unless `cloudflare-prod` allows
deployments from `main` alone (the check the keeper makes), and an apply that
finds the token with no value in its state stops before writing anything.

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
tunnel token read needs it, when it runs on the Mac with this token), Workers Scripts Edit. On the zone: Zone Read, DNS Edit, SSL and
Certificates Read, Workers Routes Edit. The plan token has the Read form of
each.

## Fly

`.github/workflows/fly.yml` deploys each project machine's image from main
with `machine:deploy`, using the `cloudflare-prod` environment's
`FLY_API_TOKEN` and the deploy token. Server code still reaches machines as
the signed releases `.github/workflows/server-release.yml` publishes.

## Tests

`bun run check:cloudflare-tf`, a member of `bun run verify`, a step of CI's
`gates` job and the first job of `cloudflare.yml`: `terraform fmt -check`,
`terraform validate` on each root, and `deploys/prod/tests/plan.tftest.hcl`,
which plans the root and each module from a fixture against a mock provider
(no token, no state, no network call beyond the provider download), and
`ci-secrets/tests/apply.tftest.hcl`, which applies the CI credentials root
against mock Cloudflare and GitHub providers.
In `packages/server/test`: `cloudflare-ci-secrets.test.ts` checks what
`cf:ci-secrets` hands terraform and prints; `cloudflare-ci-credentials.test.ts`
the R2 key and account id CI's steps take from the token; `cloudflare-tf-discover.test.ts` runs the adoption
and the refusals against a fake account; `cloudflare-tf-service-tokens.test.ts`
a missing token through plan and CI apply; `cloudflare-tf-wrapper.test.ts` the
variable assembly, where each credential goes, what CI prints, the file
modes, and the local `cf:apply` pointer; `cloudflare-tf-keeper-wrapper.test.ts`
the Mac's side of `cf:plan` and `cf:sync-config`; `cloudflare-workflow.test.ts`
which events reach the apply job; `cloudflare-tf-outputs.test.ts` the credential sources, the plan
summary and the outputs `machine:deploy` reads. What only the real account
can show: the import id formats (read from the provider's own documentation
strings; the mock provider cannot run an import), R2's acceptance of the
lock file, and the first plan's diff.
