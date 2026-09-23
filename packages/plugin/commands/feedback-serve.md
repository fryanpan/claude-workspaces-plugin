---
allowed-tools: Bash(bun run *), Bash(pgrep *), Bash(lsof *), Bash(git rev-parse *), Bash(test *)
description: Start the claude-workspaces server from a clone of the repo; prints localhost / tailscale / LAN URLs
---

## Context

- Running server? !`/usr/bin/pgrep -fl "packages/server/src/bin.ts" | /usr/bin/head -3 || echo "no"`
- Current checkout: !`git rev-parse --show-toplevel 2>/dev/null || echo "not a git checkout"`
- Is it a claude-workspaces clone? !`test -f scripts/serve.ts && test -f packages/server/src/bin.ts && echo "yes" || echo "no"`

## Your task

The plugin carries the MCP tools, hooks and skills. It does **not** carry the
server. The server runs from a clone of
https://github.com/fryanpan/claude-workspaces-plugin, so this command only
works when the session's working directory is the root of such a clone.

1. If a server is already running (the first line above is not "no"), say so
   and stop. A second server on another port does not take over the discovery
   file, so agents keep talking to the first one.
2. If the clone check above says "no", do not start anything. Tell the user
   the server has to run from a clone, and give them these steps:

   ```sh
   git clone https://github.com/fryanpan/claude-workspaces-plugin.git
   cd claude-workspaces-plugin
   bun install
   bun run dev
   ```

3. Otherwise run `bun run dev` (it is `bun run scripts/serve.ts`). If
   `node_modules/` is missing, run `bun install` first. The script:
   - picks a free port, starting at 8787;
   - starts the server and the web-app bundler in watch mode;
   - writes the port to `~/.claude/claude-workspaces/server.json`, which is
     how the plugin's MCP server finds it (`CW_BASE_URL` overrides it);
   - prints the URL forms that reach this machine: `http://localhost:<port>`
     for this machine, plus a Tailscale and a LAN hostname when it finds them.

This project does **not** open a public tunnel. Reviews happen on this
machine, over Tailscale, or on the local network.

After it starts, tell the user to open `http://localhost:<port>/` for the
board. For a simulated phone viewport on a desktop browser, append
`?mobile=iphone16pm` to a board or review URL.
