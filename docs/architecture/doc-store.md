# The doc store: identity, folders, bound files and residency

How a document is identified, how mounted folders and attachment sets carry it, how a bound file and its live doc stay in step, and the doc-store modules that load, cache and evict docs.

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

The file is the source of truth at rest, the live doc at runtime, both
directions debounced — which is why a plain `Write` to a bound file loses: the
doc reasserts itself a second later while git still exits 0. The doc→file
direction is never refused, so a doc emptied in the editor empties its file;
`file-binding.ts` first copies what the file held into the data dir's
`clobber-backups/` (`<docId>-emptied-<ms>.md`) and logs the path, and the
editor offers Undo for the same edit (`mass-delete-undo.ts`). A file change
the doc did not write, landing on un-flushed edits, is a conflict: the file's
version is backed up there too and the live doc is written over it. While one
of our own writes is still on the thread pool, a flush does not read the file
at all and re-arms instead, because the file then holds our bytes under an
mtime not yet recorded, and reading it would back up our own write as an
outside change. A new field needs
three additions, MCP tool schema, route and service, and the route is the one
nothing type-checks, so add an HTTP-level test for every new parameter. The
audio socket is the meeting's lifecycle: every way it can end ends the meeting
exactly once, and nothing word-rate enters the SSE buffer.
**A document's identity is the repo and the path, not the checkout.** Four
server modules hold that, and they sit in the doc-store group beside
`doc-origin-repo.ts` because they answer the same question one layer up.
`doc-key.ts` derives the key — the repo's origin URL (or, with no remote, its
main directory) plus the path from the repo root — reading git's plumbing
files directly rather than spawning anything. `repo-registry.ts` is the lookup
table from that key to a doc id, plus the checkouts of each repo somebody has
registered; it is a table of ALIASES, never a rename, because every component
of a key can change and a saved link must keep resolving; its file half —
the shape on disk, the atomic write, and the refusal to overwrite a registry
that did not parse — is `repo-registry-file.ts`, and its checkout rows — adding
one, retiring one softly, and listing the checkouts that exist right now — are
`repo-registry-checkouts.ts`, so the class beside them holds only the
decisions about when to write. `doc-copies.ts`
looks at all the copies one key names and says which is live, which have
drifted, and when the answer is a question rather than a value;
`doc-live-copy.ts` is the half that acts on that verdict — moving the binding,
recording drift, or refusing with a table of candidates for a person to choose
from. `routes/repos.ts` is the family that exposes the registry and that
refusal over HTTP, loopback-only for the reason the deploy route is: every
value in it is a path on this machine. Nothing here changes how a doc id is
minted — ids are still random and still minted in one place — so the picture
above is unchanged: this is a lookup in front of it.

**A project's mounted folders reuse that identity for files that are not
documents.** `mount-registry.ts` is the table — which subfolders of a repo the
lead mounted, the `f-` address each file in them answers at, whether the
project's files may leave the machine, and where its conventions index lives —
with `mount-registry-file.ts` as its shape on disk. It keeps its own
`mounts.json` beside `repos.json` rather than living inside it: the repo
registry is written on every bind, and a mount table changes for unrelated
reasons; the two are joined by `repoKey` through `RepoRegistry.repoInfo`, so a
repo that re-keys carries its mounts across. `mount-scan.ts` is the walk and
the move fingerprint — a `stat` pass over folders measured in tens of
gigabytes, so nothing is read whole and only files that vanished or appeared
are ever hashed. `mount-store.ts` is every decision that needs a filesystem:
where a relative path is joined, what a mount currently holds, and the
reconcile that turns a rename into an alias so an address and its comments
follow the file. `routes/mounts.ts` carries two gates in one family — the
lead's table is loopback-only like `routes/repos.ts`, and a file's address is
member-facing but absent from `shareScopeAllows`, narrowed further to
on-the-box callers when the project is marked local-only. Retention is the
project's throughout: unmounting is soft and nothing under a mount is ever
deleted.

**An attachment set carries the same privacy without a project.** A folder
bound with `attach_folder` needs no git checkout, so it has no project to be
marked local-only. `attachment-privacy.ts` keeps the answer per set id in its
own `attachment-privacy.json`, because a set's members are opened lazily and a
flag copied onto each one could be missed. `server.ts` asks it once per
request, right after admission and before the websocket upgrades, so no
file route has to remember to.

**A folder says what it left out, and plays what it holds.** `fs-scan.ts`
lists a set's folder with `git ls-files -z` (a name with a byte above 0x7f is
otherwise C-quoted and names no file), and `scanFolderReport` adds every file
the listing left out and why, for a bind's `skipped`; a bind's `include`
admits ignored files by name (`admitIncluded`), and its answer's `listed`
names every file it listed and `links` gives each its page link. A link to a
file nobody has opened yet opens its doc on the first request
(`openListedMember`); `files` stays the docs the bind opened, only the entry.
`fs-listing.ts` caches that listing per root and is what decides which files
of a set may be opened (`isListedFile`, `landsOnListed`); a listing more than
five seconds old still answers and is rescanned off the main thread, so no
page request waits on `git` until the listing is thirty seconds old.
`folder-file-types.ts`
names the binaries no surface can show, which the listing leaves out. A video
or raster image (`core/src/media-types.ts`, read by server and page alike)
becomes a member with no binding; `routes/review-raw.ts` streams its bytes
with range requests, and `workspaces-app/src/media/` mounts the player in
place of the code view.

