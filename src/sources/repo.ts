import { DAY_MS } from '../cache.js';
import type { EcosystemContext } from '../ecosystems/types.js';

export type RepoStatus = 'ok' | 'missing' | 'unknown';

const KNOWN_HOSTS = /^https:\/\/(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/([^/]+)\/([^/#?]+)/i;

/** Normalizes a repository URL to https://host/owner/repo, or undefined if it isn't on a known forge. */
export function canonicalRepo(url: string): string | undefined {
  const m = url.replace(/^http:/, 'https:').match(KNOWN_HOSTS);
  if (!m) return undefined;
  return `https://${m[1]!.toLowerCase()}/${m[2]}/${m[3]!.replace(/\.git$/, '')}`;
}

/**
 * Checks that a repository URL resolves. Uses the GitHub API when GITHUB_TOKEN is set
 * (accurate, 5000 req/h), otherwise a HEAD request to the repo page.
 */
export async function checkRepo(url: string, ctx: EcosystemContext): Promise<RepoStatus> {
  const repo = canonicalRepo(url);
  if (!repo) return 'unknown';
  return ctx.cache.wrap(`repo:${repo}`, DAY_MS, async () => {
    try {
      const token = process.env.GITHUB_TOKEN;
      const gh = repo.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
      const status =
        gh && token
          ? (await ctx.http.request(`https://api.github.com/repos/${gh[1]}/${gh[2]}`, {
              method: 'HEAD',
              headers: { authorization: `Bearer ${token}` },
            })).status
          : await ctx.http.head(repo, { accept: 'text/html' });
      if (status >= 200 && status < 400) return 'ok';
      if (status === 404 || status === 410) return 'missing';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  });
}
