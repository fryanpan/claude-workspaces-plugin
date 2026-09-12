/**
 * Which review size each signed-in person last chose — Easy, Medium or Hard.
 *
 * The choice follows the person, not the device: the owner moves between an
 * iPad and a phone in one day, and a choice kept only in one browser's
 * storage would greet the other device with the wrong size. So the server
 * holds it, keyed by identity id, and a browser's localStorage is only a
 * cache that paints the bar before this answers.
 *
 * One small JSON file (`review-size-prefs.json`), rewritten whole through a
 * temp file on each change. Nobody signed in has no row, and the page falls
 * back to its cache, then to Hard.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ReviewSize, parseReviewSize } from '@claude-workspaces/core';

const FILENAME = 'review-size-prefs.json';

export class ReviewSizePrefs {
  private readonly path: string;
  private readonly byIdentity = new Map<string, ReviewSize>();

  constructor(dataDir: string) {
    this.path = join(dataDir, FILENAME);
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>;
      for (const [id, value] of Object.entries(parsed)) {
        const size = parseReviewSize(value);
        if (size) this.byIdentity.set(id, size);
      }
    } catch {
      // A corrupt file costs each person one tap to choose again.
    }
  }

  get(identityId: string): ReviewSize | undefined {
    return this.byIdentity.get(identityId);
  }

  set(identityId: string, size: ReviewSize): void {
    this.byIdentity.set(identityId, size);
    mkdirSync(join(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(this.byIdentity))}\n`);
    renameSync(tmp, this.path);
  }
}
