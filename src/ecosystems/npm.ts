import { DAY_MS, metaTtl } from '../cache.js';
import { loadTopList } from '../data.js';
import { RegistryError } from '../http.js';
import type { PackageMeta } from '../types.js';
import type { Ecosystem, EcosystemContext } from './types.js';

const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week';
const UNKNOWN_TTL = 10 * 60 * 1000;
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;

interface VersionDoc {
  version: string;
  description?: string;
  deprecated?: string;
  scripts?: Record<string, string>;
  repository?: string | { url?: string };
  homepage?: string;
}

interface PackumentDoc {
  name: string;
  'dist-tags'?: Record<string, string>;
  time?: Record<string, string>;
  versions?: Record<string, VersionDoc>;
  repository?: string | { url?: string };
  description?: string;
}

function encodeName(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

function repoUrl(repo: VersionDoc['repository']): string | undefined {
  const raw = typeof repo === 'string' ? repo : repo?.url;
  if (!raw) return undefined;
  // "github:user/repo" and "user/repo" shorthands
  const short = raw.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/);
  if (short) return `https://github.com/${short[1]}`;
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
}

function installScripts(scripts: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!scripts) return undefined;
  const out: Record<string, string> = {};
  for (const hook of INSTALL_HOOKS) {
    // "prepare" only runs for git installs, but malware uses it too; include it.
    if (scripts[hook]) out[hook] = scripts[hook]!;
  }
  return Object.keys(out).length ? out : undefined;
}

function fromVersion(name: string, v: VersionDoc, extra: Partial<PackageMeta> = {}): PackageMeta {
  return {
    exists: true,
    name,
    latestVersion: v.version,
    description: v.description,
    deprecated: v.deprecated,
    repositoryUrl: repoUrl(v.repository),
    installScripts: installScripts(v.scripts),
    // npm's placeholder for removed malware: 0.0.1-security, 0.0.1-security.1, ...
    securityHolding: /-security(?:\.\d+)?$/.test(v.version) && /security holding/i.test(v.description ?? ''),
    ...extra,
  };
}

const EXACT = /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

export const npm: Ecosystem = {
  id: 'npm',
  displayName: 'npm',
  osvEcosystem: 'npm',
  hasInstallScriptSignal: true,

  normalize: (name) => name.toLowerCase(),

  validateName(name) {
    if (!name || name.length > 214) return 'Not a valid npm package name.';
    if (/^[._]/.test(name)) return 'npm package names cannot start with "." or "_".';
    if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
      return name.toLowerCase() !== name
        ? 'npm package names must be lowercase.'
        : 'Not a valid npm package name.';
    }
    return undefined;
  },

  isExactVersion: (v) => EXACT.test(v),

  async fetchMeta(name, version, ctx, { popular }) {
    const exact = version && EXACT.test(version) ? version.replace(/^v/, '') : undefined;
    return ctx.cache.wrap(
      `npm:meta:${name}@${exact ?? ''}:${popular ? 'p' : ''}`,
      metaTtl,
      async () => {
        if (popular) {
          // Popular packages can have 50MB+ packuments. Fetch just one manifest.
          const res = await ctx.http.getJson<VersionDoc>(`${REGISTRY}/${encodeName(name)}/${exact ?? 'latest'}`);
          if (res.status === 200 && res.body) return fromVersion(name, res.body, exact ? { versionExists: true } : {});
          if (res.status === 404 && exact) {
            const latest = await ctx.http.getJson<VersionDoc>(`${REGISTRY}/${encodeName(name)}/latest`);
            if (latest.status === 200 && latest.body) return fromVersion(name, latest.body, { versionExists: false });
          }
          if (res.status === 404) return { exists: false, name };
          throw new RegistryError(`npm registry returned HTTP ${res.status}`, res.status);
        }

        const res = await ctx.http.getJson<PackumentDoc>(`${REGISTRY}/${encodeName(name)}`);
        if (res.status === 404) return { exists: false, name };
        if (res.status !== 200 || !res.body) throw new RegistryError(`npm registry returned HTTP ${res.status}`, res.status);
        const doc = res.body;
        const latestTag = doc['dist-tags']?.latest;
        const versions = doc.versions ?? {};
        // Fully unpublished packages keep a packument with no versions.
        if (!latestTag || !versions[latestTag]) {
          return { exists: false, name, createdAt: doc.time?.created };
        }
        const target = exact && versions[exact] ? versions[exact]! : versions[latestTag]!;
        return fromVersion(doc.name ?? name, target, {
          createdAt: doc.time?.created,
          latestVersion: latestTag,
          repositoryUrl: repoUrl(target.repository) ?? repoUrl(doc.repository),
          ...(exact ? { versionExists: Boolean(versions[exact]) } : {}),
        });
      },
    );
  },

  async fetchWeeklyDownloads(name, ctx: EcosystemContext) {
    // null = unknown (rate limited / error). Cached briefly so warm checks stay fast.
    const v = await ctx.cache.wrap<number | null>(`npm:downloads:${name}`, (n) => (n === null ? UNKNOWN_TTL : DAY_MS), async () => {
      try {
        const res = await ctx.http.getJson<{ downloads?: number }>(`${DOWNLOADS}/${name}`);
        if (res.status === 200) return res.body?.downloads ?? 0;
        if (res.status === 404) return 0;
      } catch {
        // soft signal
      }
      return null;
    });
    return v ?? undefined;
  },

  topPackages: () => loadTopList('npm'),
};
