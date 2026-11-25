#!/usr/bin/env node
// Runs pkgsentry against bench/dataset.json and writes bench/results/latest.{json,md}.
//
//   npm run bench
//
// Three passes, each with an empty cache directory so nothing leaks between them:
//   1. full      every signal, cold cache (records latency)
//   2. cached    same again on a warm cache (records latency)
//   3. no-osv    without the OSV.dev malware lookup, to show what registry data + heuristics catch alone
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { createChecker } = await import('../dist/check.js');
const { entries } = JSON.parse(readFileSync(path.join(here, 'dataset.json'), 'utf8'));

async function pass(label, opts = {}, home = mkdtempSync(path.join(os.tmpdir(), 'pkgsentry-bench-'))) {
  process.env.PKGSENTRY_HOME = home;
  const checker = createChecker({ cwd: os.tmpdir(), ...opts });
  const started = performance.now();
  const results = [];
  let i = 0;
  // Sequential-ish (4 at a time) so per-package latency is meaningful and registries aren't hammered.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < entries.length) {
      const e = entries[i++];
      const r = await checker.check({ ecosystem: e.ecosystem, name: e.name });
      results.push({ ...e, verdict: r.verdict, score: r.score, ms: r.durationMs, signals: r.signals.map((s) => s.id) });
    }
  }));
  console.error(`${label}: ${entries.length} packages in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  return { results, home };
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

function table(results) {
  const rows = [];
  const groups = [
    ['hallucinated', 'bad'],
    ['typosquat', 'bad'],
    ['popular', 'good'],
    ['long-tail', 'good'],
  ];
  for (const [cat, label] of groups) {
    for (const eco of ['npm', 'pypi', 'all']) {
      const rs = results.filter((r) => r.category === cat && (eco === 'all' || r.ecosystem === eco));
      if (!rs.length) continue;
      const n = (v) => rs.filter((r) => r.verdict === v).length;
      rows.push({ cat, label, eco, total: rs.length, block: n('BLOCK'), warn: n('WARN'), allow: n('ALLOW') });
    }
  }
  return rows;
}

function summary(results) {
  const bad = results.filter((r) => r.label === 'bad');
  const good = results.filter((r) => r.label === 'good');
  const c = (rs, v) => rs.filter((r) => v.includes(r.verdict)).length;
  return {
    badBlocked: pct(c(bad, ['BLOCK']), bad.length),
    badFlagged: pct(c(bad, ['BLOCK', 'WARN']), bad.length),
    goodBlocked: pct(c(good, ['BLOCK']), good.length),
    goodWarned: pct(c(good, ['WARN']), good.length),
    nBad: bad.length,
    nGood: good.length,
  };
}

const full = await pass('full (cold)');
const cached = await pass('full (cached)', {}, full.home);
const noOsv = await pass('no-osv', { noOsv: true });

const S = summary(full.results);
const A = summary(noOsv.results);
const coldMs = full.results.map((r) => r.ms);
const warmMs = cached.results.map((r) => r.ms);
const date = new Date().toISOString().slice(0, 10);

const md = [];
md.push(`Run ${date} against ${entries.length} packages (${S.nBad} bad, ${S.nGood} good).`, '');
md.push('| | Bad names blocked | Bad names blocked or warned | Good names blocked (false positive) | Good names warned |');
md.push('|---|---|---|---|---|');
md.push(`| **pkgsentry** | **${S.badBlocked}** | ${S.badFlagged} | **${S.goodBlocked}** | ${S.goodWarned} |`);
md.push(`| without OSV.dev | ${A.badBlocked} | ${A.badFlagged} | ${A.goodBlocked} | ${A.goodWarned} |`);
md.push('');
md.push('| Category | Ecosystem | n | BLOCK | WARN | ALLOW |');
md.push('|---|---|---|---|---|---|');
for (const r of table(full.results)) {
  md.push(`| ${r.cat} (${r.label}) | ${r.eco} | ${r.total} | ${r.block} | ${r.warn} | ${r.allow} |`);
}
md.push('');
md.push(`Latency per package: cold p50 ${quantile(coldMs, 0.5)}ms / p95 ${quantile(coldMs, 0.95)}ms, cached p50 ${quantile(warmMs, 0.5)}ms / p95 ${quantile(warmMs, 0.95)}ms.`);

const misses = full.results.filter((r) => (r.label === 'bad' && r.verdict !== 'BLOCK') || (r.label === 'good' && r.verdict !== 'ALLOW'));
md.push('', '<details><summary>Every miss and false positive</summary>', '', '| Package | Label | Verdict | Signals |', '|---|---|---|---|');
for (const r of misses.sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name))) {
  md.push(`| \`${r.ecosystem}:${r.name}\` | ${r.category} | ${r.verdict} | ${r.signals.join(', ') || '-'} |`);
}
md.push('', '</details>');

mkdirSync(path.join(here, 'results'), { recursive: true });
writeFileSync(path.join(here, 'results', 'latest.md'), md.join('\n') + '\n');
writeFileSync(
  path.join(here, 'results', 'latest.json'),
  JSON.stringify({ date, summary: S, withoutOsv: A, latency: { coldP50: quantile(coldMs, 0.5), coldP95: quantile(coldMs, 0.95), cachedP50: quantile(warmMs, 0.5), cachedP95: quantile(warmMs, 0.95) }, results: full.results, noOsv: noOsv.results }, null, 2) + '\n',
);
console.log(md.join('\n'));
