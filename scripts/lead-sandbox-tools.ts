/**
 * The tools a lead's config may open inside its wall (`tools: [...]`).
 * Turned into profile rules by `lead-sandbox-lib.ts`.
 *
 * - `adb`: reads `~/Android/Sdk/platform-tools`, and connects to adb's server
 *   on port 5037. Without it that port is refused, because the server on it
 *   drives every phone plugged into this Mac.
 */
import { join } from 'node:path';

export const LEAD_TOOLS = ['adb'] as const;
export type LeadTool = (typeof LEAD_TOOLS)[number];

/** The port adb's client finds its server on. */
export const ADB_SERVER_PORT = 5037;
export const ADB_SDK = 'Android/Sdk/platform-tools';

/** A lead's `tools`, checked, or the reason it is refused. */
export function parseTools(v: unknown, lead: string): LeadTool[] | string {
  if (v === undefined) return [];
  if (
    !Array.isArray(v) ||
    !v.every((t) => (LEAD_TOOLS as readonly unknown[]).includes(t)) ||
    new Set(v).size !== v.length
  )
    return `${lead}.tools must list distinct names from: ${LEAD_TOOLS.join(', ')}`;
  return v as LeadTool[];
}

interface ToolLead {
  name: string;
  tools: readonly LeadTool[];
}

/** What the lead may read and not write: each tool's files. */
export function toolReadPaths(lead: ToolLead, home: string): string[] {
  return lead.tools.includes('adb') ? [join(home, ADB_SDK)] : [];
}

/** Port 5037 is refused at every address unless the lead has `adb`. */
export function toolNetworkRules(lead: ToolLead, adbPort: number = ADB_SERVER_PORT): string[] {
  if (lead.tools.includes('adb')) return [];
  return [`(deny network-outbound (remote ip "*:${adbPort}")) ; adb's server`];
}
