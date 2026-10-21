# App voice

A mock or an app on the board can speak, listen and write to its own dev
server, with one script tag. A deliberation prototype, for example, can say
a question aloud, hear the person's answer until their turn ends, and post
what they said to the prototype's backend.

```html
<script src="/widget/app-voice.js"></script>
<script>
  const voice = await cwAppVoice.connect();
  await voice.speak('Which site should open first?', { tone: 'warm' });
  voice.on('turn-end', (text) => voice.say(text));
  await voice.listen();
</script>
```

Only the board's owner gets a working page. Nothing said on the socket
reaches the board's answerer or any agent.

## The problem it solves

A served mock runs in a frame with an opaque origin, so every request it
makes carries `Origin: null`. Every sandboxed page anywhere sends the same
value, so the origin cannot tell the server which page is asking. The write
gate and every other socket refuse it for that reason. The frame's requests
also carry no cookie, so behind Access they cannot reach the board at all.

## How a frame proves it is doc D on board W

1. **The server writes a token into the frame.** When it serves the frame
   of a mock (`routes/shell-static.ts`) or an attached app
   (`routes/apps.ts`), and the page names `/widget/app-voice.js`, the
   server puts `<script type="application/json" data-cw-app-voice>` into
   the head (`app-voice/seed.ts`). The element holds the socket's path, a
   token and its expiry. A page that does not load the client gets
   nothing.
2. **The token names the doc and the board.** The format is
   `av1.<ws>.<doc>.<exp>`, signed through `auth/signed-token.ts` with a key
   of its own (`app-voice/token.ts`). It expires after 10 minutes. The
   socket compares both ids with its own path, so a token for another doc
   or another board does not open the socket.
3. **Only the owner is handed one.** `mayMintAppVoice` (`app-voice/gate.ts`)
   gives a token to the signed-in owner. Where sign-in is not required, a
   page that proved nobody also gets one, because that is the local,
   trusted case. A share or collab visitor gets none, and so does a
   signed-in person who is not the owner.
4. **The socket checks again at the upgrade.** `refuseAppVoice` refuses
   these, in this order:
   - a share visitor: 403
   - a signed-in non-owner: 403
   - an origin that is not `null`, absent, an allowed browser origin or the
     frame hostname: 403
   - a missing or bad token: 401

   The route is `trusted-local` in `routes/route-table-rows.ts`.
5. **The socket goes through the host page.** The board's page that holds
   the frame relays it (`mock-host.ts`), as it relays the widget's own
   sockets. The host page has the cookie, so the socket gets past Access.
   `mock-relay-policy.ts` allows `…/docs/<this doc>/app-voice` and no other
   doc's socket, keeps the token in the query and adds `cw-via=mock-frame`.
   A frame on the frame-only hostname relays in the same way. A page in its
   own tab connects directly.

The token travels in the query, not in a subprotocol, because the relay
does not pass subprotocols. That puts it in access logs. It opens one doc's
socket for 10 minutes and nothing else, so we accept that cost.

None of the three existing token schemes fits. The share link-session
cookie and the auth session cookie are cookies, and the frame's script must
not be able to read either one. The widget popup token names a person and a
widget origin but no doc, so a mock that held one could open another doc's
socket.

## The wire

`packages/core/src/app-voice.ts` defines the wire. The page sends JSON as
text frames and its microphone audio as binary frames. The server answers
with JSON, and sends speech as binary frames.

| Page sends | Server answers |
| --- | --- |
| *(on open)* | `ready {voice, listen, say, outputRate: 24000, inputRate: 16000}` |
| `speak {text, tone?, id?}` | `speaking {id}`, binary PCM16 at 24 kHz, `spoken {id, stopped}` |
| `stop` | the line in progress ends with `spoken {stopped: true}` |
| `listen`, then binary PCM16 at 16 kHz | `listening`, then `heard {text}` each time the transcript grows, and `turn-end {text}` when the turn ends |
| `unlisten` | nothing |
| `say {text, id?}` | `said {id, status}` |
| *(every 4 minutes)* | `token {token, expiresAt}` |
| *(anything refused)* | `error {code, message, id?}` |

