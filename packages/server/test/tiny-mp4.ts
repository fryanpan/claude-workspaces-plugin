/**
 * The bytes of a small MP4 container: an `ftyp` box naming `isom`, then one
 * `free` box padded to `size` bytes in total. Enough for a content type and a
 * range test to tell one offset from another; it is not a playable movie.
 * Byte `i` of the padding is `(i + seed) & 0xff`, so two files differ.
 */
export function tinyMp4(size = 4096, seed = 0): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, 20);
  out.set(new TextEncoder().encode('ftypisom'), 4);
  view.setUint32(12, 0x200);
  out.set(new TextEncoder().encode('isom'), 16);
  view.setUint32(20, size - 20);
  out.set(new TextEncoder().encode('free'), 24);
  for (let i = 28; i < size; i++) out[i] = (i + seed) & 0xff;
  return out;
}
