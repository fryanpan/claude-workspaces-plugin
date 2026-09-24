---
alwaysApply: true
---

# Claude Workspaces as the Default Review Surface

When you want the owner to review a markdown doc OR a dev server / interactive preview, **bind it to the claude-workspaces widget by default** rather than just sending them a file path or a URL. The plugin is stable and is the fleet-wide standard.

## When this applies

- Drafting any markdown for the owner's voice / structure / content pass (blog posts, plans, audits, retros, design docs, decision docs)
- Sharing a dev server URL or HTML mockup for UX feedback
- Surfacing any document where you want comment-level input, not just a thumbs up
- The owner asking to review a git diff / branch / two commits of a local checkout — use `create_diff_review` (see the `claude-workspaces:diff-review` skill)

## When to skip

- One-or-two-line acks where there's no review surface
- Code review already happening on a GitHub PR — don't duplicate the surface unless the owner asks for a claude-workspaces review pass
- Your own logs / private notes (no owner input expected)

## Finding the tools

The claude-workspaces tools are **deferred** — they do NOT appear in your direct function list, and searching the single-segment name `mcp__plugin_claude-workspaces__*` finds nothing. The real prefix has a **doubled segment** (plugin name, then MCP-server name): `mcp__plugin_claude-workspaces_claude-workspaces__<tool>`. Load them with:

```
ToolSearch → select:mcp__plugin_claude-workspaces_claude-workspaces__create_review_doc,mcp__plugin_claude-workspaces_claude-workspaces__watch_doc,mcp__plugin_claude-workspaces_claude-workspaces__resolve_thread
```

If that returns nothing, THEN the plugin isn't enabled for your session — but check the doubled-prefix name first. "The tools aren't in my list" is expected for deferred tools, not a broken MCP.

## Present the work in the workspace, not in chat

The workspace is the **primary work surface** (the owner, 2026-08-18: *"Chat is so weird and out of context — I'd like you to start showing me review items tied to tasks or doc comments or wherever they are in context, instead of making me figure it out from a funny chat screen."*). When the thing you built answers a task or a comment, the URL goes there:

- Reply on the thread that asked for it (`post_reply`), or open a subject thread on the task (`create_thread(docId="task:<taskId>", …)`) when nothing asked yet.
- Pass the `review` payload on `create_thread` / `post_reply` when you're asking the owner to look or decide — that's what makes it a Review Item on their Home queue rather than a comment they have to notice.
- Chat gets at most a one-line pointer. Bare URLs on their own line, never markdown-wrapped.

The full rule ships fleet-wide in the `claude-workspaces:working-in-a-workspace` skill ("The workspace is where you ask for human help" and "The workspace is where you share status").

## How

**Markdown docs** — bind via `mcp__plugin_claude-workspaces_claude-workspaces__create_review_doc(docId, path, title?)`. Post the review URL (`http://<host>:8787/review/<docId>`) on the task or thread the doc belongs to (see above); a chat message carries at most a pointer.

**Dev servers / HTML mockups** — use the `claude-workspaces:embedding-widget` skill (it covers the `<script>` tags + `setContext` calls).

**Git diffs** — `create_diff_review(repo, base)` → share the returned `entryUrl` (bare URL on its own line). Default diffs base against the LIVE working tree: keep editing and the owner's view re-renders in ~1s, their comments riding along (orphaning into the outdated-comments flow if their line disappears). Pass `target` only to pin a finished range. One doc per changed file; comments arrive per file via the auto-watch; `archive_attachment_set(reviewId, reason)` when done — it retires the review without destroying it, and `unarchive_attachment_set` brings it back.

**Apply the owner's comments via the claude-workspaces edit tools** — once a doc is bound, NEVER edit the .md file directly with Write/Edit. Use `find_and_replace`, `rewrite_thread_region`, `insert_blocks_after_thread`, etc. The plugin serializes the live doc back to disk ~1s after every change; direct filesystem edits get silently clobbered by the next flush. See the `claude-workspaces:editing-review-docs` skill for the full pattern.

## Reading a doc's threads is not the dangerous read

Auditing comments is cheap, and the caution about bound docs does not cover it.
Two different reads, and only one of them goes anywhere near the file on disk.

- **`list_threads` and `get_thread` bind nothing.** Threads live in the
  `.ydoc`, so the server answers out of it: `DocStore.listThreads` resolves
  through `resolveDocForRead`, which hydrates with `bind: false` — no bound
  file is read, no mtime poll joins the sweep, no write-back observer is
  installed, and no `touchDoc`, so nothing enters the file poll's fast lane. A
  dormant binding stays dormant. **You cannot clobber a file by reading its
  comments**, and a doc whose first visitor was a threads read is bound
  properly the moment anything asks for its content.
- **`get_doc` and every edit tool DO bind.** They reach for CONTENT, so they
  take the full hydrate — the file is read, the binding is armed, the doc is
  touched. Right for a doc you are about to work on, and the read the fear was
  ever about.

**Bounded, not free — so read with a reason, never by enumeration.** A threads
read on a doc that is not already in memory still loads its whole `.ydoc`
synchronously and leaves it resident for two days — `IDLE_EVICT_MS` is what
releases it, and nothing shorter does. Walking one board's docs or one task's
threads costs that and nothing else: do it without asking.
Sweeping every doc on the server is a different animal and stays banned. On
2026-09-16 ~7,000 threads GETs took prod from 2,246 resident docs to 7,114 and
281MB RSS, with ~95s spent not answering, and woke 586→3,134 bindings that then
flushed weeks-old content over files on disk. The binding half of that is fixed;
the residency half is still exactly what a corpus-wide read would cost.

This is the local copy. The fleet copy SHIPS — in the
`claude-workspaces:working-in-a-workspace` skill and in the `list_threads`,
`get_thread` and `get_doc` tool descriptions, which is what reaches a peer on
another board at session launch without anyone telling them. Change one, change
all four. Gated by `packages/server/test/scan-does-not-activate.test.ts`, which
fails if a threads read ever arms a binding again. Story: grep
`docs/process/learnings.md` for "Reading a doc's threads".

**Watch for comments** via `watch_doc(docId)` — comment events arrive as `<channel source="claude-workspaces" doc_id="..." thread_id="..." event="...">` blocks. (Sessions still running a pre-rename bundle emit `source="live-feedback"`; the attribute changes when that session restarts, not when this rule does.) Resolve threads when you've addressed the feedback (`resolve_thread`).
