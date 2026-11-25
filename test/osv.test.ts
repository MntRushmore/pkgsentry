import { describe, expect, it } from 'vitest';
import { affectsAllVersions, isMalware } from '../src/sources/osv.js';

describe('isMalware', () => {
  it.each([
    ['MAL-2025-1', 'anything'],
    ['GHSA-a', 'crossenv is malware'],
    ['GHSA-b', 'Malicious Package in flatmap-stream'],
    ['GHSA-c', 'Embedded malware in ua-parser-js'],
    ['GHSA-d', 'Embedded Malicious Code in rc'],
    ['GHSA-e', 'Malicious code in some-pkg (npm)'],
  ])('%s %s -> malware', (id, summary) => {
    expect(isMalware({ id, summary })).toBe(true);
  });

  it('uses CWE-506', () => {
    expect(isMalware({ id: 'GHSA-f', summary: 'x', database_specific: { cwe_ids: ['CWE-506'] } })).toBe(true);
  });

  it.each([
    'Requests vulnerable to .netrc credentials leak via malicious URLs',
    'Prototype pollution via malicious input',
    'ReDoS when parsing malicious headers',
  ])('ordinary vulnerability: %s', (summary) => {
    expect(isMalware({ id: 'GHSA-z', summary })).toBe(false);
  });
});

describe('affectsAllVersions', () => {
  it('true when introduced at 0 and never fixed', () => {
    expect(affectsAllVersions({ id: 'x', affected: [{ ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }] })).toBe(true);
  });
  it('false when a fix exists', () => {
    expect(affectsAllVersions({ id: 'x', affected: [{ ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }] }] })).toBe(false);
  });
});
