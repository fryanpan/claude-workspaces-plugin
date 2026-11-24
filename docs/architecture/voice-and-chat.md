# Voice, the lead chat and editing a page's words

The widget's mic, the spoken reply, talking to one agent, the lead chat and its meeting, the planning voice, and editing or keeping unsent words on a page.

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

**The widget's mic, and voice feedback behind it.** The board's own widget
is bound to the Workspaces feedback doc, not to the board's project, so its
buttons are about the app; a served mock's are about the mock. On both, the
thread list shrinks to a chip and a microphone takes its slot.
`widget-mic.ts` is a top-level module of the widget package beside
`widget-card.ts`, but it is a SECOND ENTRY (`@claude-workspaces/widget/mic`)
that `widget.ts` never imports — it makes only the button, the readout and
their rules. Voice feedback itself is the widget's `voice/` directory, a third
entry (`@claude-workspaces/widget/voice`): `voice-session.ts` streams PCM over
`WS /workspaces/<ws>/docs/<docId>/voice` and writes the comments the server
settles through the ordinary thread routes (`voice-note-writes.ts`), and
reopens a socket that dropped mid-recording on a backoff while the microphone
keeps listening (`voice-redial.ts`), `voice-ui.ts` draws the live
comment and the settled cards (its styles in `voice-css.ts`, the column
layout in `voice-column.ts`), and `voice-mode.ts` glues them to the page (a
tap sends the next words to an element, or back into that element's earlier
note). Three kinds of page reach it, and none of them puts any of it in the
budgeted bundle. The board imports it directly
(`board/board-feedback-mic.ts`). A mock page gets the mic from
`mockup-live.js`. **An ordinary embed — a tag and a script on somebody else's
dev server — fetches it**: `widget-mic-inject.ts` is the few bytes in
`widget.iife.js` that append `<script src="<serverUrl>/widget/mic.js">` at
DOMContentLoaded, and `mic-entry.ts` is that chunk's entry, mounting the
button through the same `voice/voice-loader.ts` a mock goes through. Both are
top-level modules of the widget package; only the first is on the budget, and
it is reached from `widget-iife.ts` alone, so `widget.esm.js` and the board
pay nothing and the board's own mount is not doubled. `window.cwMic`, set at
module scope by `voice-loader.ts`, is how a page carrying `mockup-live.js`
tells the injector to stand down before either mount runs. Either way the
first tap fetches the lazy chunk `voice.js` (`voice/voice-loader.ts`), so a
page that never speaks pays for the button and nothing behind it. On the
tailnet name all of it goes through the widget door
(`middleware/widget-door.ts`), which admits the mic and the chunk without a
token and the socket, the thread verbs `edit-comment` and `reanchor`, and the
recordings with one. Inside a served mock's frame the browser
refuses the microphone to an opaque origin, so there the host page holds it
instead: `mock-host-mic.ts` (widget, a top-level module the host asset
bundles) opens the capture when the frame asks over its voice socket, streams
the audio into that socket itself, and never sends it into the frame;
`hostCapture` in `voice/voice-audio.ts` is the frame's side of the request. The DSP the meeting capture
already used moved to core's `pcm-audio.ts` so both captures share one
resampler and one worklet; `meeting-audio.ts` re-exports it.

On the server, `routes/upgrade-stream.ts` hands that socket to
`voice-feedback-relay.ts`, which runs the meeting's transcription engine and a
Haiku tidy (`voice-feedback-tidy.ts`) that decides which words become which
comment on which catalog element. The tidy runs at a pause in the talk, with a
ceiling for talk that never pauses; `voice-feedback-turns.ts` tracks which
heard words a note holds yet, and `voice-feedback-session.ts` holds the
relay's per-recording state types. `voice-feedback-store.ts` keeps each
recording's WAV and a timestamped raw transcript beside the doc
(`routes/doc-voice-feedback.ts` serves both). A comment's ▶ asks
`clipAudio` (`widget/src/widget-auth.ts`) for the audio: with no token held
that is the `<audio>` fetching the clip itself, with its byte ranges and its
`#t=` seek; with one it is a fetch carrying the Bearer header an `<audio>`
cannot set, played from a blob, which costs the whole recording rather than
the stretch the clip names. While the page is open, a spoken comment is the
thread POST the typed composer already makes, carrying a `voice` note (clip
and raw words). When the page goes without a Stop — a link followed, the
browser quit — the relay finishes the last note from the words it heard and
`voice-feedback-keep.ts` writes what the page could not, straight to the doc
store: it finds each note's thread by the id the page reported or by where
its clip starts, edits it, and creates only a note no thread holds. The
socket carries the upgrade's proven identity for that write; with none, the
speaker the page named at `start`.

