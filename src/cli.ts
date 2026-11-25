#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { clearCache, cacheDir } from './cache.js';
import { createChecker, worstVerdict } from './check.js';
import { resolveEcosystem, ECOSYSTEMS } from './ecosystems/index.js';
import { runClaudeHook } from './integrations/claude-code.js';
import { runSetup, runUninstall } from './integrations/setup.js';
import { startMcpServer } from './mcp.js';
import { formatResults, paint, summaryLine } from './output.js';
import { parseInstallCommand, parseNpmSpec, parsePySpec } from './parse.js';
import type { CheckResult, PackageRef, Verdict } from './types.js';
import { VERSION } from './version.js';

const EXIT: Record<Verdict, number> = { ALLOW: 0, WARN: 1, BLOCK: 2 };
const USAGE_ERROR = 64;

const HELP = `pkgsentry ${VERSION}
Stops AI coding agents from installing hallucinated, typosquatted, or malicious packages.

Usage
  pkgsentry check <npm|pypi> <name>[@version] [more names...]   Check packages
  pkgsentry run [--yes] -- <install command>                    Check, then run an install
  pkgsentry setup [--yes] [--dry-run]                           Wire into Claude Code, Cursor, Windsurf, Codex
  pkgsentry uninstall [--yes]                                   Undo setup
  pkgsentry mcp                                                 Start the MCP server (stdio)
  pkgsentry cache clear                                         Delete cached lookups

Options
  --json       Machine-readable output
  --yes, -y    Don't ask before running installs with warnings / writing config
  --no-cache   Skip the 24h lookup cache (~/.pkgsentry)

Examples
  npx pkgsentry check pypi reqeusts
  npx pkgsentry check npm express lodash@4.17.21 --json
  npx pkgsentry run -- npm install left-pad
  npx pkgsentry run -- "cd api && pip install -r requirements.txt"

Exit codes: 0 ALLOW, 1 WARN, 2 BLOCK, 64 usage error.
Allowlist trusted packages in .pkgsentry.json: { "allow": ["npm:@acme/*"] }`;

interface Flags {
  json: boolean;
  yes: boolean;
  noCache: boolean;
  dryRun: boolean;
  help: boolean;
  version: boolean;
}

function parseFlags(argv: string[]): { flags: Flags; rest: string[] } {
  const flags: Flags = { json: false, yes: false, noCache: false, dryRun: false, help: false, version: false };
  const rest: string[] = [];
  for (const a of argv) {
    if (a === '--json') flags.json = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--no-cache') flags.noCache = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else rest.push(a);
  }
  return { flags, rest };
}

