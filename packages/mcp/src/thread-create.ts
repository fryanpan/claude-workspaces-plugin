/**
 * Where a `create_thread` call goes.
 *
 * Two endpoints, and the choice between them is the whole decision: with a
 * `find` string the thread anchors to that text; without one it is about the
 * document itself. The second case exists because a board task's discussion is
 * about the task, and a fresh task's description is empty — there is nothing
 * in it to find.
 */

export interface ThreadCreateInput {
  docId: string;
  /** Text to anchor to. Omit to open a thread on the subject. */
  find?: string;
  contextBefore?: string;
  contextAfter?: string;
  occurrence?: number;
  /** On an app: the page `find` is on, as its address inside the app. */
  path?: string;
  /** On an app or a mock: new words for `find`, for the reader to Accept or
   *  Reject on the page. Passed through; the server checks it. */
  suggest?: unknown;
  text: string;
  /** An optional Review Item declaration. Passed through untouched — the
   *  server validates it and refuses a malformed one, so a shape check here
   *  would be a second copy of one rule, free to drift from the first. */
  review?: unknown;
  /** Who the comment is for: ids, emails or names. Passed through; the
   *  server resolves each against the board's roster and refuses the rest. */
  to?: unknown;
}

export interface ThreadCreateRequest {
  path: string;
  body: Record<string, unknown>;
}

export function threadCreateRequest(
  input: ThreadCreateInput,
  author: unknown,
  /** `/workspaces/<id>` — the board the doc is filed on. Both addresses are
   *  under it now, which is why this is an argument and not a default. */
  board: string,
): ThreadCreateRequest {
  const doc = encodeURIComponent(input.docId);
  // Deliberately `=== undefined` rather than falsy: omitting `find` is a
  // choice, computing an empty one is an accident. An empty string keeps
  // going to by_find, which answers 400, instead of silently becoming a
  // comment on the whole document.
  if (input.find === undefined) {
    return {
      path: `${board}/docs/${doc}/threads`,
      body: {
        author,
        text: input.text,
        anchor: { kind: 'subject' },
        ...(input.review !== undefined ? { review: input.review } : {}),
        ...(input.to !== undefined ? { to: input.to } : {}),
      },
    };
  }
  return {
    path: `${board}/docs/${doc}/threads/by_find`,
    body: {
      author,
      text: input.text,
      find: input.find,
      ...(input.contextBefore !== undefined ? { contextBefore: input.contextBefore } : {}),
      ...(input.contextAfter !== undefined ? { contextAfter: input.contextAfter } : {}),
      ...(input.occurrence !== undefined ? { occurrence: input.occurrence } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.suggest !== undefined ? { suggest: input.suggest } : {}),
      ...(input.review !== undefined ? { review: input.review } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
    },
  };
}