A note whose element or meaning the tidy cannot settle gets one question.
`voice-feedback-ask.ts` decides whether the tidy's proposed question is
worth asking (never on a pinned note, never twice, two or three distinct
choices) and matches a short spoken answer without a model call;
`voice-feedback-question.ts` sends the question, says it in the spoken
reply's voice, and turns the answer into an edit of the same note, so the
page re-anchors or rewrites the thread it already made rather than adding
one.

**The spoken reply.** A held mic can get a spoken
answer rather than a line of text: Claude writes a short overview into a
panel above the mic and says its first two sentences, or asks one question
and waits. The words come from the voice router (`voice.ts`), so
fast paths and the hand-off to the lead behave exactly as on a plain mic;
what varies is who hears and who speaks, and four setups sit behind one
switch so they can be compared on the same board — Soniox alone, Soniox with
ElevenLabs Flash, Gemini Live, and ElevenLabs Agents, which also takes the
turns. The wire is `core/spoken-reply.ts`
(a new top-level core module: the messages and their parsers both ends read).
On the page, `board/spoken-reply-client.ts` owns the socket and the turn,
`spoken-reply-panel.ts` the panel's markup and states, `spoken-reply-audio.ts`
the capture and the player, and `spoken-reply-tap.ts` the taps; all four sit
inside `board/`. The voice page (`voice-page/`) mounts them, and the lead
chat's voice reuses the socket. The board's own mic, which mounted them on
the board when `GET /workspaces/<ws>/voice/timings` named a setup, was
removed on 2026-10-30. On the
server, `routes/upgrade-stream.ts` hands `WS /workspaces/<ws>/voice/converse`
to `spoken-reply/` (a new top-level server directory): `relay.ts` keeps one
`session.ts` per socket, `answer.ts` cuts the router's answer into a spoken and
a written part and adds the one question the router lacks ("which goal?"),
`lead-answer.ts` holds each person's requests to the lead for 30 minutes until
the lead answers through `POST /workspaces/<ws>/voice-queue/<id>/answer` (MCP
`answer_voice`), and says that answer on the socket that asked or, when that
one closed, on the next socket that person opens on the board,
`tts.ts` and `gemini-live.ts` are the vendor adapters, `keys.ts` reads their
keys from the Keychain at runtime, and `timings.ts` logs each answer's delay
from the end of the question to the first spoken word per setup. Setup 4 runs
the other way round: `elevenlabs-agent.ts` holds the ElevenLabs conversation,
`agent-turns.ts` drives it for one socket, and ElevenLabs calls back for each
reply on `POST /voice-agent/v1/chat/completions` (`routes/voice-agent-llm.ts`,
checked by `agent-llm.ts`), on the vendor callback hostname. The billed
engines are built only in `server-deps.ts`; a test server gets none, so every
setup reads as not set up and the plain mic stays.

Each spoken sentence is a point, and a point worth keeping carries a note:
its written wording, chosen in `spoken-reply/notes.ts` (what is waiting on
the listener, or a change the board just made). `spoken-reply/speak-points.ts`
says the points one voice call at a time and sends each note just before its
point's first audio; Gemini Live speaks one stream, so there every note goes
before the tool result that starts the voice. On the page,
`board/spoken-reply-notes.ts` shows each note as its point starts to play, in
a row the reply laid out for it, and `board/spoken-reply-turn.ts` builds the
turn's `timing` report, which now carries each note's lead.

