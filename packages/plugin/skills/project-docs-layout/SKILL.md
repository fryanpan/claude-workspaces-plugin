---
name: project-docs-layout
description: Use when setting up a project's docs and attachments on a workspace, when a new doc has no obvious home, or before mounting a folder that holds client, personal or third-party material.
user-invocable: true
---

# Project Docs Layout

Every project gets one conventions index and as many mounted folders as it has kinds of artifact. The tool descriptions carry the mechanics; this is what they don't tell you.

## Gitignore and privacy are two switches, and neither implies the other

A mount is a **filesystem walk**, not `git ls-files`. Gitignored and untracked files are mounted and served exactly like tracked ones — `.gitignore` keeps a file out of the repo and does nothing to keep it off the workspace. The only control over who sees a mounted file is `set_project_privacy`.

- **Keeping the repo lean and keeping material off the network are separate decisions.** Decide both, out loud, before mounting.
- **`local-only` is not a soft setting.** It blocks the tailnet too, so the human cannot open those files from a phone. Choose it when the material must not leave the box, not as a precaution.
- **Set privacy before the first mount** on anything sensitive. A mount serves the moment it exists.
- Only `.git`, dotdirs, `node_modules`, `dist`, `build`, `.next` and `coverage` are skipped, and credential-shaped names are never served. Everything else under the folder is in.

## Order

1. `register_worktree` for every checkout that exists — including ones you create later. Unregistered, the same file in a second checkout is a different doc with different comments.
2. `set_project_privacy` if the project is anything but ordinary.
3. Write the conventions index, then `set_project_conventions` to point at it. The verb records the location; you write the file.
4. `mount_folder` per kind of artifact. Never the repo root — a 20,000-file ceiling exists and a truncated mount is a mount that was too broad.

## The index is the project's words, and the project decides what is committed

Write it short and in the project's own voice: plans here, meeting notes here, attachments here, make folders as needed. Say for each root whether it is **committed or gitignored** — that choice is the project's, never the fleet's, and an index that is silent on it produces a repo full of screenshots or a folder nobody knows is disposable.

## Before writing any new doc

`read_project_conventions`, then put the file under a root it names. `text: null` means no index exists yet — write one at the path it returns first, rather than dropping the doc somewhere and moving it later.

## Three shapes

| Project | Mount | Privacy | Committed? |
| --- | --- | --- | --- |
| Research notes collecting PDFs and transcripts | `sources/` | `workspace` | Gitignored — large and third-party, but still readable on the board |
| A client engagement | `deliverables/` | `local-only`, set first | Committed to a private repo; the human reads it at the desk, not on a phone |
| A UI project with generated screenshots | `docs/screenshots/`, plus `register_worktree` on the QA checkout | `workspace` | Gitignored — regenerated every run, and one screenshot is one doc from either checkout |
