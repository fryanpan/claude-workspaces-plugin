# @claude-workspaces/app-kit

The shared pieces an app made with `bun run new-app` depends on:

- `@claude-workspaces/app-kit/collab`: the collaboration core. Rooms that
  sync a Yjs doc between pages over the app's storage, behind the app's own
  sign-in check and role function. It imports only yjs, y-protocols and lib0.
- `@claude-workspaces/app-kit/theme.css`: the Web Awesome theme file the
  claude-workspaces board uses. Bundle it with the app's CSS; its base theme
  is an `@import` from `@awesome.me/webawesome`.
- `@claude-workspaces/app-kit/auth`: password sign-in as every app on the
  shared stack runs it. `passwordAuthOptions(mailer)` returns the Better Auth
  options for accounts, password hashing, email verification and sessions,
  for the app to spread into `betterAuth({...})` beside its own database.
  The sign-in Worker template (`templates/signin`) uses the same function.
  It imports nothing.

The package ships TypeScript source; Bun runs and bundles it directly.

## Versions

It is distributed as a tarball, `claude-workspaces-app-kit-<version>.tgz`,
built from the claude-workspaces repo with
`bun run --cwd packages/app-kit pack <outDir>`. An app names it in its
`package.json` (`"@claude-workspaces/app-kit": "file:./vendor/claude-workspaces-app-kit-0.2.0.tgz"`)
and moves to a new version by replacing the tarball and that line.