"Go through my reviews" starts the review queue by voice.
`spoken-reply/review-walk.ts` reads each item's headline and options, answers
questions about it, and reads a decision back before anything is recorded.
The read-back, the yes and the one-utterance undo window are
`spoken-reply/confirm.ts`, kept apart so a doc follow-up can reuse it;
`review-words.ts` holds the words it listens for, and `review-speakable.ts`
the rule for which items stay on the queue for the screen. The server never
writes the answer itself: the reply carries a `decide`, and the page's
`onDecide` posts it to the route the answer card and its Undo already use.
The board mic was the one page that passed an `onDecide`, so since it went
(2026-10-30) a spoken decision is answered as not recorded. The request is built in `core/spoken-review.ts` (a new
top-level core module), so the card and the voice queue share one builder. A
ticket's review item gained the undo it lacked:
`routes/task-review-answer-undo.ts` over `review-items/undo-answer.ts`.

**Talking to one agent by name.** A `start` that names an agent id sends
every turn to that agent instead of the router: `spoken-reply/agent-conversation.ts`
checks the id against the socket's board, writes a row on that agent's
addressed comment queue (so an absent agent hears it at its next attach) and
sends the frame on that agent's streams alone, and `lead-answer.ts` says only
that agent's `answer_voice` aloud. Each turn carries the conversation so far
until the page names another agent. The page for it is `/voice?agent=<id>`
(`routes/voice-page.ts`, the owner's alone): `voice-agent-list.ts` (a new
top-level server module) lists the agents on every live board, and
`workspaces-app/src/voice-page/` mounts the board's spoken reply aimed at the
chosen one. Every other client talks through `voice-api/` (a new top-level
server directory, routed by `routes/voice-api.ts`): the OpenAI chat format,
one model per agent, a voice token of its own, and the same addressed row
and `answer_voice` wait underneath. Its contract is
[voice-conversation-api](voice-conversation-api.md).

**The lead chat.** Every board page, doc page and mock host carries an agent
button that opens one conversation with the board's lead. `lead-chat/` (a new
top-level server directory) keeps it: `log.ts` is one append-only
`<board>.lead-chat.jsonl` per board, the latest line per message id winning,
and `lead-chat.ts` sends a typed message exactly as a turn to one agent by
name (an addressed row, then one `voice.request` to the lead alone), takes the
lead's `answer_voice` first in `routes/workspace-attachments.ts`, and writes a
spoken turn to the lead from the converse socket into the same chat
(`AgentConversationLog`). Every change goes to the board's pages as a
`lead-chat.changed` frame and to no agent stream. A page is handed the
latest 50 messages and pages back from the oldest it shows
(`GET …/lead-chat?beforeTs=&beforeId=`) until the first: out of the 200 the
server holds, then off the log, up to 32 MB from its tail. The cursor is a
time and an id, not a log position, so another kind of entry kept elsewhere
can join the same list in the same order. The route is
`routes/workspace-lead-chat.ts` (read by a member, written by the owner);
the message shape is `core/src/lead-chat.ts` (a new top-level core module).
A message can carry photos and files: `lead-chat/files.ts` keeps them under
the board's data, the owner uploads through `routes/workspace-lead-chat-files.ts`,
and the lead reads one with the MCP tool `read_chat_attachment`, because a
walled lead cannot open the data folder. The composer's model chip reads
`lead-chat/lead-model.ts`, which the lead's hooks keep current through
`kind: 'model'` on `routes/lead-mirror.ts`, and it opens nothing. Switching
from the board is off: `routes/workspace-lead-chat-model.ts` answers 409
`model-switch-off`, and `lead-chat/pane.ts` is built but never called;
security.md says why.
The panel draws the lead's messages with the comments' escape-first
markdown renderer (`comment-markdown.ts`, which gains pipe tables and an
opt-in link for a bare URL) and a person's own as plain text.
A task link there wears the board row's own status ring rather than the
threads' word pill (`link-status-html.ts` draws either into the renderer's
string; the barred ring comes from `blocked` on the link lookup), and the
client's `onTaskChange` re-asks every ring when a task moves on the board
stream.
The chat also mirrors the lead's own Claude Code session, through the
plugin's hooks: UserPromptSubmit (a prompt typed in its terminal, or a board
event it took, to `routes/prompt-marks.ts`), Stop (the message a turn ended
on, to the notes route), and MessageDisplay and PostToolBatch (text it writes
mid-turn and its tool calls, to `routes/lead-mirror.ts`, kept by
`lead-chat/mirror.ts`). The last two post only for a session the prompts
route has answered `lead: true`. A message to the lead goes `received` when
the lead's MCP child acks its queue row and `done` at that session's turn
end. Nothing mirrored is handed back to the lead or spoken.
In the app, `workspaces-app/src/lead-chat/` (a new top-level directory) is
the client, the shadow-DOM button, bar and panel, and the per-device Chat
first / Voice first choice the Settings Voice row writes; the board mounts it
in its nav dock, the doc page floats it bottom-left, and the mock host loads
`lead-chat-page.ts` as its own `/app/lead-chat.js`. Its voice
(`lead-chat-voice.ts`) is the spoken reply's path: the mic streams over
`WS /workspaces/<ws>/voice/converse` with the lead named in `start`, so the
audio reaches only this server and the listener it already uses. There is no
browser speech recognition, because Chrome's sends the audio to Google.
While the page or a frame on it speaks with the browser's `speechSynthesis`,
the mic sends silence instead of what it hears, so an app's spoken line never
reaches the lead as a request. The server writes the speech watch
(`core/src/page-speech.ts`, a new top-level core module) into every mock, app
and doc-file frame, and `lead-chat/page-speech.ts` reads what the frames
post; the reasons are in [app-voice](app-voice.md).