function fail(msg: string): never {
  process.stderr.write(`${paint(process.stderr).red('error')} ${msg}\n\nRun "pkgsentry --help" for usage.\n`);
  process.exit(USAGE_ERROR);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function progress(msg: string) {
  if (process.stderr.isTTY) process.stderr.write(paint(process.stderr).dim(msg) + '\r');
}
function clearProgress() {
  if (process.stderr.isTTY) process.stderr.write('\x1b[2K\r');
}

function jsonOut(results: CheckResult[], extra: Record<string, unknown> = {}) {
  process.stdout.write(JSON.stringify({ verdict: worstVerdict(results), ...extra, results }, null, 2) + '\n');
}

async function cmdCheck(args: string[], flags: Flags) {
  const [ecoArg, ...names] = args;
  if (!ecoArg || !names.length) fail('usage: pkgsentry check <npm|pypi> <name>[@version]');
  const eco = resolveEcosystem(ecoArg);
  if (!eco) fail(`unknown ecosystem "${ecoArg}". Supported: ${Object.keys(ECOSYSTEMS).join(', ')}`);

  const refs: PackageRef[] = names.map((n) => {
    if (eco.id === 'pypi') {
      // Accept both requests@2.0 and requests==2.0
      const r = parsePySpec(n.replace(/@(?=[\w.]+$)/, '=='));
      if ('reason' in r) fail(`"${n}": ${r.reason}`);
      return { ecosystem: 'pypi', name: r.name, ...(r.version ? { version: r.version } : {}) };
    }
    const r = parseNpmSpec(n);
    if ('reason' in r) fail(`"${n}": ${r.reason}`);
    return { ecosystem: 'npm', name: r.name, ...(r.version ? { version: r.version } : {}) };
  });

  if (!flags.json) progress(`Checking ${refs.length === 1 ? refs[0]!.name : `${refs.length} packages`}...`);
  const results = await createChecker({ noCache: flags.noCache }).checkAll(refs);
  if (flags.json) jsonOut(results);
  else {
    clearProgress();
    process.stdout.write(formatResults(results) + '\n');
  }
  process.exitCode = EXIT[worstVerdict(results)];
}

async function cmdRun(argv: string[], flags: Flags) {
  const dash = argv.indexOf('--');
  const commandArgs = dash === -1 ? argv : argv.slice(dash + 1);
  if (!commandArgs.length) fail('usage: pkgsentry run [--yes] -- <install command>');
  // A single argument with spaces is a shell string: pkgsentry run -- "cd x && npm i y"
  const useShell = commandArgs.length === 1 && /\s/.test(commandArgs[0]!);
  const commandString = useShell ? commandArgs[0]! : commandArgs.map(shellQuote).join(' ');
  const c = paint(process.stderr);

  const parsed = parseInstallCommand(commandString);
  let results: CheckResult[] = [];
  if (parsed.packages.length) {
    progress(`Checking ${parsed.packages.length} package${parsed.packages.length === 1 ? '' : 's'}...`);
    results = await createChecker({ noCache: flags.noCache }).checkAll(parsed.packages);
    clearProgress();
    if (flags.json) jsonOut(results, { command: commandString, skipped: parsed.skipped });
    else process.stderr.write(formatResults(results, parsed.skipped, process.stderr) + '\n');
  }

  const verdict = worstVerdict(results);
  if (verdict === 'BLOCK') {
    process.stderr.write(`\n${c.red('Not running')} ${c.dim(commandString)}\n${c.dim('Fix the package names, or allowlist them in .pkgsentry.json if you trust them.')}\n`);
    process.exitCode = EXIT.BLOCK;
    return;
  }
  if (verdict === 'WARN' && !flags.yes) {
    const ok = await confirm(`\n${summaryLine(results, process.stderr)}. Install anyway? [y/N] `);
    if (!ok) {
      process.stderr.write(`${c.yellow('Not running')} ${c.dim(commandString)}${process.stdin.isTTY ? '' : c.dim(' (no TTY to confirm; pass --yes to proceed)')}\n`);
      process.exitCode = EXIT.WARN;
      return;
    }
  }

  const child = useShell
    ? spawn(commandString, { stdio: 'inherit', shell: true })
    : spawn(commandArgs[0]!, commandArgs.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
  const code = await new Promise<number>((resolve) => {
    child.on('error', (e) => {
      process.stderr.write(`${c.red('error')} ${e.message}\n`);
      resolve(127);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  process.exitCode = code;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./^~<>-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...restRaw] = argv;
  // `run` passes everything after `--` through untouched.
  const dash = restRaw.indexOf('--');
  const head = cmd === 'run' && dash !== -1 ? restRaw.slice(0, dash) : restRaw;
  const { flags, rest } = parseFlags(cmd?.startsWith('-') ? argv : head);

  if (flags.version && (!cmd || cmd.startsWith('-'))) return void process.stdout.write(VERSION + '\n');
  if (!cmd || flags.help || cmd === 'help') return void process.stdout.write(HELP + '\n');

  switch (cmd) {
    case 'check':
      return cmdCheck(rest, flags);
    case 'run':
      return cmdRun(dash === -1 ? rest : [...rest, '--', ...restRaw.slice(dash + 1)], flags);
    case 'setup':
      process.exitCode = await runSetup({ yes: flags.yes, dryRun: flags.dryRun, only: rest });
      return;
    case 'uninstall':
      process.exitCode = await runUninstall({ yes: flags.yes, dryRun: flags.dryRun, only: rest });
      return;
    case 'mcp':
      return startMcpServer();
    case 'hook': {
      const agent = rest[0] ?? 'claude-code';
      if (agent !== 'claude-code') fail(`unknown hook target "${agent}"`);
      const out = await runClaudeHook(await readStdin());
      if (out.stdout) process.stdout.write(out.stdout);
      if (out.stderr) process.stderr.write(out.stderr);
      process.exitCode = out.exitCode;
      return;
    }
    case 'cache':
      if (rest[0] === 'clear') {
        await clearCache();
        process.stdout.write(`Cleared ${cacheDir()}\n`);
        return;
      }
      if (rest[0] === 'dir' || rest[0] === 'path') return void process.stdout.write(cacheDir() + '\n');
      return fail('usage: pkgsentry cache clear');
    default:
      return fail(`unknown command "${cmd}"`);
  }
}

main().catch((e) => {
  process.stderr.write(`pkgsentry: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(70);
});
