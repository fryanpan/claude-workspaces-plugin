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

Open it in two tabs, sign in, open the same doc in both, and type: each tab
shows the other's edits as they are made. Docs are saved to `data/` and kept
across restarts.

## What is in it

| File | What it does |
| --- | --- |
| `src/server.ts` | Starts the app. `PORT` (0 picks a free port), `HOST`, `DATA_DIR`, `APP_ENV`. |
| `src/app.ts` | The Hono routes for pages and assets, and the doc socket at `/docs/<id>/ws`. `role` there says who may open which doc. |
| `src/sign-in.ts` | The sign-in slot: `SignIn.principal(request)` says who sent a request. |
| `src/file-storage.ts` | Saves each doc as `data/<id>.ydoc`. |
| `src/page.ts` | The HTML for each page. |
| `src/client/` | The page script: the Web Awesome components, the doc socket (`sync.ts`) and the textarea binding. |
| `src/theme.css` | Imports the shared theme from the app kit package. |
| `vendor/` | The app kit package, `@claude-workspaces/app-kit`, as a tarball: the collaboration core (`@claude-workspaces/app-kit/collab`, rooms that sync a Yjs doc between pages) and the shared theme. |
| `src/app.css` | The app's own styles, every value a `--wa-*` token. |

## Sign-in

The kit ships one provider, `devSignIn`: anybody can type a name and be that
person. It exists so the app runs on the first try, and `server.ts` refuses
to start with it when `APP_ENV=production`.

For real accounts, write a `SignIn` whose `principal` reads your session, and
pass it in `server.ts` in place of `devSignIn()`. Nothing else changes: every
page and the doc socket ask `principal` and nothing else. The
claude-workspaces repo's `templates/signin` is a Cloudflare Worker with
password, magic-link and Google sign-in on Better Auth; a provider that reads
its session is not part of this kit yet.

## Who may open a doc

`role` in `src/app.ts` gives every signed-in person edit on every doc. Change
it to give owners, viewers or nobody: the core asks it on every connect, and
a `view` socket receives the doc but its edits are dropped.

## Updating the app kit

The collaboration core and the theme come from one package,
`@claude-workspaces/app-kit`, whose tarball sits in `vendor/`. To move to a
newer one, pack it in the claude-workspaces repo with
`bun run --cwd packages/app-kit pack <this app>/vendor`, change the
`file:./vendor/…tgz` line in `package.json` to the new file name, and run
`bun install`.