**Messages (M10).** The board's Messages item opens that same chat, and the
chat's heading is a channel picker (`lead-chat/lead-chat-channels.ts`, wired
by `lead-chat-channel-wiring.ts`). `#general` is the board's lead chat as
above. The reader's own lead agent (`/api/me/messages`) and each other person
on the board are one-to-one channels, read by `lead-chat/dm-client.ts` over
the reader's own person stream. Person-to-person messages are
`server/src/direct-messages.ts` (a new top-level module: one log per pair
under `direct-messages/`, the private-message store's format) behind
`routes/direct-messages.ts` at `/workspaces/<ws>/me/dm`, which only a proven
person on the board reaches; a send is framed `direct.message` to the two
people's own streams and to no agent. The shapes are
`core/src/direct-messages.ts` (a new top-level core module). The board's
stream refuses a browser that names an agent (`?agentId=`), since frames
addressed to an agent carry a person's private messages to it;
`server/test/private-messages-every-route.test.ts` calls every route-table
row as a member, the owner's browser and the lead agent and finds neither
conversation.

**Tab titles.** Every page's browser tab starts with its workspace's name,
then the page's own name (`Harborlight · tides.md · Workspaces`), so several
boards open at once can be told apart in a tab strip. The board composes its
own (`boardTabTitle`, naming an open task or goal). A doc, diff or folder
page and a mock's host page go through `page-tab-title.ts` (a new top-level
module): the router names the board, the page names its thing, and a
`workspace.renamed` frame on the board's stream renames the tab in place.
The mock host's server-written `<title>` already leads with the name;
`mock-tab-title.ts` (new, loaded by `lead-chat-page.ts`) re-reads the doc's
title when `library.changed` says the list moved. Both readers of the board
stream on such a page share one `EventSource` through `board-stream.ts`
(new), so the title costs no extra connection. A share visitor's mock host
loads neither script, so its tab keeps the name it was served with.