Three more modules put the documents that already exist onto that identity,
and none of them runs on the server's own clock. `doc-identity-plan.ts` is a
pure planner — it takes the corpus as an io parameter and says which key each
document would claim, which documents would collapse onto one, and which it
cannot place — so the dry run is the same code as the run.
`doc-identity-migration.ts` is the half that touches disk: it files the
claims, copies each losing document's conversation into the winner through
`doc-thread-merge.ts`, asserts that the thread count before equals the count
after, and commits its journal and its claims together — `doc-identity-journal.ts`
holds that record and the revert that reads it back, because the journal and
the registry are written at one point and a run that cannot write one must
file neither. `doc-identity-check.ts` reads that record back long after the
run and asks whether each merged winner still holds the threads its losers
hold — read-only, and the only mode of the script that is safe with the server
up, because a write lost AFTER a run is invisible to the run's own parity
assertion. Only `doc-thread-merge.ts`
is reachable from the running server's future; the other two are driven by
`scripts/migrate-doc-identity.ts`, by hand, because a corpus walk that spawns
git and hydrates documents is not something a restart should do.
`doc-identity-renames.ts` is the fourth, split off because it is the only part
that runs a subprocess and the only part holding state between calls: one
`git log` per repository, memoized, because a corpus of thousands of documents
cannot afford one per document.

`note-list-gap-repair.ts` and `note-list-gap-corpus.ts` join that group and
change nothing about the picture: another corpus walk nothing on the server
calls, driven by `scripts/repair-note-list-gaps.ts`. They split the way the
doc-identity pair does — the first decides and rewrites a `Y.Doc` it is
handed and never sees a filesystem, the second walks a data directory, takes
the backup and writes. It repairs the documents whose notes read
with blank lines between them — an empty paragraph a browser left at a
section end, which stopped each new note joining the list above it — by
moving the stranded items into that list and re-minting the comment anchors
at the offsets they held. The defect that made them is fixed in
`packages/core/src/prose-batch.ts`; this is only the documents already
written.

`doc-load-sites.ts` joins the doc-store group and moves no boundary. It names
the caller that brought each doc into memory — the first stack frame outside
`doc-store.ts`, read once per doc loaded, never per read — so the
`[doc-store] mem` line can end `loaded=+N by=<site>*n,…` after `held=`, and
`/api/metrics` carries the since-boot `loads`. `held=` says what keeps a
resident doc; this says what loaded it, which is the question when the count
jumps. It found the board projection re-arming every task body whenever a
board doc came back into memory (`TaskProjection.armLoadedBody` now arms a body
as it loads instead).

`doc-residency.ts` joins the doc-store group and moves no boundary. It is the
eviction WINDOWS as a pure function over each resident doc's clocks — a week
for a doc a person's editor left, for at most 500 such docs, and thirty minutes
for anything else — while `doc-store.ts` keeps the holds, the flush and the
sweep. It replaced a flat two-day window after prod's idle event-loop blocks
of 2.4-2.7s (2026-09-28) under swap: every resident doc is heap a full GC
walks, ~62KB each, so the count is the lever. The same fix gave the
`event-loop.ts` block line the CPU, major page faults and heap across the
block, so the next idle block says which of GC, page-in or descheduling it was.

`doc-catalog.ts` joins the doc-store group and moves no boundary; the diagram's
`doc-*.ts` already draws it. It is what `DocStore` answers about a doc without
opening it — the listing rows, the alias table and the `.ydoc` mtimes a listing
reports as activity — moved out of `doc-store.ts` whole, behind a host of
thunks like the other collaborators. `DocStore` keeps `list`, `threadCounts`
and the rest as one-line forwarders, so no caller changed.

`doc-state/` joins the doc-store group and moves no boundary. It is where each
doc's shared state — the Yjs update behind a markdown doc, a board, a
whiteboard or a component's state — is kept, behind one interface keyed by doc
id (`doc-state/store.ts`). `doc-state/disk.ts` is the `.ydoc` files in the
data dir, written exactly as before, and is the default;
`doc-state/memory.ts` keeps the same state in maps, for tests and small apps,
chosen by passing `docState` to `DocStore`. `DocStore`, `doc-catalog.ts`,
`file-binding.ts` and the archive moves in `doc-store-workspaces.ts` read and
write state only through it. The sidecar, the index row and the `.md`
write-back are not behind it and stay files in the data dir. The offline
tools (`doc-identity-*`, `note-list-gap-corpus.ts`, `activity-backfill.ts`)
still read `.ydoc` files directly and run on the disk backend only.

`cold-threads-cache.ts` joins the doc-store group and moves no boundary. It
keeps the threads `DocStore.peekThreads` decoded off a cold doc's `.ydoc`, so
Home's review queue and the stall pass decode an unchanged doc once rather
than on every read, and it wraps the `doc-state/` store so every write, move or
removal forgets that doc's entry. It holds `Thread[]` only, never a `Y.Doc`,
bounded by doc count and by estimated text. It outlives a restart: shutdown
and the boot warm write it to `cold-threads.json` in the data dir, and the next
start reads it back, trusting an entry only while its `.ydoc` still has the
mtime it was decoded at. On the disk backend only.

`doc-create-conflict.ts` joins the doc-store group and moves no boundary; the
`doc-*.ts` glob draws it. It decides whether a create naming an existing doc
would repoint that doc to another file or type, which `POST
/workspaces/<ws>/docs` then refuses with 409 `doc_exists`.
