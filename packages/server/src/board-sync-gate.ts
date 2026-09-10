/**
 * Whether a reconnecting client's history may merge into a board doc — and
 * the answer, for one specific case, is no.
 *
 * Compaction rebuilds a `ws:` doc into entirely new clientIDs. Sync is a
 * state-vector exchange, so a tab that was open across the restart offers a
 * vector the server's doc covers NONE of, and the honest reading of the
 * protocol is "you have 5 MB I have never seen — send it". It does, the
 * server merges it, the projection re-deletes the trimmed fields, and the
 * tombstones stay. Measured against a copy of the live board: 969,990 bytes
 * back up to 2,975,791 on the first restart with one such tab, and roughly
 * +18.7 KB on every restart after that, because the tab absorbs each new
 * rebuild and pushes the whole accumulation back. One open tab is enough.
 *
 * The answer is not to filter structs by age. It is that for THIS kind of doc
 * the client cannot hold an authoritative edit at all: a `ws:` doc is a
 * projection, every row is reasserted from the task sidecar, and
 * `board-projection.ts` on the client says in as many words that it never
 * mutates the ydoc. So a state vector sharing nothing with a board doc is
 * stale BY CONSTRUCTION, and "your state is dead, reload" is a truer answer
 * than merging its history back in.
 *
 * **Disjointness alone, not "and the doc was rebuilt this boot."** That extra
 * condition was the first shape of this gate and it left the hole it was
 * meant to close. A tab that does not act on the reset — which is every tab
 * running the bundle that shipped BEFORE this, and those are precisely the
 * tabs that were open across the deploy — is refused on the boot that
 * rebuilds, keeps its stale doc, and is merged in on the NEXT boot, because
 * by then the doc on disk is already compact and nothing rebuilt it. Measured
 * on a copy of the live board: 973,310 bytes held at boot, then 2,983,799 on
 * the restart after it, alternating from there. Disjointness already proves
 * the server shed what the client is holding — a board client that has never
 * written cannot have got those structs any other way — so the rebuild flag
 * was a proxy for a fact the vectors state outright.
 *
 * **Scoped to `ws:` in the code, not by where it is called from.** The
 * argument above is false for a bound markdown doc, where a client's offline
 * edits are real work and dropping them is data loss — so the prefix is asked
 * here, beside the reason, rather than left to every caller to remember.
 *
 * ## Why refusing is not enough on its own
 *
 * A refused tab still HOLDS its pre-restart structs, and its Y.Map entries
 * are concurrent with the rebuild's — neither doc knows the other. Yjs
 * resolves a concurrent map set by clientID magnitude, which is a coin flip:
 * driven 200 times over exactly this merge, the rebuild won 100 and the stale
 * state won 100. So a tab that is refused and not told would show its
 * pre-restart value for about half its rows, permanently. That is worse than
 * the re-inflation. The refusal and the reset go together, which is why the
 * caller sends `MSG_RESET` on the same decision that sets the flag.
 */
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { isWorkspaceProjectionDoc } from './doc-ids.ts';

/** The sync sub-kinds, from y-protocols/sync. Named rather than imported so
 *  the parse below reads as a parse and not as protocol participation. */
const SYNC_STEP_1 = 0;

/** What a client's opening sync frame said, when it said anything we act on. */
export interface ParsedSyncFrame {
  /** The sub-kind: 0 = step 1, 1 = step 2, 2 = update. */
  step: number;
  /** The state vector, present only on step 1. */
  stateVector: Uint8Array | null;
}

/**
 * Read a sync frame's sub-kind, and its state vector when it carries one.
 *
 * A PEEK: it decodes a copy and never touches the decoder the real handler
 * uses, so nothing here can change how the frame is applied. Returns null on
 * anything malformed — a frame this cannot parse is one the gate has no
 * opinion about, and the ordinary handler is still free to reject it.
 */
export function peekSyncFrame(frame: Uint8Array): ParsedSyncFrame | null {
  try {
    const dec = decoding.createDecoder(frame);
    decoding.readVarUint(dec); // the MSG_SYNC kind, already read by the caller
    const step = decoding.readVarUint(dec);
    if (step !== SYNC_STEP_1) return { step, stateVector: null };
    return { step, stateVector: decoding.readVarUint8Array(dec) };
  } catch {
    return null;
  }
}

/** What the decision needs. Every field is something the caller already has. */
export interface StaleClientCheck {
  /** The doc being synced. Only a `ws:` doc can answer true — see the header. */
  docId: string;
  /** The client's state vector, as its sync step 1 carried it. */
  clientStateVector: Uint8Array;
  /** The doc's own, `Y.encodeStateVector`. */
  docStateVector: Uint8Array;
}

/**
 * Is this client holding a state the doc it is joining can never reconcile?
 *
 * True only when all three hold: the doc is a board projection, the client HAS
 * a state (an empty vector is a fresh tab, which is the ordinary case and must
 * never be refused — that is also what stops a reload loop, since a reloaded
 * tab comes back with nothing), and not one of its clientIDs appears in the
 * doc.
 *
 * "Not one" rather than "not all" is deliberate. A client that shares even a
 * single clientID has some causal overlap with this doc, which means it is
 * not the case this exists for, and merging is the safe reading.
 */
export function clientStateIsDead(check: StaleClientCheck): boolean {
  if (!isWorkspaceProjectionDoc(check.docId)) return false;
  let client: Map<number, number>;
  let doc: Map<number, number>;
  try {
    client = Y.decodeStateVector(check.clientStateVector);
    doc = Y.decodeStateVector(check.docStateVector);
  } catch {
    // An unreadable vector is not evidence of anything. Merge, as before.
    return false;
  }
  if (client.size === 0) return false;
  for (const clientId of client.keys()) {
    if (doc.has(clientId)) return false;
  }
  return true;
}