**The lead chat's meeting.** The chat's Start a meeting runs one meeting per
board that belongs to the board rather than to a page.
`lead-chat/meeting.ts` (server) is one small file per board naming the notes
doc, the browser tab holding the microphone, who joined and the lines said,
written whole on every change and sent to the board's pages as
`lead-chat.meeting` / `lead-chat.meeting-line` frames. It is driven by
`POST /workspaces/<ws>/lead-chat/meeting` in the same route file; a fresh
line that opens with "Lead," goes to the lead as a voice turn, once per turn.
The recording itself is the doc meeting every other surface runs. In the
app, `meeting-link.ts` (a new top-level module, lifted out of
the doc page's retired `meeting-strip.ts`) is the meeting socket, its
held-audio bank and its resume backoff with no page around it;
`lead-chat/lead-chat-meeting.ts` drives it. A page move is a reconnect: the next page of the recording tab
resumes with `resume: <meetingId>`. `core/src/board-nav.ts` (a new top-level
core module) names the board's four pages and their glyphs, so the mock host
(`mockup-frame.ts`), which loads no app bundle, draws the same rail as the
board.

**How much of a meeting was heard.** `meeting-coverage-watch.ts` (a new
top-level server module, in the Meetings group) is one timer per recording
that notices no audio frame for a minute, or a socket that dropped and did not
come back, and hands the change to `LeadChatMeetings.coverageForDoc`, so every
page of the board shows it on the meeting's `coverage` field.
`meeting-coverage-stamp.ts` (also new, same group) writes the one coverage
line into the finished notes and the figures into `meeting.json`. The words
and the arithmetic both sides read are `core/src/meeting-coverage.ts` (a new
top-level core module). Detail: `meeting-assistant.md` "How much of a
meeting was heard".

**A mock or app that talks.** A page served in a board's frame can speak,
listen and post to its own dev server through
`WS /workspaces/<ws>/docs/<docId>/app-voice`. Its wire is `core/app-voice.ts`
(a new top-level core module). The client is `widget/src/app-voice/` (a new
top-level widget directory), built as its own `/widget/app-voice.js` and kept
out of `widget.iife.js`. The server half is `app-voice/` (a new top-level
server directory). `token.ts` signs a token naming the doc and the board,
`seed.ts` writes it into the frame for the owner when the frame's HTML names
the client, and `gate.ts` decides who is handed one and who may open the
socket. `session.ts` runs one socket on the spoken reply's engines, and
`say.ts` makes the write to the app. `routes/upgrade-stream.ts` checks the
token. `relay.ts` is called from `socket-handlers.ts`, the same way as the
other socket kinds. Inside the opaque frame, the socket goes through the host
page's relay, like the widget's own sockets. The design is
[app-voice](app-voice.md).

**The planning voice** rides the same socket. The doc's Talk button, which
opened it with `{ surface: 'doc', docId }` as each turn's context, was removed
with the doc's voice mic on 2026-10-30; the server half below is unchanged
and answers any client that opens the socket that way. On a doc on the socket's
board the session ends each turn only at a confirmed pause
(`spoken-reply/pause-gate.ts`: the listener's endpoint, then a quiet window
that is longer after a turn ending mid-sentence), and every turn is
`spoken-reply/interview.ts`'s: the first pause begins the run (in a
meeting, the first pause after its first minute, `MeetingWarmup`). It reads the
plan's gaps off the doc's outline (`interview-gaps.ts`: empty, placeholder,
open-question and short sections, ranked by heading), holds them as slots in
`interview-state.ts` (each asked once, then placed, skipped, deferred, gone or
ended; a silence after a question offers once to skip it), and after each
answer does one of four things: writes it under its heading with
`applyBlockEdits` (`interview-docs.ts`, so threads keep their anchors), asks
once for more after a bare "maybe", answers talk about the question (a
question back, a disagreement) with one sentence and keeps the same question
open (`interview-discuss.ts`, decided by the same judge call that picks the
answer), or says nothing after "I don't know yet" and asks its next question
at the next pause. While it asks, its cursor is on
the words it means: the server sets an `agentFocus` field on its own
awareness state for the doc, and `doc/agent-focus.ts` on every open page
scrolls there and highlights them in the agent's colour. "skip", "come back
to that" and "that's enough" are `interview-phrases.ts`. `interview-log.ts`
records each section's question-to-answer time and each answer's
`after-answer` outcome as log lines and rows in
`<dataDir>/interview-timings.jsonl`, with no doc text. The doc must be on the
socket's board, checked as the router checks it. Every reply it speaks is one
sentence of at most 20 words (`oneSentence`, `interview-phrases.ts`); the
rest of what it has to say is written on the page.

