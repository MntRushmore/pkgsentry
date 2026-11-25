import { DAY_MS } from '../cache.js';
import type { EcosystemContext } from '../ecosystems/types.js';

const API = 'https://api.osv.dev/v1';

interface OsvRange {
  type: string;
  events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  database_specific?: { cwe_ids?: string[] };
  affected?: Array<{ package?: { name: string; ecosystem: string }; ranges?: OsvRange[]; versions?: string[] }>;
}

export interface OsvFinding {
  /** Advisories that mark the package (or the requested version) as malware. */
  malicious: Array<{
    id: string;
    summary: string;
    /** Every version, past and future (range introduced at 0, never fixed). */
    allVersions: boolean;
    /** Explicitly listed affected versions, if the advisory lists them. */
    versions?: string[];
  }>;
  /** Ordinary vulnerabilities. Only collected when an exact version was requested. */
  vulnerable: Array<{ id: string; summary: string }>;
}

// Matches how GHSA/PYSEC phrase malware advisories ("crossenv is malware", "Malicious Package in x",
// "Embedded malware in ua-parser-js") without catching CVEs like "leak via malicious URLs".
const MALWARE_TEXT =
  /\bis malware\b|\bmalware in\b|\bcontains? malware\b|\bmalicious (?:code|package|versions?|script|dependency)\b|\bembedded (?:malicious|malware)\b|\btyposquat/i;

export function isMalware(v: OsvVuln): boolean {
  if (v.id.startsWith('MAL-')) return true;
  if (v.database_specific?.cwe_ids?.includes('CWE-506')) return true;
  return MALWARE_TEXT.test(v.summary ?? '');
}

/** True when the advisory covers every version (introduced 0, never fixed). */
export function affectsAllVersions(v: OsvVuln): boolean {
  for (const a of v.affected ?? []) {
    for (const r of a.ranges ?? []) {
      const intro = r.events.some((e) => e.introduced === '0');
      const closed = r.events.some((e) => e.fixed !== undefined || e.last_affected !== undefined);
      if (intro && !closed) return true;
    }
  }
  return false;
}

export async function queryOsv(
  ecosystem: string,
  name: string,
  exactVersion: string | undefined,
  ctx: EcosystemContext,
  opts: { popular: boolean },
): Promise<OsvFinding> {
  return ctx.cache.wrap(`osv:${ecosystem}:${name}@${exactVersion ?? ''}`, DAY_MS / 4, async () => {
    const query: Record<string, unknown> = { package: { name, ecosystem } };
    if (exactVersion) query.version = exactVersion;
    const res = await ctx.http.postJson<{ results?: Array<{ vulns?: Array<{ id: string }> }> }>(
      `${API}/querybatch`,
      { queries: [query] },
    );
    if (res.status !== 200) throw new Error(`OSV returned HTTP ${res.status}`);
    const ids = (res.body?.results?.[0]?.vulns ?? []).map((v) => v.id);

    // Without a pinned version, popular packages have long vuln histories that say
    // nothing about the latest release. Only MAL- entries matter there.
    const toFetch = exactVersion || !opts.popular ? ids.slice(0, 15) : ids.filter((id) => id.startsWith('MAL-'));
    const vulns = await Promise.all(
      toFetch.map(async (id) => {
        const r = await ctx.http.getJson<OsvVuln>(`${API}/vulns/${encodeURIComponent(id)}`);
        return r.body ?? { id };
      }),
    );

    const finding: OsvFinding = { malicious: [], vulnerable: [] };
    for (const v of vulns) {
      const summary = v.summary?.trim() || v.id;
      if (isMalware(v)) {
        const versions = (v.affected ?? []).flatMap((a) => a.versions ?? []);
        finding.malicious.push({ id: v.id, summary, allVersions: affectsAllVersions(v), ...(versions.length ? { versions } : {}) });
      } else if (exactVersion) {
        finding.vulnerable.push({ id: v.id, summary });
      }
    }
    return finding;
  });
}
