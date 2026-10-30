/**
 * Step 4 of the transcript store's test-bucket proof, staged: one day of a
 * test host's uploads across a midnight, through the uploader and the
 * inventory themselves, with four faults for the check (`store-check.ts`)
 * to find:
 *
 *   corrupt    the day's first transcript chunk is overwritten with a flipped byte
 *   delete     the chunk sent just after midnight, which holds bytes written
 *              before it, is deleted
 *   skip       a second session's last lines before midnight are never sent:
 *              its uploader stops at 23:59
 *   duplicate  one put lands but its answer is lost, so the next pass sends
 *              the same bytes again under a new name
 *
 * Both midnights' inventories are written, so the day after can be checked
 * as well: its window starts inside the chunk sent just after the midnight.
 *
 * The clock is simulated, so the day can be any date; the faults are made
 * with the admin credential. A day already staged is refused, because its
 * inventory would be overwritten.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recipientOf } from './seal.ts';
import { inventoryKey, takeInventory, writeInventory } from './store-inventory.ts';
import { type Bucket, s3Bucket, statusOf } from './store-s3.ts';
import {
  FLY_HOST,
  type SetupOps,
  type StoreTestNames,
  TEST_BOARD,
  readCredential,
} from './store-setup.ts';
import { type ObjectStore, type StoreKeys, type UploadSource, runOnce } from './store-upload.ts';

export interface DrillFaults {
  corrupt: boolean;
  delete: boolean;
  skip: boolean;
  duplicate: boolean;
}

export interface DrillResult {
  /** The first transcript chunk's key. */
  firstKey: string;
  /** The chunk deleted, when `delete` was staged. */
  deletedKey: string | null;
}

const line = (row: object) => `${JSON.stringify(row)}\n`;

export async function stageDrill(
  names: StoreTestNames,
  ops: Pick<SetupOps, 'keychainRead'>,
  scratch: string,
  day: string,
  wanted: Partial<DrillFaults>,
  log: (line: string) => void,
): Promise<DrillResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`--day must be YYYY-MM-DD, not ${day}`);
  const faults: DrillFaults = {
    corrupt: true,
    delete: true,
    skip: true,
    duplicate: true,
    ...wanted,
  };
  const bucket = (entry: string): Bucket => s3Bucket(readCredential(ops, entry), names.bucket);
  const writer = bucket(names.writer);
  const reader = bucket(names.reader);
  const admin = bucket(names.admin);
  const midnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
  const next = new Date(midnight).toISOString().slice(0, 10);
  if ((await statusOf(() => reader.get(inventoryKey(FLY_HOST, next)))) === 200) {
    throw new Error(`${day} is already staged in ${names.bucket}; pass another --day`);
  }
  const at = (secondsFromMidnight: number) => new Date(midnight + secondsFromMidnight * 1000);
  const id = (n: string) => ops.keychainRead(n).trim();
  const keys: StoreKeys = {
    review: recipientOf(id(names.identities.review)),
    owner: recipientOf(id(names.identities.owner)),
    boards: { [TEST_BOARD]: recipientOf(id(names.identities.board)) },
  };

  const dir = join(scratch, 'drill');
  mkdirSync(dir, { recursive: true });
  const t = join(dir, 't.jsonl');
  const s = join(dir, 's.jsonl');
  const e = join(dir, 'e.jsonl');
  const tName = `drill-${day}-t`;
  const all: UploadSource[] = [
    { path: t, kind: 'transcript', name: tName, board: TEST_BOARD },
    { path: s, kind: 'transcript', name: `drill-${day}-s`, board: TEST_BOARD },
    { path: e, kind: 'event', name: `drill-${day}.events`, board: TEST_BOARD },
  ];
  const tChunks: string[] = [];
  let loseNext = false;
  const store: ObjectStore = {
    async put(key, body) {
      await writer.put(key, body);
      if (!key.startsWith(`${FLY_HOST}/transcripts/${TEST_BOARD}/${tName}/`)) return;
      tChunks.push(key);
      if (loseNext) {
        loseNext = false;
        throw new Error('the answer to this put was lost (staged)');
      }
    },
  };
  const statePath = join(dir, 'state.json');
  const pass = (seconds: number, sources: UploadSource[] = all) =>
    runOnce({
      sources,
      store,
      statePath,
      host: FLY_HOST,
      keys,
      classOf: () => 'private',
      now: () => at(seconds),
    });
  const turn = (who: string, n: number) =>
    line({
      type: 'assistant',
      message: { content: `${who} turn ${n} on the Riverbend test board` },
    });

  writeFileSync(t, turn('Alice', 1));
  writeFileSync(s, turn('Bob', 1));
  writeFileSync(e, line({ type: 'task.created', by: 'Alice', n: 1 }));
  await pass(-120);
  appendFileSync(t, turn('Alice', 2));
  appendFileSync(s, turn('Bob', 2));
  if (faults.duplicate) {
    loseNext = true;
    await pass(-60).then(
      () => {
        throw new Error('the staged lost answer did not fail the pass');
      },
      () => {},
    );
    await pass(-50);
  } else {
    await pass(-60);
  }
  appendFileSync(t, turn('Alice', 3));
  appendFileSync(s, turn('Bob', 3));
  appendFileSync(e, line({ type: 'comment.added', by: 'Bob', n: 2 }));
  const inv = takeInventory({ sources: all, statePath, host: FLY_HOST, now: at(0) });
  await writeInventory(inv, writer, keys);
  const afterMidnight = faults.skip ? all.filter((x) => x.path !== s) : all;
  appendFileSync(t, turn('Alice', 4));
  const before = tChunks.length;
  await pass(30, afterMidnight);
  const straddling = tChunks[before] ?? null;
  appendFileSync(t, turn('Alice', 5));
  await pass(90, afterMidnight);
  // The next midnight's inventory too, so the day after can be checked: its
  // window starts inside the chunk sent just after this midnight.
  await writeInventory(
    takeInventory({ sources: all, statePath, host: FLY_HOST, now: at(86_400) }),
    writer,
    keys,
  );

  const firstKey = tChunks[0];
  if (!firstKey || !straddling) throw new Error('the drill sent fewer chunks than it expects');
  if (faults.corrupt) {
    const body = await admin.get(firstKey);
    body[body.length - 20] = (body[body.length - 20] ?? 0) ^ 1;
    await admin.put(firstKey, body);
  }
  if (faults.delete) await admin.delete(straddling);
  const made = (Object.keys(faults) as (keyof DrillFaults)[]).filter((k) => faults[k]);
  log(
    `staged ${day} across the midnight before ${next}: ${inv.files.length} files, faults: ${made.join(', ') || 'none'}`,
  );
  return { firstKey, deletedKey: faults.delete ? straddling : null };
}
