import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createChecker } from '../src/check.js';
import { daysAgo, fakeFetch, OSV_EMPTY, tempHome } from './helpers.js';

const now = new Date('2026-11-25T00:00:00Z');
const OSV = 'https://api.osv.dev/v1/querybatch';

beforeEach(() => {
  tempHome();
});

describe('npm', () => {
  it('blocks a missing package and suggests the real one', async () => {
    const f = fakeFetch({ [OSV]: OSV_EMPTY });
    const r = await createChecker({ fetch: f, now }).check({ ecosystem: 'npm', name: 'expresss' });
    expect(r.verdict).toBe('BLOCK');
    expect(r.suggestion).toBe('express');
    expect(r.signals[0]!.message).toContain('Did you mean "express"?');
  });

  it('allows a popular package using the light manifest endpoint', async () => {
    const f = fakeFetch({
      'https://registry.npmjs.org/express/latest': { status: 200, body: { version: '5.1.0', repository: { url: 'git+https://github.com/expressjs/express.git' } } },
      [OSV]: OSV_EMPTY,
    });
    const r = await createChecker({ fetch: f, now }).check({ ecosystem: 'npm', name: 'express' });
    expect(r.verdict).toBe('ALLOW');
    // No packument, downloads, or repo lookups for top packages.
    // (The two lookups run in parallel, so their order isn't fixed.)
    expect([...f.calls].sort()).toEqual(['GET https://registry.npmjs.org/express/latest', `POST ${OSV}`]);
  });

  it('blocks a new typosquat with a postinstall script', async () => {
    const f = fakeFetch({
      'https://registry.npmjs.org/expresss-js': { status: 404 },
      'https://registry.npmjs.org/lodahs': {
        status: 200,
        body: {
          name: 'lodahs',
          'dist-tags': { latest: '1.0.0' },
          time: { created: daysAgo(4, now) },
          versions: { '1.0.0': { version: '1.0.0', scripts: { postinstall: 'node -e "require(\'child_process\')"' } } },
        },
      },
      'https://api.npmjs.org/downloads/point/last-week/lodahs': { status: 200, body: { downloads: 9 } },
      [OSV]: OSV_EMPTY,
    });
    const r = await createChecker({ fetch: f, now }).check({ ecosystem: 'npm', name: 'lodahs' });
    expect(r.verdict).toBe('BLOCK');
    expect(r.suggestion).toBe('lodash');
    expect(r.signals.map((s) => s.id)).toEqual(expect.arrayContaining(['typosquat', 'new_package', 'install_script', 'low_downloads', 'no_repository']));
  });

  it('detects OSV malware advisories', async () => {
    const f = fakeFetch({
      'https://registry.npmjs.org/some-pkg': {
        status: 200,
        body: { name: 'some-pkg', 'dist-tags': { latest: '1.0.0' }, time: { created: daysAgo(400, now) }, versions: { '1.0.0': { version: '1.0.0' } } },
      },
      'https://api.npmjs.org/downloads/point/last-week/some-pkg': { status: 200, body: { downloads: 5000 } },
      [OSV]: { status: 200, body: { results: [{ vulns: [{ id: 'MAL-2025-42' }] }] } },
      'https://api.osv.dev/v1/vulns/MAL-2025-42': {
        status: 200,
        body: { id: 'MAL-2025-42', summary: 'Malicious code in some-pkg (npm)', affected: [{ ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }] },
      },
    });
    const r = await createChecker({ fetch: f, now }).check({ ecosystem: 'npm', name: 'some-pkg' });
    expect(r.verdict).toBe('BLOCK');
    expect(r.signals[0]!.id).toBe('malicious');
  });

  it('blocks npm security placeholders, including suffixed ones', async () => {
    const f = fakeFetch({
      'https://registry.npmjs.org/autoprafixar': {
        status: 200,
        body: {
          name: 'autoprafixar',
          'dist-tags': { latest: '0.0.1-security.1' },
          time: { created: daysAgo(300, now) },
          versions: { '0.0.1-security.1': { version: '0.0.1-security.1', description: 'security holding package' } },
        },
      },
      [OSV]: OSV_EMPTY,
    });
    const r = await createChecker({ fetch: f, now }).check({ ecosystem: 'npm', name: 'autoprafixar' });
    expect(r.verdict).toBe('BLOCK');
    expect(r.signals[0]!.id).toBe('security_holding');
  });

  it('flags a dead repository link', async () => {
    const f = fakeFetch({
      'https://registry.npmjs.org/some-pkg': {
        status: 200,
        body: {
          name: 'some-pkg',
          'dist-tags': { latest: '1.0.0' },
          time: { created: daysAgo(400, now) },
          versions: { '1.0.0': { version: '1.0.0', repository: 'github:ghost/nothing-here' } },
        },
      },
      'https://api.npmjs.org/downloads/point/last-week/some-pkg': { status: 200, body: { downloads: 5000 } },
      [OSV]: OSV_EMPTY,
      'https://github.com/ghost/nothing-here': { status: 404 },
    });
    const r = await createChecker({ fetch: f, now }).check({ ecosystem: 'npm', name: 'some-pkg' });
    expect(r.signals.map((s) => s.id)).toContain('repository_missing');
  });

  it('warns but does not crash when the registry is down', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await createChecker({ fetch: f, now }).check({ ecosystem: 'npm', name: 'some-pkg' });
    expect(r.verdict).toBe('WARN');
    expect(r.signals.map((s) => s.id)).toContain('lookup_failed');
  });

  it('rejects invalid names without a network call', async () => {
    const f = fakeFetch({});
    const r = await createChecker({ fetch: f, now }).check({ ecosystem: 'npm', name: 'Not Valid' });
    expect(r.verdict).toBe('BLOCK');
    expect(f.calls).toEqual([]);
  });
});

