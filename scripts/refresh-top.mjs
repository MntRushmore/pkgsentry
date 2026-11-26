#!/usr/bin/env node
// Refreshes the bundled "top packages" lists used for typosquat detection.
//
//   npm run refresh-top            # default: top 5000 per ecosystem
//   npm run refresh-top -- 10000   # custom size
//
// Sources:
//   npm  -> npm-high-impact (wooorm), `topDownload` list, ranked by downloads
//   PyPI -> hugovk/top-pypi-packages, 30-day download counts from BigQuery/ClickHouse
//   RubyGems -> no public top-gems API, so rank this curated seed by all-time downloads
//   cargo    -> crates.io /api/v1/crates sorted by downloads (needs its User-Agent)
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

const RUBYGEMS_SEED = [
  'rails',
  'railties',
  'activerecord',
  'activesupport',
  'actionpack',
  'actionview',
  'actionmailer',
  'activejob',
  'actioncable',
  'activestorage',
  'actiontext',
  'actionmailbox',
  'rake',
  'bundler',
  'thor',
  'zeitwerk',
  'concurrent-ruby',
  'i18n',
  'tzinfo',
  'json',
  'oj',
  'multi_json',
  'rspec',
  'rspec-core',
  'rspec-expectations',
  'rspec-mocks',
  'rspec-rails',
  'minitest',
  'mocha',
  'capybara',
  'cucumber',
  'aruba',
  'nokogiri',
  'pg',
  'mysql2',
  'sqlite3',
  'redis',
  'hiredis',
  'connection_pool',
  'puma',
  'falcon',
  'thin',
  'unicorn',
  'passenger',
  'rack',
  'rack-test',
  'rack-cors',
  'rack-attack',
  'sidekiq',
  'resque',
  'delayed_job',
  'whenever',
  'clockwork',
  'resque-scheduler',
  'sidekiq-cron',
  'devise',
  'omniauth',
  'omniauth-oauth2',
  'doorkeeper',
  'pundit',
  'cancancan',
  'bcrypt',
  'jwt',
  'jbuilder',
  'kaminari',
  'will_paginate',
  'pagy',
  'ransack',
  'carrierwave',
  'shrine',
  'paperclip',
  'image_processing',
  'mini_magick',
  'rmagick',
  'dragonfly',
  'faraday',
  'httparty',
  'rest-client',
  'typhoeus',
  'excon',
  'http',
  'httpx',
  'net-http',
  'addressable',
  'public_suffix',
  'dotenv',
  'figaro',
  'config',
  'dry-configurable',
  'anyway_config',
  'highline',
  'tty-prompt',
  'tty-table',
  'pastel',
  'colorize',
  'rainbow',
  'webmock',
  'vcr',
  'simplecov',
  'factory_bot',
  'factory_bot_rails',
  'faker',
  'ffaker',
  'shoulda-matchers',
  'database_cleaner',
  'sprockets',
  'sprockets-rails',
  'propshaft',
  'importmap-rails',
  'turbo-rails',
  'stimulus-rails',
  'sassc',
  'sass-rails',
  'compass',
  'execjs',
  'mini_racer',
  'terser',
  'uglifier',
  'rubocop',
  'rubocop-rails',
  'rubocop-rspec',
  'rubocop-performance',
  'standard',
  'reek',
  'flay',
  'flog',
  'brakeman',
  'listen',
  'rb-inotify',
  'spring',
  'bootsnap',
  'guard',
  'guard-rspec',
  'launchy',
  'mail',
  'premailer',
  'roadie',
  'stripe',
  'twilio-ruby',
  'sendgrid-ruby',
  'slack-notifier',
  'octokit',
  'aws-sdk-s3',
  'fog',
  'fog-aws',
  'google-cloud-storage',
  'sinatra',
  'grape',
  'roda',
  'hanami',
  'mustermann',
  'tilt',
  'haml',
  'slim',
  'erubi',
  'redcarpet',
  'kramdown',
  'rouge',
  'sanitize',
  'loofah',
  'crass',
  'rails-html-sanitizer',
  'selenium-webdriver',
  'ferrum',
  'cuprite',
  'webdrivers',
  'aasm',
  'state_machines',
  'after_commit',
  'dry-validation',
  'dry-types',
  'trailblazer',
  'psych',
  'ostruct',
  'base64',
  'bigdecimal',
  'logger',
  'mutex_m',
  'drb',
  'csv',
  'net-smtp',
  'git',
  'rugged',
  'github_api',
  'bcrypt_pbkdf',
  'ed25519',
  'net-ssh',
  'net-scp',
  'capistrano',
  'rspec-its',
  'rspec-collection_matchers',
  'mutant',
];

async function rubygemsTop() {
  const counts = [];
  for (let i = 0; i < RUBYGEMS_SEED.length; i += 10) {
    const batch = RUBYGEMS_SEED.slice(i, i + 10);
    counts.push(
      ...(await Promise.all(
        batch.map(async (name) => {
          const doc = await (await get(`https://rubygems.org/api/v1/gems/${name}.json`)).json();
          return [name, doc.downloads];
        }),
      )),
    );
  }
  if (counts.length < 100) throw new Error(`RubyGems seed looks wrong (${counts.length} gems)`);
  return {
    source: 'rubygems.org all-time downloads, curated seed',
    packages: counts.sort((a, b) => b[1] - a[1]).map(([name]) => name).slice(0, LIMIT),
  };
}

async function cargoTop() {
  const headers = { 'user-agent': 'pkgsentry-refresh-top', accept: 'application/json' };
  const names = [];
  for (let page = 1; names.length < LIMIT; page++) {
    const res = await fetch(`https://crates.io/api/v1/crates?sort=downloads&per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`crates.io page ${page} -> HTTP ${res.status}`);
    const { crates } = await res.json();
    if (!crates.length) break;
    names.push(...crates.map((c) => c.name));
  }
  if (names.length < 100) throw new Error(`crates.io parse looks wrong (${names.length} names)`);
  return { source: 'crates.io sort=downloads', packages: names.slice(0, LIMIT) };
}

const updated = new Date().toISOString().slice(0, 10);
for (const [eco, fn] of [['npm', npmTop], ['pypi', pypiTop], ['rubygems', rubygemsTop], ['cargo', cargoTop]]) {
  const { source, packages } = await fn();
  const file = path.join(root, 'data', `top-${eco}.json`);
  await writeFile(file, JSON.stringify({ ecosystem: eco, updated, source, packages }) + '\n');
  console.log(`${eco}: wrote ${packages.length} names -> ${path.relative(root, file)}`);
}
