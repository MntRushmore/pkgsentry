import { DAY_MS, metaTtl } from '../cache.js';
import { loadTopList } from '../data.js';
import { RegistryError } from '../http.js';
import type { PackageMeta } from '../types.js';
import type { Ecosystem } from './types.js';

interface PypiFile {
  upload_time_iso_8601?: string;
  yanked?: boolean;
}

interface PypiDoc {
  info: {
    name: string;
    version: string;
    summary?: string | null;
    home_page?: string | null;
    project_urls?: Record<string, string> | null;
    yanked?: boolean;
  };
  releases?: Record<string, PypiFile[]>;
}

const CODE_HOST = /^https?:\/\/(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/[^/]+\/[^/#?]+/i;

/** Picks the most likely source repository out of PyPI's free-form project URLs. */
export function pickRepo(info: PypiDoc['info']): string | undefined {
  const urls = [
    ...Object.entries(info.project_urls ?? {})
      .sort(([a], [b]) => rankKey(a) - rankKey(b))
      .map(([, u]) => u),
    info.home_page ?? '',
  ];
  for (const u of urls) {
    const m = u?.match(CODE_HOST);
    if (m) return m[0].replace(/\.git$/, '');
  }
  return undefined;
}

function rankKey(key: string): number {
  const k = key.toLowerCase();
  if (/source|repo|code|github|gitlab/.test(k)) return 0;
  if (/home/.test(k)) return 1;
  return 2;
}

/** PEP 440-ish exact version: 1.2, 1.2.3, 1.2.3rc1, 2.0.post1 */
const EXACT = /^v?\d+(?:\.\d+)*(?:(?:a|b|rc|alpha|beta|c)\d*)?(?:\.?post\d*)?(?:\.?dev\d*)?$/i;

export const pypi: Ecosystem = {
  id: 'pypi',
  displayName: 'PyPI',
  osvEcosystem: 'PyPI',
  hasInstallScriptSignal: false,

  /** PEP 503 normalization. */
  normalize: (name) => name.toLowerCase().replace(/[-_.]+/g, '-'),

  validateName(name) {
    if (!/^([A-Z0-9]|[A-Z0-9][A-Z0-9._-]*[A-Z0-9])$/i.test(name)) return 'Not a valid PyPI project name.';
    return undefined;
  },

  isExactVersion: (v) => EXACT.test(v),

  async fetchMeta(name, version, ctx) {
    const exact = version && EXACT.test(version) ? version.replace(/^v/, '') : undefined;
    return ctx.cache.wrap(
      `pypi:meta:${name}@${exact ?? ''}`,
      metaTtl,
      async () => {
        const res = await ctx.http.getJson<PypiDoc>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
        if (res.status === 404) return { exists: false, name };
        if (res.status !== 200 || !res.body?.info) throw new RegistryError(`PyPI returned HTTP ${res.status}`, res.status);
        const { info, releases = {} } = res.body;
        let createdAt: string | undefined;
        for (const files of Object.values(releases)) {
          for (const f of files) {
            if (f.upload_time_iso_8601 && (!createdAt || f.upload_time_iso_8601 < createdAt)) {
              createdAt = f.upload_time_iso_8601;
            }
          }
        }
        const hasFiles = Object.values(releases).some((files) => files.length > 0);
        const meta: PackageMeta = {
          exists: true,
          name: info.name,
          latestVersion: info.version,
          createdAt,
          description: info.summary ?? undefined,
          repositoryUrl: pickRepo(info),
          deprecated: hasFiles ? undefined : 'Project has no downloadable files.',
        };
        if (exact) {
          // PEP 440: 1.0 == 1.0.0, case-insensitive.
          const norm = (v: string) => v.toLowerCase().replace(/(\.0+)+$/, '');
          const want = norm(exact);
          meta.versionExists = Object.keys(releases).some((v) => norm(v) === want);
        }
        return meta;
      },
    );
  },

  async fetchWeeklyDownloads(name, ctx) {
    // null = unknown (pypistats is slow/rate limited at times). Cached briefly.
    const v = await ctx.cache.wrap<number | null>(`pypi:downloads:${name}`, (n) => (n === null ? 10 * 60 * 1000 : DAY_MS), async () => {
      try {
        const res = await ctx.http.getJson<{ data?: { last_week?: number } }>(
          `https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`,
        );
        if (res.status === 200) return res.body?.data?.last_week ?? 0;
        // pypistats has no row for packages nobody has downloaded yet.
        if (res.status === 404) return 0;
      } catch {
        // downloads are a soft signal
      }
      return null;
    });
    return v ?? undefined;
  },

  topPackages: () => loadTopList('pypi'),
};