- **Speaking:** the voice is the spoken reply's (setup 1's Soniox voice,
  else setup 2's). A new `speak` stops the line before it. `tone` is
  accepted, but no voice uses it yet.
- **Listening:** the listener is the spoken reply's, with its tap tuning,
  so the listener's own end of speech ends a turn. It stays open for the
  next turn. If it hears words during a `speak` that are not that line's
  own echo, it stops the line and sends `cut-in {text, id}`
  (`spoken-reply/cut-in.ts`).
- **Writing:** `say` posts `{"text": …}` as JSON to `<app origin>/say`
  (`app-voice/say.ts`). It sends no credentials, follows no redirect and
  stops waiting after 10 seconds. A mock is not an app, so a mock's `say`
  gets the error `not_an_app`. The socket makes this request because the
  page cannot: a frame's `POST` carries `Origin: null`, and the app proxy
  answers only GET and HEAD.
- **Limits:** a line is at most 2,000 characters, a `say` at most 8,000,
  and an audio frame at most 64 KB.

## The client

`/widget/app-voice.js` is a bundle of its own, not part of `widget.iife.js`
(`widget/src/app-voice/`, about 7 KB). `cwAppVoice.connect({ seed?, play? })`
reads the seed from the page, opens the socket and resolves after `ready`.
With `play: false` it plays nothing, and the page takes the `audio` events
itself.

| Call | Does |
| --- | --- |
| `abilities` | `{voice, listen, say}` from `ready` |
| `speak(text, {tone})` | resolves `{stopped}` once the line has played |
| `stop()` | silences the line now |
| `listen({mic})` | starts hearing; `mic: false` hears only `sendAudio` |
| `unlisten()` | stops hearing and closes the microphone |
| `sendAudio(pcm)` | one 16 kHz PCM16 frame from the page's own capture |
| `say(text)` | resolves the status the app's dev server answered |
| `on('heard' \| 'turn-end' \| 'cut-in' \| 'error' \| 'audio' \| 'close', fn)` | returns an unsubscribe |
| `close()` | ends the socket |

After a drop, the client reconnects up to five times with the newest token
the server sent, and listens again if it was listening. When the token it
holds has expired, it stops trying and sends `close`.

## What does not work yet

- **The microphone inside the sandboxed frame.** A frame with an opaque
  origin cannot call `getUserMedia`. `listen()` with the microphone works
  only in a page in its own tab, or on the frame-only hostname once that
  hostname is live. A sandboxed mock can still hear audio that it captures
  some other way and sends with `sendAudio`.
- **Tone.** No voice on the server takes one.
- **An app's cross-origin reads.** The app proxy still drops
  `Access-Control-Allow-Origin`. `say` covers the write a talking app
  needs, and nothing else changed.

## Where it is written

| Part | File |
| --- | --- |
| Wire format, pure | `packages/core/src/app-voice.ts` |
| Token | `packages/server/src/app-voice/token.ts` |
| Who is handed one, and who may open the socket | `packages/server/src/app-voice/gate.ts` |
| Writing it into the frame | `packages/server/src/app-voice/seed.ts` |
| One socket: speak, listen, say, refresh | `packages/server/src/app-voice/session.ts`, `say.ts`, `relay.ts` |
| Upgrade | `packages/server/src/routes/upgrade-stream.ts` |
| Client | `packages/widget/src/app-voice/` |
| Relay allowlist | `packages/widget/src/mock-relay-policy.ts` |

## Tests

- `packages/server/test/app-voice-socket.test.ts`: a real server and an app
  frame. It covers speak, listen to `turn-end`, `say` reaching the app, and
  refusal of a missing, expired or other-doc token and of a foreign origin.
- `packages/server/test/app-voice-gate.test.ts`: who is handed a token, and
  refusal of a share visitor and a non-owner at the upgrade.
- `packages/server/test/app-voice-session.test.ts`: cut-in, a new line
  stopping the old one, the limits, and the token refresh.
- `packages/widget/test/app-voice-client.test.ts`: the client against a
  scripted socket.
- `packages/widget/test/app-voice-mock.test.ts`: a served mock in headless
  Chromium speaks and hears a turn end through the relay. It runs only when
  `CW_BROWSER_TESTS` is set, as it is in CI.
