/** What `lead-chat-history-browser-driver.ts` prints, read by
 *  `lead-chat-history-browser.test.ts`, and the conversation it seeds. */

/** Messages in the board's log before the page opens: more than the server
 *  holds in memory (200), so the oldest pages come off the log. */
export const HISTORY_SIZE = 230;

/** The lead's last message: every element the chat draws, then a script tag
 *  and an inline handler that must not run. */
export const MARKDOWN_SAMPLE = [
  '## Saltmarsh plan',
  '',
  'Read **the bold part** and *the italic part* and `inline code`, then [the pull request](https://example.com/pr/1) or https://example.com/ci/2.',
  '',
  '- first bullet',
  '- second bullet',
  '',
  '1. step one',
  '2. step two',
  '',
  '| Gate | Result |',
  '|---|---|',
  '| lint | pass |',
  '',
  '```',
  'const riverbend = 1;',
  '```',
  '',
  '<script>window.__leadChatRan = "script"</script><img src=x onerror="window.__leadChatRan = \'img\'">',
].join('\n');

export interface MarkdownRead {
  heading: string | null;
  bold: string | null;
  italic: string | null;
  inlineCode: string | null;
  links: Array<{ href: string | null; text: string; target: string | null; rel: string | null }>;
  bullets: string[];
  numbered: string[];
  tableHead: string[];
  tableCells: string[];
  codeBlock: string | null;
  scripts: number;
  images: number;
  handlers: number;
  /** What the sample's script or handler set, had either run. */
  ran: string | null;
  scriptAsText: boolean;
  /** The person's own message: tags in it are text. */
  mineTag: number;
  mineText: string | null;
}

export interface HistoryWidthRun {
  width: number;
  firstOpen: { ids: string[]; history: string | null; scrollable: boolean };
  markdown: MarkdownRead;
  /** A message posted from elsewhere showed in the open chat within 1s. */
  liveWithin1s: boolean;
  /** Pages read back from the first open to the first message. */
  pages: number;
  /** For each page, how far in pixels the line the reader was on moved. */
  anchorDrift: number[];
  atFirst: { ids: string[]; history: string | null };
  reloaded: { ids: string[]; texts: string[] };
  elsewhere: string;
}

export interface HistoryRun {
  widths: HistoryWidthRun[];
}
