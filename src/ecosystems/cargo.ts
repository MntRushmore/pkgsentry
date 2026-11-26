import { DAY_MS, metaTtl } from '../cache.js';
import { loadTopList } from '../data.js';
import { RegistryError } from '../http.js';
import type { PackageMeta } from '../types.js';
import type { Ecosystem } from './types.js';

const REGISTRY = 'https://crates.io/api/v1/crates';
/** crates.io refuses requests without a User-Agent that names the client. */
const UA = 'pkgsentry (+https://github.com/MntRushmore/pkgsentry)';

interface CrateDoc {
  crate?: {
    name: string;
    newest_version?: string;
    description?: string;
    repository?: string;
    homepage?: string;
    created_at?: string;
  };
  versions?: { num: string }[];
}

/** 1.2.3, 1.2.3-rc.1 */
const EXACT = /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/;

export const cargo: Ecosystem = {
  id: 'cargo',
  displayName: 'crates.io',
  osvEcosystem: 'crates.io',
  // build.rs is arbitrary Rust that runs at install time.
  hasInstallScriptSignal: true,

  /** crates.io treats `foo-bar` and `foo_bar` as the same crate. */
  normalize: (name) => name.toLowerCase().replace(/_/g, '-'),

  validateName(name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return 'Not a valid crate name.';
    return undefined;
  },

  isExactVersion: (v) => EXACT.test(v),

  async fetchMeta(name, version, ctx) {
    const exact = version && EXACT.test(version) ? version : undefined;
    return ctx.cache.wrap(`cargo:meta:${name}@${exact ?? ''}`, metaTtl, async () => {
      const res = await ctx.http.request<CrateDoc>(REGISTRY + '/' + encodeURIComponent(name), {
        headers: { 'user-agent': UA, accept: 'application/json' },
      });
      if (res.status === 404) return { exists: false, name };
      const doc = res.body?.crate;
      if (res.status !== 200 || !doc) throw new RegistryError(`crates.io returned HTTP ${res.status}`, res.status);
      const meta: PackageMeta = {
        exists: true,
        name: doc.name,
        latestVersion: doc.newest_version,
        createdAt: doc.created_at,
        description: doc.description,
        repositoryUrl: doc.repository || doc.homepage,
      };
      if (exact) meta.versionExists = (res.body?.versions ?? []).some((v) => v.num === exact);
      return meta;
    });
  },

  async fetchWeeklyDownloads(name, ctx) {
    // crates.io publishes 90-day downloads, so a week is a thirteenth of that.
    const v = await ctx.cache.wrap<number | null>(`cargo:downloads:${name}`, DAY_MS, async () => {
      try {
        const res = await ctx.http.request<CrateDoc & { crate?: { recent_downloads?: number } }>(
          REGISTRY + '/' + encodeURIComponent(name),
          { headers: { 'user-agent': UA, accept: 'application/json' } },
        );
        const recent = res.body?.crate?.recent_downloads;
        if (res.status === 200 && typeof recent === 'number') return Math.round(recent / 13);
        if (res.status === 404) return 0;
      } catch {
        // downloads are a soft signal
      }
      return null;
    });
    return v ?? undefined;
  },

  topPackages: () => loadTopList('cargo'),
};
