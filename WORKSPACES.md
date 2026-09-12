# Where docs go in this project

This project keeps its docs in the repo rather than in the workspace server's
data dir. `docs/` and `docs/meetings/` are mounted, so a file you write under
them shows on the board's Library page where anyone can read and comment on
it.

Read this before writing a new doc. When a kind of doc has no home here, make
the folder and add its row below in the same change.

## The roots

| Root | What it holds | In git? |
| --- | --- | --- |
| `docs/product/` | Vision, decisions, design notes | Committed |
| `docs/product/plans/` | Implementation plans | Ignored by default — see below |
| `docs/architecture/` | The overview, and one summary per subsystem | Committed |
| `docs/process/` | Delivery, retros, the learnings archive | Committed |
| `docs/proposals/` | A change being argued for, before it is agreed | Committed |
| `docs/research/` | A dated question somebody dug into | Ignored by default — see below |
| `docs/meetings/` | Meeting notes and their records | Ignored |

## Plans and research are written in the open, not committed by default

This repo is public. Plans and research notes get written here while the work
is in flight, bound to a live review doc, and most of them never belong in the
history. So `.gitignore` holds `docs/product/plans/*.md` and
`docs/research/*.md`.

Those patterns untrack nothing. The plans and notes already in the repo stay
tracked and their changes stay visible; what the patterns stop is a
`git add -A` sweep that pulls in a draft naming another team's tickets.
Publishing a new one is a deliberate act: scrub it, then `git add -f <path>`.

## Meetings stay on the box

`docs/meetings/` carries a `.gitignore` holding `*`, written by the server
because this project chose to keep its meetings out of git. Delete that file
to commit them instead.

A meeting's raw record — `*-raw-transcript.md`, its `-replay-` reruns and the
`.pcm` audio beside them — is blocked repo-wide by the root `.gitignore` and
refused by `scripts/scrub-check.py`. A transcript of what people said in a
room is not something to push by accident.

## Mockups never enter the repo

Write the HTML outside the working tree and serve it with `attach_mockup`.
`demos/` ships two directories only, `demos/dev-server/` and `demos/mockup/`;
everything else at its top level is ignored.
