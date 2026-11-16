# @claude-workspaces/app-kit

The shared pieces an app made with `bun run new-app` depends on, and the
pieces a Cloudflare Worker app uses to host live docs and dashboards in its
own Durable Objects:

- `@claude-workspaces/app-kit/collab`: the collaboration core. Rooms that
  sync a Yjs doc between pages over the app's storage, behind the app's own
  sign-in check and role function. It imports only yjs, y-protocols and lib0.
- `@claude-workspaces/app-kit/do`: the core inside a Durable Object that
  hibernates. See [Worker apps](#worker-apps).
- `@claude-workspaces/app-kit/markdown-file`: a live doc whose record is a
  markdown file the app reads and writes itself.
- `@claude-workspaces/app-kit/agent`: an agent session as a principal, and
  the doc and dashboard edits its tools run.
- `@claude-workspaces/app-kit/client`: the page side, as TypeScript for an
  app with a bundler. `connectDoc`, `bindTextarea`, `watchMap`, `splice`, `Y`.
- `@claude-workspaces/app-kit/cw-collab.js` and `cw-collab.mjs`: the same
  page side prebuilt, with Yjs inside, for a page with no bundler.
- `@claude-workspaces/app-kit/theme.css`: the Web Awesome theme file the
  claude-workspaces board uses. Bundle it with the app's CSS; its base theme
  is an `@import` from `@awesome.me/webawesome`.
- `@claude-workspaces/app-kit/auth`: password sign-in as every app on the
  shared stack runs it. `passwordAuthOptions(mailer)` returns the Better Auth
  options for accounts, password hashing, email verification and sessions,
  for the app to spread into `betterAuth({...})` beside its own database.
  The sign-in Worker template (`templates/signin`) uses the same function.
  It imports nothing.

The package ships TypeScript source; Bun, wrangler and esbuild bundle it
directly.

## Worker apps

Everything below runs in workerd with no Node APIs, and calls no service the
app did not name. Sign-in and room access stay the app's own: the kit is
handed a principal and a role it has already decided.

**One Durable Object per doc or dashboard.** `createDurableRoom` wraps the
core for the hibernation API:

```ts
import { createDurableRoom, sqlCollabStorage } from '@claude-workspaces/app-kit/do';

export class DocRoom {
  room;
  constructor(ctx) {
    this.room = createDurableRoom({ ctx, storage: sqlCollabStorage(ctx.storage.sql) });
  }
  async fetch(req) {
    const { principal, role } = await checkAccess(req); // the app's own
    const pair = new WebSocketPair();
    const res = this.room.accept(pair[1], { roomId: 'notes', principal, role });
    if (!res.ok) return new Response(res.error, { status: 403 });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(ws, msg) { this.room.message(ws, msg); }
  webSocketClose(ws) { this.room.close(ws); }
}
```

- Each socket's grant is kept in its attachment, so an instance woken from
  hibernation puts every socket back with the role it had.
- `room.revoke(principalId)` closes that principal's sockets and refuses its
  actions; `room.grant(principal, role)` lets a principal with no socket (an
  agent, the server) run actions.
- With `storage`, the doc is saved to the object's SQLite inside the message
  that changed it; nothing waits on a timer.

**A markdown file as the doc.** `markdownFileRoom({ load, save, state,
schedule })` holds the doc for a file kept elsewhere (Dropbox, R2):

- `load` and `save` are the app's async file calls. Run the constructor
  inside `ctx.blockConcurrencyWhile` and pass `docs: file.docs` to
  `createDurableRoom`.
- `state: sqlKeyValue(ctx.storage.sql, 'file')` keeps unsaved edits across
  an eviction. `schedule: alarmSchedule(ctx.storage)` puts the save debounce
  (`debounceMs`, default 2000) on the object's alarm; the app's `alarm()`
  calls `file.flush()`. An alarm wakes an evicted object, so an edit made
  just before hibernation still reaches the file.
- `file.refresh()` reads the file again. An outside edit is applied as one
  splice, so readers' cursors stay put. If it overlaps unsaved local edits,
  the local text is kept, the next save overwrites the file with it, and
  `onConflict({ base, remote, local })` is the only place the outside
  edit survives: write `remote` somewhere (a conflict copy beside the
  file) so it is not lost.

**An agent's edits.** The app's tool dispatch runs an edit as the agent
session that asked for it:

```ts
import { agentPrincipal, editDocAction, setTileAction } from '@claude-workspaces/app-kit/agent';

// in the constructor: createDurableRoom({ ..., actions: { editDoc: editDocAction() } })
const agent = agentPrincipal(sessionId, 'Agent'); // { id: 'agent:<sessionId>', name }
room.grant(agent, 'edit');
const res = room.action(roomId, agent, 'editDoc', { find: 'noon', replace: 'dusk' });
// res.value: { ok: true } or { ok: false, error, message } to hand back to the agent
```

`editDoc` takes `{ text }` (the whole text) or `{ find, replace }` (`find`
must occur once). `setTile` takes `{ tile, value }` and writes JSON into the
root map `tiles`; `null` removes the tile.

**A live dashboard.** One object per dashboard. Pages join with the `view`
role, so the core drops anything they write. After each database write, call
`alarmSchedule(ctx.storage)(2000)`; in `alarm()`, recompute and write the
result with `room.action(roomId, SERVER_PRINCIPAL, 'setTile', { tile, value })`.
A burst of writes becomes one push. Each write moves the alarm, so a steady
stream of writes less than 2s apart postpones the push until it stops.
`test/fixtures/dashboard-worker.ts` is the whole example.

**The page.** Serve `cw-collab.js` from the app's own origin:

```html
<script src="/cw-collab.js"></script>
<script>
  const sync = cwCollab.connectDoc(`wss://${location.host}/docs/notes/ws`);
  sync.synced.then(() => cwCollab.bindTextarea(textarea, sync.doc.getText('body')));
  // A dashboard: cwCollab.watchMap(sync.doc.getMap('tiles'), render);
</script>
```

The browser sends the page's cookies on the socket. A token the page holds
can go as a subprotocol (`connectDoc(url, { protocols: [token] })`; the
Worker's 101 response must name it back in `Sec-WebSocket-Protocol` or the
browser drops the socket) or in the address, which may be a function asked
again on every reconnect.
`cw-collab.js` is about 96 KB, 30 KB gzipped. It defines `window.cwCollab`;
Yjs also sets its own global marker so a second copy on the page warns.

## Versions

It is distributed as a tarball, `claude-workspaces-app-kit-<version>.tgz`,
built from the claude-workspaces repo with
`bun run --cwd packages/app-kit pack <outDir>`. An app names it in its
`package.json` (`"@claude-workspaces/app-kit": "file:./vendor/claude-workspaces-app-kit-0.3.0.tgz"`)
and moves to a new version by replacing the tarball and that line.

- 0.3.0: `./do`, `./markdown-file`, `./agent`, `./client` and the prebuilt
  `cw-collab.js` / `cw-collab.mjs`, for Worker apps.
