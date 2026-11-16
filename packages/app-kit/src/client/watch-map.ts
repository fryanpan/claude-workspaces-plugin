/**
 * Render a shared map now and after every change to it, at any depth. For a
 * dashboard whose tiles the server writes: the page only reads.
 */
import type * as Y from 'yjs';

export function watchMap(
  map: Y.Map<unknown>,
  render: (value: Record<string, unknown>) => void,
): () => void {
  const draw = (): void => render(map.toJSON() as Record<string, unknown>);
  map.observeDeep(draw);
  draw();
  return () => map.unobserveDeep(draw);
}
