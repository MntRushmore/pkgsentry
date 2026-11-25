import type { Cache } from '../cache.js';
import type { Http } from '../http.js';
import type { EcosystemId, PackageMeta } from '../types.js';

export interface EcosystemContext {
  http: Http;
  cache: Cache;
}

/**
 * Everything pkgsentry needs to know about one package ecosystem.
 *
 * To add an ecosystem (cargo, go, rubygems...):
 *   1. Implement this interface in src/ecosystems/<id>.ts
 *   2. Register it in src/ecosystems/index.ts
 *   3. Add a data/top-<id>.json list and teach scripts/refresh-top.mjs to build it
 *   4. Teach src/parse.ts the ecosystem's install commands
 * See CONTRIBUTING.md for a walkthrough.
 */
export interface Ecosystem {
  id: EcosystemId;
  /** Name shown to humans, e.g. "PyPI". */
  displayName: string;
  /** Ecosystem name used by the OSV.dev API. */
  osvEcosystem: string;
  /** Canonical form for comparisons (PEP 503 for PyPI, lowercase for npm). */
  normalize(name: string): string;
  /** Returns an error message if the name can never exist on this registry. */
  validateName(name: string): string | undefined;
  /** True if `version` is an exact version (not a range or tag). */
  isExactVersion(version: string): boolean;
  fetchMeta(name: string, version: string | undefined, ctx: EcosystemContext, opts: { popular: boolean }): Promise<PackageMeta>;
  /** Weekly downloads, 0 if the registry has no record, undefined if unknown. */
  fetchWeeklyDownloads(name: string, ctx: EcosystemContext): Promise<number | undefined>;
  /** Ranked list of the most downloaded packages (normalized names). */
  topPackages(): readonly string[];
  /** Whether installing this package can run arbitrary code at install time by design. */
  hasInstallScriptSignal: boolean;
}
