# App kit

A starting app with sign-in, a live shared doc and the shared Web Awesome
theme. Make one from the claude-workspaces repo with:

```bash
bun run new-app ../riverbend-notes   # read from the repo root; the folder name is the app name
cd ../riverbend-notes
bun install
bun run build
bun run start                        # http://127.0.0.1:3000
```

Make an account at `/auth/sign-up`. Until a mail provider is wired, the
verification link is printed in the terminal running the app; open it, then
sign in. Open the same doc in two tabs and type: each tab shows the other's
edits as they are made, and each doc page shows who else has it open. Docs,
accounts and roles are saved to `data/` and kept across restarts.

## What is in it

| File | What it does |
| --- | --- |
| `src/server.ts` | Starts the app. `PORT` (0 picks a free port), `HOST`, `DATA_DIR`, `APP_URL`, `AUTH_SECRET`, `APP_ENV`. |
| `src/app.ts` | The Hono routes for pages and assets, the doc socket at `/docs/<id>/ws`, the presence socket at `/docs/<id>/presence`, and the owner's `POST /docs/<id>/roles`. |
| `src/doc-roles.ts` | Who may do what to each doc, in `data/roles.sqlite`: the core asks it on every connect. |
| `src/presence.ts` | Who else has a doc open, on the core's presence hub. |
| `src/sign-in.ts` | The sign-in slot: `SignIn.principal(request)` says who sent a request. |
| `src/password-sign-in.ts` | Password sign-in on Better Auth, accounts and sessions in `data/auth.sqlite`. |
| `src/mail.ts` | Where verification and reset mails go: printed to the terminal until you wire a provider. |
| `src/file-storage.ts` | Saves each doc as `data/docs/<id>.ydoc`. |
| `src/page.ts` | The HTML for each page. |
| `src/client/` | The page script: the Web Awesome components, the doc socket (`sync.ts`), the presence socket (`presence.ts`) and the textarea binding. |
| `src/theme.css` | Imports the shared theme from the app kit package. |
| `vendor/` | The app kit package, `@claude-workspaces/app-kit`, as a tarball: the collaboration core (`@claude-workspaces/app-kit/collab`, rooms that sync a Yjs doc between pages), the shared theme, and the shared password sign-in rules (`@claude-workspaces/app-kit/auth`). |
| `src/app.css` | The app's own styles, every value a `--wa-*` token. |
| `Dockerfile`, `fly.toml`, `scripts/deploy-staging.ts` | The staging machine and the command that deploys it (below). |

## Sign-in

People make an account with a name, an email and a password, open the link
mailed to them, and then sign in by password. A session is a row in
`data/auth.sqlite` named by a signed, HttpOnly cookie; signing out deletes
the row. The cookie is signed with `AUTH_SECRET`, or with a secret made on
first start in `data/auth-secret` (readable only by its owner).

The rules (how a password is hashed and checked, that an email is verified
before a password signs in, what ends a session, which mails go out) are
`passwordAuthOptions` from the app kit package, the same options the
claude-workspaces sign-in Worker template runs. `src/password-sign-in.ts`
adds only this app's database, secret, rate limit (20 auth requests a minute
per address, in memory) and form pages.

Before `APP_ENV=production`, wire a mail provider in `src/mail.ts`:
`server.ts` refuses to start while mail only prints to the terminal. Password
reset mails go out, but the kit has no page to set the new password yet.

## Staging

```bash
bun install                      # once, so bun.lock exists for the image
bun run deploy:staging           # https://<app name>-staging.fly.dev
bun run deploy:staging --dry-run # print the fly commands; run none
```

It makes the Fly app and its 1 GB data volume if they are missing, sets
`AUTH_SECRET` as a Fly secret on the first deploy (generated, never shown),
deploys with `APP_URL` set to the app's `fly.dev` origin and
`APP_ENV=staging`, then waits for `/health` to answer 200 and prints how long
the whole command took. Give another app name as the first argument, and
`--region` for somewhere other than `sjc`. The name must end in `-staging`:
any other name is refused before any `fly` command runs, so a deploy cannot
overwrite an app in the org that is not a staging app.

It needs `fly` on the PATH and reads `FLY_API_TOKEN` and `FLY_ORG` from the
environment, never from the Keychain. With no `FLY_ORG`, it uses the one
org the token reaches, and refuses if there are several. The token goes only
into the `fly` process's environment. When the app already exists, the deploy
asks Fly for that one app and never lists or creates apps, so a token cut
down to the app is enough. In the claude-workspaces repo CI holds such a
token, for `cw-appkit-trial-staging` alone: run the `app-kit-staging`
workflow on main, which deploys a fresh `new-app` to that app and reports the
time from `new-app` to the first 200 on the run's summary. The app was made
once, by a first run of this command with a token that could list the org.

The machine (`fly.toml`, built from `Dockerfile`) is the smallest shared CPU
with 256 MB. It stops when idle and starts on the next request, so the first
page after a quiet spell takes a few seconds. Docs and accounts live on the
volume at `/data`. Mail prints to the machine's log: read a verification link
with `fly logs --app <app>`.

## Who may open a doc

The first signed-in person to open a doc owns it. On the doc page the owner
gives somebody a role by their account's email: `edit`, `view` (reads, and
the server drops every edit their socket sends) or `owner`. Everybody with
no role on a doc gets `edit`; pass another default to `openDocRoles` in
`src/server.ts`, or `null` to make docs invite-only. The table is
`src/doc-roles.ts`, its roles the four the claude-workspaces board uses
(`owner`, `edit`, `comment`, `view`).

The core asks the table on every connect, every presence update and again
after every role change, so an open page of somebody made `view` stops
writing at once, and nothing the page does gets an edit past the server.

## Who else is here

Each doc page shows the people who have that doc open, as avatars beside the
status line. The page says only "I am on this doc"; who it is and which doc
come from the socket, and the same role table decides who is shown, so
somebody with no role on a doc neither sees nor appears on it.

## Updating the app kit

The collaboration core and the theme come from one package,
`@claude-workspaces/app-kit`, whose tarball sits in `vendor/`. To move to a
newer one, pack it in the claude-workspaces repo with
`bun run --cwd packages/app-kit pack <this app>/vendor`, change the
`file:./vendor/…tgz` line in `package.json` to the new file name, and run
`bun install`.
