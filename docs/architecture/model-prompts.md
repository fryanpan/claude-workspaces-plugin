# Model steps and prompts

The voice router's model seam and the prompt catalog every model call reads its prompt from.

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

**The voice router's model step is a seam.** `voice-classifier.ts` holds
the type `VoiceRouter` asks (`VoiceClassifier`) and the shipped one,
`jsonClassifier`, over `voice-prompt.ts`. `voice-choice.ts` asks the same
decision as one choice question over the routes plus "none", and
`voice-jev.ts` builds that question for TypeSafe's Jev with an injected
transport and no address. Production asks the choice question
(`routerClassifier`, chosen by `voiceRouterArm` in `bin.ts`) unless the owner
has rewritten the router prompt on the settings page, which only the JSON
prompt reads; test servers keep the JSON arm. Both are arms of the router
eval (`scripts/voice-router-eval.ts`). The choice question offers the quick
actions as options: `voice-quick.ts` holds those actions, which the page does
with no agent (another board, a plan or a meeting, feedback about the app,
help), their word-only detectors, and every ack of six words or fewer.
`voice-meeting-context.ts` is what a meeting's "Claude, …" is asked with
besides its words — the doc's text and the room's last two minutes — and
the fence both prompts and the lead's line put it in.

**Model prompts are a subsystem, not a scatter of literals.** Every set of
words this server sends to a model is one row of `prompt-catalog.ts`, and
`prompt-store.ts` keeps whatever the owner has rewritten in
`<dataDir>/prompts.json`. Each caller — the notes composer, the meeting
capture extractor, the voice router — takes its
instructions as a **thunk** and calls it per tick, so an edit made on
`/settings/prompts` reaches the next model call without a restart or a
deploy. The shipped default for each stays beside the code that builds the
rest of its message (`notes-prompt-store.ts`, `meeting-capture-prompt.ts`,
`voice-prompt.ts`, `core/summary-prompt.ts`), and the catalog imports them;
the store never holds a default, only an override. The notes composer's own
half of that — assembling the tick's whole prompt — came out to
`notes-prompt-build.ts` when the compose started taking a prompt cache: it
returns the prompt already split at the line the cache breakpoint is taken
on, and `meeting-notes-composer.ts` is left with the HTTP seam.
`notes-prompt-cache-shape.ts` sits beside them as an instrument rather than a
step: it holds the previous tick's block digests so the timing row can say
whether a tick that read nothing had a prefix that MOVED or one still under
the model's minimum cacheable length. It changes no prompt and no breakpoint,
which is why it is not drawn in the flow. Two of the six are
fields on a **board** rather than on the server and keep being written
through `PUT /api/workspaces/<id>/settings` — `routes/prompts.ts` says so
with `scope` rather than serving them twice, and the client hides the split.

Every default is **markdown with `###` sections** (2026-09-11), and a caller
that changes a prompt before it goes out does it by heading, never by an
exact sentence: `prompt-sections.ts` cuts, replaces and appends whole
sections, so a solo meeting drops `### Speakers and links` and a ledger
method swaps `### Grouping` however the owner has reworded their bodies.
`prompt-markdown-migration.ts` is the one-shot move of stored overrides onto
those defaults — an override that is an old default word for word is
soft-cleared, any other is kept and marked "written before markdown" — run
by `prompt-store.ts` on a version-1 `prompts.json` and by the board hydrate
on the two board fields.
