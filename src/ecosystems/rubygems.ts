import { DAY_MS, metaTtl } from '../cache.js';
import { loadTopList } from '../data.js';
import { RegistryError } from '../http.js';
import type { PackageMeta } from '../types.js';
import type { Ecosystem } from './types.js';

const GEM = 'https://rubygems.org/api/v1/gems';
const VERSION = 'https://rubygems.org/api/v2/rubygems';

interface GemDoc {
  name: string;
  version: string;
  version_created_at?: string;
  info?: string;
  downloads?: number;
  homepage_uri?: string;
  source_code_uri?: string;
}

/** 1.2, 1.2.3, 1.2.3.rc1, 1.0.0.pre.2 */
const EXACT = /^v?\d+(?:\.\d+)*(?:[.-][a-z0-9]+)*$/i;

export const rubygems: Ecosystem = {
  id: 'rubygems',
  displayName: 'RubyGems',
  osvEcosystem: 'RubyGems',
  // Native extensions run extconf.rb, which is arbitrary Ruby.
  hasInstallScriptSignal: true,

  normalize: (name) => name.toLowerCase(),

  validateName(name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return 'Not a valid gem name.';
    return undefined;
  },

  isExactVersion: (v) => EXACT.test(v),

  async fetchMeta(name, version, ctx) {
    const exact = version && EXACT.test(version) ? version.replace(/^v/, '') : undefined;
    return ctx.cache.wrap(`rubygems:meta:${name}@${exact ?? ''}`, metaTtl, async () => {
      const res = await ctx.http.getJson<GemDoc>(`${GEM}/${encodeURIComponent(name)}.json`);
      if (res.status === 404) return { exists: false, name };
      if (res.status !== 200 || !res.body?.name) throw new RegistryError(`RubyGems returned HTTP ${res.status}`, res.status);
      const doc = res.body;
      const meta: PackageMeta = {
        exists: true,
        name: doc.name,
        latestVersion: doc.version,
        createdAt: doc.version_created_at,
        description: doc.info,
        repositoryUrl: doc.source_code_uri || doc.homepage_uri,
      };
      if (exact && exact !== doc.version) {
        const v = await ctx.http.getJson(`${VERSION}/${encodeURIComponent(name)}/versions/${encodeURIComponent(exact)}.json`);
        meta.versionExists = v.status === 200;
      } else if (exact) {
        meta.versionExists = true;
      }
      return meta;
    });
  },

  async fetchWeeklyDownloads(name, ctx) {
    // RubyGems publishes all-time and per-version counts, never a weekly window.
    // Use all-time as a scale hint, cached for a day: a gem with a million downloads is not new.
    const v = await ctx.cache.wrap<number | null>(`rubygems:downloads:${name}`, DAY_MS, async () => {
      try {
        const res = await ctx.http.getJson<GemDoc>(`${GEM}/${encodeURIComponent(name)}.json`);
        const total = res.body?.downloads;
        if (res.status === 200 && typeof total === 'number') return Math.round(total / 52);
        if (res.status === 404) return 0;
      } catch {
        // downloads are a soft signal
      }
      return null;
    });
    return v ?? undefined;
  },

  topPackages: () => loadTopList('rubygems'),
};
