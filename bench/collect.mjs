#!/usr/bin/env node
// Builds bench/dataset.json. Run once; the output is committed so results are comparable.
//
//   node bench/collect.mjs
//
// Categories (per ecosystem, npm + PyPI):
//   popular       good  25 random packages from the top 5,000 by downloads
//   long-tail     good  25 random packages ranked 5,001-15,000 (real, but not in pkgsentry's bundled list)
//   typosquat     bad   25 random OSV.dev MAL- advisories whose name is a lookalike of a top-1,000 package
//   hallucinated  bad   25 random names LLMs suggested (bench/sources/model-suggestions.jsonl) that don't exist on the registry
//
// All sampling uses a fixed seed. Typosquat lookalike selection uses its own plain Levenshtein,
// not pkgsentry's detector, so the dataset isn't shaped by the thing it measures.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PER = 25;
const UA = { 'user-agent': 'pkgsentry-bench' };

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample(arr, n, seed) {
  const rand = mulberry32(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
const norm = (eco, n) => (eco === 'pypi' ? n.toLowerCase().replace(/[-_.]+/g, '-') : n.toLowerCase());
function lookalikeOf(name, top) {
  const strip = (s) => s.replace(/[-_.@/]/g, '');
  for (const t of top) {
    if (t === name) return undefined; // it IS the popular package
    if (strip(t) === strip(name)) return t;
    const max = name.length >= 6 ? 2 : name.length >= 4 ? 1 : 0;
    if (max && Math.abs(t.length - name.length) <= max && levenshtein(name, t) <= max) return t;
  }
  return undefined;
}
async function json(url, init) {
  const r = await fetch(url, { ...init, headers: { ...UA, ...init?.headers } });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]).catch(() => undefined);
    }
  }));
  return out;
}

// --- top lists (15k deep, to get long-tail) ---------------------------------
async function topLists() {
  const meta = await json('https://registry.npmjs.org/npm-high-impact/latest');
  const src = await (await fetch(`https://cdn.jsdelivr.net/npm/npm-high-impact@${meta.version}/lib/top-download.js`)).text();
  const npm = [...new Set([...src.matchAll(/'((?:@[^'/]+\/)?[^']+)'/g)].map((m) => m[1]))];
  const py = await json('https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json');
  return { npm, pypi: py.rows.map((r) => norm('pypi', r.project)), sources: { npm: `npm-high-impact@${meta.version}`, pypi: `top-pypi-packages ${py.last_update}` } };
}

// --- OSV typosquats ---------------------------------------------------------
async function osvTyposquats(eco, top1000, seed) {
  const osvEco = eco === 'npm' ? 'npm' : 'PyPI';
  const csv = await (await fetch(`https://osv-vulnerabilities.storage.googleapis.com/${osvEco}/modified_id.csv`)).text();
  const ids = csv.split('\n').map((l) => l.split(',')[1]).filter((id) => id?.startsWith('MAL-')).sort();
  // npm's MAL feed is mostly spam and dependency-confusion packages, so lookalikes are
  // rarer there (~0.2%) and we need a much bigger sample to find 25.
  const candidates = sample(ids, eco === 'npm' ? 25000 : 4000, seed);
  const docs = await pool(candidates, 48, (id) => json(`https://osv-vulnerabilities.storage.googleapis.com/${osvEco}/${id}.json`));
  const seen = new Set();
  const hits = [];
  for (const d of docs) {
    const name = d?.affected?.[0]?.package?.name;
    if (!name) continue;
    const n = norm(eco, name);
    if (seen.has(n)) continue;
    seen.add(n);
    const target = lookalikeOf(n, top1000);
    if (target) hits.push({ ecosystem: eco, name, label: 'bad', category: 'typosquat', source: `${d.id} (lookalike of ${target})` });
  }
  console.error(`${eco}: ${candidates.length} MAL advisories sampled, ${hits.length} lookalikes`);
  return sample(hits, PER, seed + 1);
}

// --- hallucinations ---------------------------------------------------------
async function exists(eco, name) {
  const url = eco === 'npm'
    ? `https://registry.npmjs.org/${name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)}`
    : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  const r = await fetch(url, { method: 'GET', headers: UA });
  if (r.status === 404) return false;
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const body = await r.json();
  // Fully unpublished npm packages still have a document but no versions.
  return eco === 'npm' ? Boolean(body['dist-tags']?.latest) : true;
}

async function hallucinations() {
  const lines = readFileSync(path.join(here, 'sources', 'model-suggestions.jsonl'), 'utf8').split('\n').filter(Boolean);
  const rows = lines.map((l) => JSON.parse(l));
  const uniq = [...new Map(rows.map((r) => [`${r.ecosystem}:${norm(r.ecosystem, r.package)}`, r])).values()];
  const checked = await pool(uniq, 16, async (r) => ({ ...r, exists: await exists(r.ecosystem, r.package) }));
  const stats = {};
  for (const r of checked.filter(Boolean)) {
    const k = `${r.model} round ${r.round} ${r.ecosystem}`;
    stats[k] ??= { suggested: 0, missing: 0 };
    stats[k].suggested++;
    if (!r.exists) stats[k].missing++;
  }
  console.error(stats);
  const picked = [];
  for (const [i, eco] of ['npm', 'pypi'].entries()) {
    const missing = checked.filter((r) => r && !r.exists && r.ecosystem === eco);
    picked.push(...sample(missing, PER, 400 + i));
  }
  return {
    stats,
    entries: picked.map((r) => ({ ecosystem: r.ecosystem, name: r.package, label: 'bad', category: 'hallucinated', source: `${r.model} round ${r.round}: "${r.task}"` })),
  };
}

const top = await topLists();
const dataset = [];
for (const [i, eco] of ['npm', 'pypi'].entries()) {
  const list = top[eco];
  dataset.push(...sample(list.slice(0, 5000), PER, 100 + i).map((name) => ({ ecosystem: eco, name, label: 'good', category: 'popular', source: top.sources[eco] })));
  dataset.push(...sample(list.slice(5000, 15000), PER, 200 + i).map((name) => ({ ecosystem: eco, name, label: 'good', category: 'long-tail', source: top.sources[eco] })));
  dataset.push(...(await osvTyposquats(eco, list.slice(0, 1000).map((n) => norm(eco, n)), 300 + i)));
}
const h = await hallucinations();
dataset.push(...h.entries);

const out = { generated: new Date().toISOString().slice(0, 10), hallucinationStats: h.stats, counts: {}, entries: dataset };
for (const e of dataset) out.counts[`${e.ecosystem}/${e.category}`] = (out.counts[`${e.ecosystem}/${e.category}`] ?? 0) + 1;
writeFileSync(path.join(here, 'dataset.json'), JSON.stringify(out, null, 2) + '\n');
console.error(out.counts, `total ${dataset.length}`);
