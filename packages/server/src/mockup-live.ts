import type { MockupVersion } from './mockup-versions.ts';

/**
 * The half-kilobyte of markup that makes a served mockup a LIVE surface.
 *
 * A mockup round used to be a new page at a new link: the agent rebuilt the
 * HTML, bound it under a fresh name, and the reviewer had to leave whatever he
 * was reading to go and find the review item pointing at it. Bryan's answer to
 * "should a round replace the page under the same link" was **same link** — so
 * the page a reader already has open becomes the next round where it stands,
 * and his comments come with it.
 *
 * The behaviour lives in `/widget/mockup-live.js`, built from
 * `packages/widget/src/mockup-live.ts`. This module only writes the tag that
 * loads it and the data it needs, for the same reason `mockup-widget.ts`
 * writes the widget embed here rather than expecting an agent to type it into
 * the file: the page on disk is somebody's own artifact, often generated,
 * sometimes committed, and review scaffolding must never become part of it.
 *
 * The round list is an ATTRIBUTE rather than a fetch. The page already knows
 * everything the version control needs at the moment it is served, so shipping
 * it inline costs one attribute and saves an endpoint — and adding an endpoint
 * would mean adding a rule about who may read it, for a fact the page it is
 * attached to has already disclosed.
 */

const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Last `</body>`, case-insensitive — the insertion point when there is one. */
const BODY_CLOSE = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i;

/** Already carries the live script (a page served twice through one pipe). */
const ALREADY_LIVE = /mockup-live\.js/i;

export interface MockupLiveInfo {
  docId: string;
  workspaceId: string;
  /** The round these bytes are, or null for a mockup with no rounds yet. */
  version: number | null;
  versions: MockupVersion[];
}

/**
 * The `?v=` parameter, as a round number.
 *
 * `null` means "no round asked for" — serve the live file, as this route
 * always has. `'bad'` is a value that was supplied and is not a round: a
 * refusal, not a fallback, because silently serving the current page to
 * someone who asked for round 4 shows them the wrong thing under a 200.
 */
export function parseVersionParam(raw: string | null): number | 'bad' | null {
  if (raw === null) return null;
  if (!/^[0-9]{1,9}$/.test(raw)) return 'bad';
  const n = Number(raw);
  return n >= 1 ? n : 'bad';
}

/** The script tag itself, so a test can assert what a page is handed. */
export function mockupLiveEmbed(info: MockupLiveInfo): string {
  // Version numbers only, comma-joined: the control needs to know which rounds
  // exist and which one is on screen, and nothing else. Timestamps and byte
  // counts are what a caption would be made of, and a mockup page gets no
  // caption (Bryan: affordances over explanatory text).
  const list = info.versions.map((r) => r.v).join(',');
  return (
    `<script src="/widget/mockup-live.js" data-cw-live` +
    ` data-doc-id="${escapeAttr(info.docId)}"` +
    ` data-workspace-id="${escapeAttr(info.workspaceId)}"` +
    ` data-version="${info.version ?? ''}"` +
    ` data-versions="${escapeAttr(list)}"></script>`
  );
}

/**
 * Return `html` with the live-update script added. Appends when there is no
 * `</body>`, exactly as the widget embed does — a fragment without one is
 * still a page somebody is reviewing.
 */
export function injectMockupLive(html: string, info: MockupLiveInfo): string {
  if (ALREADY_LIVE.test(html)) return html;
  const embed = mockupLiveEmbed(info);
  if (BODY_CLOSE.test(html)) return html.replace(BODY_CLOSE, `${embed}$&`);
  return `${html}${embed}`;
}
