/**
 * "Is this socket still carrying bytes?"
 *
 * A socket can stop carrying bytes with nothing telling the browser: a tablet
 * sleeps, a network changes, a tunnel drops a connection. The page then shows
 * `open` for good and never hears another change. Bun's own pings cannot help,
 * because a browser hides them from the page.
 *
 * So a page may send this one-byte frame and the server answers it with the
 * same byte. It shares the varuint kind prefix of the document protocol
 * (`server/src/yjs-protocol.ts`, `ws-client.ts`). A client that never sends one
 * never gets one.
 */
export const MSG_PROBE = 3;
