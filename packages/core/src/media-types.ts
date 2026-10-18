/**
 * The files in an attached folder that open as media — a video that plays or
 * an image that shows — rather than as text, keyed by lower-case extension.
 *
 * One table, read by both halves: the server serves these and only these from
 * a set's raw route (`routes/review-raw.ts`) and never copies their bytes into
 * a doc, and the review page mounts a player instead of the code viewer for
 * the same names. Two lists would let a file open as a player whose source the
 * server refuses.
 */
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

/** The media content type of `path`, or undefined for anything else. */
export function mediaTypeOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const ext = name.slice(dot).toLowerCase();
  return Object.hasOwn(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext] : undefined;
}