describe('pypi', () => {
  it('blocks a missing package with a suggestion', async () => {
    const f = fakeFetch({ [OSV]: OSV_EMPTY });
    const r = await createChecker({ fetch: f, now }).check({ ecosystem: 'pypi', name: 'reqeusts' });
    expect(r.verdict).toBe('BLOCK');
    expect(r.signals[0]!.message).toBe(`Doesn't exist on PyPI. Did you mean "requests"?`);
  });

  it('computes age from the first upload and reads pypistats', async () => {
    const f = fakeFetch({
      'https://pypi.org/pypi/fresh-thing/json': {
        status: 200,
        body: {
          info: { name: 'fresh-thing', version: '0.1', summary: 'x', project_urls: { Source: 'https://github.com/a/fresh-thing' } },
          releases: { '0.1': [{ upload_time_iso_8601: daysAgo(2, now) }] },
        },
      },
      'https://pypistats.org/api/packages/fresh-thing/recent': { status: 404 },
      [OSV]: OSV_EMPTY,
      'https://github.com/a/fresh-thing': { status: 200 },
    });
    const r = await createChecker({ fetch: f, now }).check({ ecosystem: 'pypi', name: 'fresh-thing' });
    expect(r.verdict).toBe('WARN');
    expect(r.signals.map((s) => s.id)).toEqual(['new_package', 'low_downloads']);
  });
});

describe('caching', () => {
  it('serves repeat checks from disk', async () => {
    const routes = {
      'https://registry.npmjs.org/express/latest': { status: 200, body: { version: '5.1.0' } },
      [OSV]: OSV_EMPTY,
    };
    const f1 = fakeFetch(routes);
    await createChecker({ fetch: f1, now }).check({ ecosystem: 'npm', name: 'express' });
    const f2 = fakeFetch(routes);
    const r = await createChecker({ fetch: f2, now }).check({ ecosystem: 'npm', name: 'express' });
    expect(r.verdict).toBe('ALLOW');
    expect(f2.calls).toEqual([]);
  });

  it('can be bypassed', async () => {
    const routes = { 'https://registry.npmjs.org/express/latest': { status: 200, body: { version: '5.1.0' } }, [OSV]: OSV_EMPTY };
    await createChecker({ fetch: fakeFetch(routes), now }).check({ ecosystem: 'npm', name: 'express' });
    const f2 = fakeFetch(routes);
    await createChecker({ fetch: f2, now, noCache: true }).check({ ecosystem: 'npm', name: 'express' });
    expect(f2.calls.length).toBe(2);
  });
});

describe('.pkgsentry.json', () => {
  function project(config: unknown) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pkgsentry-proj-'));
    writeFileSync(path.join(dir, '.pkgsentry.json'), JSON.stringify(config));
    const sub = path.join(dir, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    return sub;
  }

  it('allowlists private packages without hitting the network', async () => {
    const cwd = project({ allow: ['npm:@acme/*', 'internal-tool'] });
    const f = fakeFetch({});
    const c = createChecker({ fetch: f, now, cwd });
    expect((await c.check({ ecosystem: 'npm', name: '@acme/ui' })).verdict).toBe('ALLOW');
    expect((await c.check({ ecosystem: 'pypi', name: 'Internal_Tool' })).verdict).toBe('ALLOW');
    expect(f.calls).toEqual([]);
  });

  it('ecosystem prefixes are respected', async () => {
    const cwd = project({ allow: ['pypi:left-pad'] });
    const f = fakeFetch({ [OSV]: OSV_EMPTY });
    const r = await createChecker({ fetch: f, now, cwd }).check({ ecosystem: 'npm', name: 'left-pad' });
    expect(r.rule).toBeUndefined();
  });

  it('blocklist wins over allowlist', async () => {
    const cwd = project({ allow: ['event-stream'], block: ['npm:event-stream'] });
    const r = await createChecker({ fetch: fakeFetch({}), now, cwd }).check({ ecosystem: 'npm', name: 'event-stream' });
    expect(r.verdict).toBe('BLOCK');
    expect(r.signals[0]!.id).toBe('blocklisted');
  });
});

describe('http', () => {
  it('retries once on 429', async () => {
    let n = 0;
    const f = fakeFetch({
      'https://registry.npmjs.org/express/latest': () => (n++ === 0 ? { status: 429 } : { status: 200, body: { version: '5.1.0' } }),
      [OSV]: OSV_EMPTY,
    });
    const r = await createChecker({ fetch: f, now }).check({ ecosystem: 'npm', name: 'express' });
    expect(r.verdict).toBe('ALLOW');
    expect(n).toBe(2);
  });
});
