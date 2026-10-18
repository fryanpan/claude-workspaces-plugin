import { extname } from 'node:path';

/**
 * What a file in an attached folder opens as, decided by its extension.
 *
 * Three answers. A MEDIA file (a video or a raster image, `mediaTypeOf` in
 * `@claude-workspaces/core`, which the review page reads too) opens on a page
 * that plays or shows it, its bytes streamed from the raw route
 * (`routes/review-raw.ts`) and never copied into a doc. An UNSUPPORTED file
 * is a binary the review has no surface for — an archive, an executable, a
 * font, an office document — so the scan leaves it out and says so, rather
 * than listing it and opening it as a page of garbage text. Everything else
 * opens as text, as it always has.
 *
 * By name, never by content: the scan lists every file in the folder, and
 * opening each one to sniff it would read the whole tree on every rescan.
 */

const UNSUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    // Archives and disk images.
    '.zip .gz .tgz .tar .bz2 .xz .7z .rar .dmg .iso .pkg',
    // Executables and object code.
    '.exe .dll .so .dylib .o .a .class .jar .wasm .bin',
    // Fonts.
    '.woff .woff2 .ttf .otf .eot',
    // Audio, and video containers a browser does not play.
    '.mp3 .m4a .wav .flac .ogg .aac .avi .mkv .wmv .flv',
    // Office and design documents, databases, and images a browser cannot show.
    '.pdf .doc .docx .xls .xlsx .ppt .pptx .pages .numbers .sqlite .db .psd .ai',
    '.heic .tif .tiff .bmp .ico',
  ].flatMap((group) => group.split(' ')),
);

/** Whether `relPath` is a binary the review has no surface for. */
export function isUnsupportedType(relPath: string): boolean {
  return UNSUPPORTED_EXTENSIONS.has(extname(relPath).toLowerCase());
}
