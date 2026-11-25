#!/usr/bin/env node
// Refreshes the bundled "top packages" lists used for typosquat detection.
//
//   npm run refresh-top            # default: top 5000 per ecosystem
//   npm run refresh-top -- 10000   # custom size
//
// Sources:
//   npm  -> npm-high-impact (wooorm), `topDownload` list, ranked by downloads
//   PyPI -> hugovk/top-pypi-packages, 30-day download counts from BigQuery/ClickHouse
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LIMIT = Number(process.argv[2] ?? 5000);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'pkgsentry-refresh-top' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

async function npmTop() {
  const meta = await (await get('https://registry.npmjs.org/npm-high-impact/latest')).json();
  const src = await (
    await get(`https://cdn.jsdelivr.net/npm/npm-high-impact@${meta.version}/lib/top-download.js`)
  ).text();
  const names = [...src.matchAll(/'((?:@[^'/]+\/)?[^']+)'/g)].map((m) => m[1]);
  if (names.length < 1000) throw new Error(`npm-high-impact parse looks wrong (${names.length} names)`);
  return {
    source: `npm-high-impact@${meta.version} (topDownload)`,
    packages: [...new Set(names)].slice(0, LIMIT),
  };
}

async function pypiTop() {
  const data = await (
    await get('https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json')
  ).json();
  return {
    source: `hugovk/top-pypi-packages (${data.last_update})`,
    packages: data.rows.slice(0, LIMIT).map((r) => r.project.toLowerCase()),
  };
}

const updated = new Date().toISOString().slice(0, 10);
for (const [eco, fn] of [['npm', npmTop], ['pypi', pypiTop]]) {
  const { source, packages } = await fn();
  const file = path.join(root, 'data', `top-${eco}.json`);
  await writeFile(file, JSON.stringify({ ecosystem: eco, updated, source, packages }) + '\n');
  console.log(`${eco}: wrote ${packages.length} names -> ${path.relative(root, file)}`);
}
