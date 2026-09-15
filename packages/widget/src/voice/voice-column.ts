/** Space between two cards in the column. */
const GAP = 10;

/**
 * Where each card in the column stands, or null for one that waits behind its
 * pin. `spots` come most important first: the ones kept are the first that
 * fit the column's height together, so opening one card's raw words moves the
 * others rather than hiding one while there is still room. The kept cards
 * stand in the order of the elements they are about — so leader lines never
 * cross — each as near its element as the cards above and below allow.
 */
export function stackColumn(
  spots: ReadonlyArray<{ h: number; want: number }>,
  top: number,
  room: number,
): Array<number | null> {
  const out: Array<number | null> = spots.map(() => null);
  let used = 0;
  const kept: number[] = [];
  spots.forEach((sp, i) => {
    if (used + sp.h > room - top) return;
    used += sp.h + GAP;
    kept.push(i);
  });
  kept.sort((a, b) => (spots[a]?.want ?? 0) - (spots[b]?.want ?? 0) || a - b);
  let floor = top;
  for (const i of kept) {
    const sp = spots[i] as { h: number; want: number };
    const y = Math.max(floor, Math.min(sp.want, room - sp.h));
    out[i] = y;
    floor = y + sp.h + GAP;
  }
  let ceiling = room + GAP;
  for (const i of [...kept].reverse()) {
    const sp = spots[i] as { h: number; want: number };
    const y = Math.max(top, Math.min(out[i] as number, ceiling - GAP - sp.h));
    out[i] = y;
    ceiling = y;
  }
  return out;
}
