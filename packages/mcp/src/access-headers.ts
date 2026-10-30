/**
 * The Access service token on this child's requests to its server. The code
 * is in the plugin's hooks lib, because the hooks run from the installed
 * plugin and can import nothing from here; the bundle inlines it.
 */
export * from '../../plugin/hooks/lib/access-headers.ts';
