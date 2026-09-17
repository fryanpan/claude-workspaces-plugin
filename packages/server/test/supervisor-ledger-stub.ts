/**
 * The watchdog's restart ledger, in memory.
 *
 * One copy rather than one per test file, because the ledger now carries two
 * lists and a stub that forgot the second would quietly give every supervisor
 * the base grace — which is to say, it would pass.
 *
 * The ledger's own cases — the file, the limit, the backoff arithmetic — are
 * `supervisor-restarts.test.ts`. This reads and writes nothing.
 */
import type { RestartHistory, RestartLedger } from '../src/supervisor-restarts.ts';

export type MemoryLedger = RestartLedger & { history: RestartHistory };

export function memoryLedger(seed: Partial<RestartHistory> = {}): MemoryLedger {
  const ledger: MemoryLedger = {
    history: { restarts: seed.restarts ?? [], unbound: seed.unbound ?? [] },
    load: () => ({ restarts: [...ledger.history.restarts], unbound: [...ledger.history.unbound] }),
    save: (h: RestartHistory) => {
      ledger.history = { restarts: [...h.restarts], unbound: [...h.unbound] };
    },
  };
  return ledger;
}