A learning-goals doc, one with a "What I want to do better" heading, gets a
looser interview instead (`interview-goals.ts`). It asks at most the coach's
name and "what do you want to do better?", each once, and then follows the
speaker: one model call per spoken pause (`interview-goals-place.ts`, with a
rule when there is no model) names every change, so several goals said at
once each become a bullet in the goals section, and "change the first one
to …" replaces that goal's block. A goal the owner typed becomes a proposal
instead, so the owner's words are never deleted. The four-part `###` sections of
older goals docs are never asked.

The same answerer speaks in a bot meeting. `meeting-claude.ts` (a top-level
server module) reads each final turn `recall-meeting.ts` records and acts only
when it opens with "Claude," and the speaker's Recall participant email is the
owner's (`CW_OWNER_EMAIL`); a display name never counts. It writes a minute
into the meeting's notes only when the answer holds one (`minuteFor`), and
says the first sentence into the call
through Recall's `output_audio`, as MP3 from `tts.ts`. It is on unless
`CW_MEETING_CLAUDE=0`, and a bot that may speak is created with audio output
switched on. `scripts/recall-say.ts` (`bun run meeting:say`) is the
live check that Recall plays audio at all.

**Editing the words on a page.** The reader can change a page's text in
place, and the agent is told what changed; the widget never writes the page's
source. The pencil is `edit/edit-button.ts`, mounted by `mic-entry.ts` and
`mockup-live.ts` right after the mic, so like the mic it costs the budgeted
bundle nothing. Its first tap fetches the lazy chunk `edit.js`
(`edit/edit-entry.ts`), as does a page whose doc already holds an edit that
has not been applied, so its marks paint on load. `edit/edit-mode.ts` makes
the tapped element editable — Enter splits a paragraph, Cmd-B, Cmd-I and
Cmd-K add the three marks an edit carries (`edit/edit-keys.ts`), and
`edit/edit-markdown.ts` reads the element as markdown — keeps the reader's unsent edits
(`edit/edit-model.ts`), and draws every mark in a fixed layer of its own
rather than restyling the page. Send is the ordinary thread POST with a
`pageEdits` list on the first comment: each entry is the element's anchor, a
short CSS selector, the words before, and the words after as a small
markdown. `core/src/page-edits.ts` reads and caps that list;
`core/src/page-edits-text.ts` holds that markdown's reader and writes the
comment's text from the list — one line saying what was edited, then each
change as a word diff, with selectors left to the list — and
`routes/doc-threads-routes.ts` refuses a malformed one outright. It rides
`thread.created`, so there is no new event: the MCP channel line
(`mcp/src/channel-messages.ts`) carries the list as `page_edits` and tells the
agent to apply each edit to the source and resolve the thread. An edit counts
as applied once its thread is resolved, or once the element's words match the
edit's after-text without the reader having typed them in this visit. On the
tailnet name the door admits `edit.js` without a token, as it does the other
scripts.

**Unsent words across a reload.** A comment half-typed and edits not yet sent
come back when the page reloads under the reader. `draft-store.ts`, a
top-level module of the widget package, keys both in `sessionStorage` by doc
and page; the composer (`widget-picker.ts`, in the budgeted bundle) writes on
every keystroke, `widget-restore.ts` reopens it at load, and `edit/edit-mode.ts` does the same
for edits, the pencil loading `edit.js` when a draft waits. Inside a mock's or
an app's sandboxed frame there is no browser storage, so `mock-bridge.ts`
sends draft keys to the host page, which files them under its own doc in its
`sessionStorage` (`mock-host.ts`) and hands them back when the frame asks on
load. No server route and no event: the drafts never leave the browser.
