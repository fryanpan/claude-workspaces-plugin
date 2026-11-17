import type { DocStateArea, DocStateStore, KeepOutcome } from './store.ts';

interface Saved {
  bytes: Uint8Array;
  savedAt: number;
}

/**
 * Doc state in maps, for tests and small apps that need no disk.
 *
 * The state outlives a `DocStore`, not the process: a restart is a new
 * `DocStore` handed this same instance, which is how the tests restart.
 * Bytes are copied on the way in and out, so a caller that reuses its buffer
 * cannot change what was saved.
 */
export class MemoryDocStateStore implements DocStateStore {
  readonly kind = 'memory';

  private readonly areas: Record<DocStateArea, Map<string, Saved>> = {
    live: new Map(),
    archive: new Map(),
  };
  private readonly staged = new Map<string, Saved>();
  private readonly kept = new Map<string, Uint8Array>();

  constructor(private readonly now: () => number = Date.now) {}

  has(docId: string, area: DocStateArea = 'live'): boolean {
    return this.areas[area].has(docId);
  }

  read(docId: string): Uint8Array | null {
    const saved = this.areas.live.get(docId);
    return saved ? saved.bytes.slice() : null;
  }

  write(docId: string, state: Uint8Array): void {
    this.areas.live.set(docId, { bytes: state.slice(), savedAt: this.now() });
  }

  savedAt(docId: string): number | undefined {
    return this.areas.live.get(docId)?.savedAt;
  }

  list(): string[] {
    return [...this.areas.live.keys()];
  }

  move(docId: string, from: DocStateArea, to: DocStateArea): boolean {
    if (from === to) return true;
    const saved = this.areas[from].get(docId);
    if (!saved) return true;
    this.areas[to].set(docId, saved);
    this.areas[from].delete(docId);
    return true;
  }

  stageDelete(docId: string): boolean {
    const saved = this.areas.live.get(docId);
    if (!saved) return true;
    this.staged.set(docId, saved);
    this.areas.live.delete(docId);
    return true;
  }

  unstageDelete(docId: string): void {
    const saved = this.staged.get(docId);
    if (!saved) return;
    this.areas.live.set(docId, saved);
    this.staged.delete(docId);
  }

  dropStaged(docId: string): void {
    this.staged.delete(docId);
  }

  remove(docId: string): boolean {
    this.areas.live.delete(docId);
    return true;
  }

  keepBeforeCompaction(docId: string, original: Uint8Array): KeepOutcome {
    if (this.kept.has(docId)) return 'exists';
    this.kept.set(docId, original.slice());
    return 'written';
  }

  keptCopyLabel(docId: string): string {
    return `memory:${docId}.pre-compact`;
  }

  /** The copy `keepBeforeCompaction` kept, for tests. */
  keptCopy(docId: string): Uint8Array | undefined {
    return this.kept.get(docId)?.slice();
  }
}
