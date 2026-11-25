import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { EcosystemId, PackageRef } from './types.js';

/**
 * Finds every registry package an install command would fetch.
 *
 * Understands: npm, npx, pnpm, pnpx, yarn, bun, bunx, pip, pip3, python -m pip,
 * uv (pip install, add, tool install/run, run --with), uvx, pipx, poetry, pdm,
 * plus compound shell commands (&&, ||, ;, |), env prefixes, sudo, `cd`, and
 * `bash -c "..."`. Packages from local paths, git, or URLs are reported as
 * skipped rather than checked.
 */

export interface ParsedPackage extends PackageRef {
  /** The spec exactly as written, e.g. "lodash@^4". */
  spec: string;
}

export interface SkippedSpec {
  spec: string;
  reason: string;
}

export interface ParseResult {
  packages: ParsedPackage[];
  skipped: SkippedSpec[];
  /** True if any segment of the command was an install-like command. */
  isInstall: boolean;
}

// ---------------------------------------------------------------------------
// Shell tokenizing
// ---------------------------------------------------------------------------

/** Splits a shell string into simple commands (arrays of words). Good enough for agent-written one-liners. */
export function splitShell(input: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const pushWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const pushCmd = () => {
    pushWord();
    if (words.length) commands.push(words);
    words = [];
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      word += input.slice(i + 1, end === -1 ? undefined : end);
      inWord = true;
      i = end === -1 ? input.length : end;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < input.length && input[i] !== '"'; i++) {
        if (input[i] === '\\' && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1]!)) i++;
        word += input[i];
      }
    } else if (c === '\\') {
      if (input[i + 1] === '\n') i++;
      else if (i + 1 < input.length) {
        word += input[++i];
        inWord = true;
      }
    } else if (c === '#' && !inWord) {
      while (i < input.length && input[i] !== '\n') i++;
      pushCmd();
    } else if (c === ' ' || c === '\t') {
      pushWord();
    } else if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      // `&>file` is a redirection, not a command break; the '>' branch handles it.
      if (c === '&' && input[i + 1] === '>') continue;
      pushCmd();
    } else if (c === '>' || c === '<') {
      // Drop redirections and their target: `> out.log`, `2>/dev/null`
      if (/^\d*$/.test(word)) {
        word = '';
        inWord = false;
      } else pushWord();
      while (input[i + 1] === '>' || input[i + 1] === '&') i++;
      while (input[i + 1] === ' ') i++;
      while (i + 1 < input.length && !/[\s;&|]/.test(input[i + 1]!)) i++;
    } else {
      word += c;
      inWord = true;
    }
  }
  pushCmd();
  return commands;
}

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

const NON_REGISTRY = /^(\.{1,2}\/|\/|~|file:|link:|portal:|workspace:|patch:|git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:|ssh:)/i;
const ARCHIVE = /\.(tgz|tar\.gz|tar|zip|whl)$/i;

export function parseNpmSpec(spec: string): ParsedPackage | SkippedSpec {
  if (NON_REGISTRY.test(spec) || ARCHIVE.test(spec)) return { spec, reason: 'not a registry package' };
  if (spec.startsWith('jsr:')) return { spec, reason: 'JSR packages are not checked yet' };
  const at = spec.indexOf('@', 1);
  let name = at === -1 ? spec : spec.slice(0, at);
  let version = at === -1 ? undefined : spec.slice(at + 1) || undefined;
  if (!name.startsWith('@') && name.includes('/')) return { spec, reason: 'GitHub shorthand, not a registry package' };
  // Aliases: "my-alias@npm:real-package@1.2.3"
  if (version?.startsWith('npm:')) {
    const inner = parseNpmSpec(version.slice(4));
    return 'reason' in inner ? { spec, reason: inner.reason } : { ...inner, spec };
  }
  if (version && NON_REGISTRY.test(version)) return { spec, reason: 'not a registry package' };
  name = name.trim();
  return { ecosystem: 'npm', name, ...(version ? { version } : {}), spec };
}

const PEP508 = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/;

export function parsePySpec(raw: string): ParsedPackage | SkippedSpec {
  const spec = raw.trim();
  if (NON_REGISTRY.test(spec) || ARCHIVE.test(spec) || spec.includes('://')) {
    return { spec, reason: 'not a registry package' };
  }
  const m = spec.match(PEP508);
  if (!m) return { spec, reason: 'unrecognized requirement' };
  const name = m[1]!;
  let rest = m[2]!.split(';')[0]!.trim();
  if (rest.startsWith('@')) {
    rest = rest.slice(1).trim();
    // "pkg @ https://..." is a direct URL. "pkg@^1.2" is poetry/pdm syntax.
    if (rest.includes('://') || rest.startsWith('.') || rest.startsWith('/')) return { spec, reason: 'direct URL, not a registry package' };
    if (rest === 'latest' || rest === '*') rest = '';
  }
  let version: string | undefined = rest || undefined;
  const exact = rest.match(/^===?\s*([^\s,]+)$/);
  if (exact) version = exact[1];
  return { ecosystem: 'pypi', name, ...(version ? { version } : {}), spec };
}

// ---------------------------------------------------------------------------
// Command matchers
// ---------------------------------------------------------------------------

interface Ctx {
  cwd: string;
  out: ParseResult;
  depth: number;
}

function add(ctx: Ctx, eco: EcosystemId, spec: string) {
  const r = eco === 'npm' ? parseNpmSpec(spec) : parsePySpec(spec);
  if ('reason' in r) ctx.out.skipped.push(r);
  else ctx.out.packages.push(r);
}

interface FlagSpec {
  /** Flags that consume the next word as a value. */
  value: Set<string>;
  /** Value flags whose value is itself a package to check. */
  pkg?: Set<string>;
  /** Value flags whose value is a requirements file. */
  reqFile?: Set<string>;
}

/**
 * Walks args, collecting positional words. Handles --flag=value and value flags.
 * Packages passed via `pkg` flags are added directly.
 */
function positionals(args: string[], flags: FlagSpec, ctx: Ctx, eco: EcosystemId, stopAfterFirst = false): string[] {
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      if (!stopAfterFirst) pos.push(...args.slice(i + 1));
      else if (i + 1 < args.length) pos.push(args[i + 1]!);
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      const eq = a.indexOf('=');
      const flag = eq === -1 ? a : a.slice(0, eq);
      // Short flags glued to their value: -rrequirements.txt, -pfoo
      const glued = eq === -1 && /^-[a-zA-Z]./.test(a) && flags.value.has(a.slice(0, 2)) ? a.slice(0, 2) : undefined;
      const f = glued ?? flag;
      let value: string | undefined;
      if (glued) value = a.slice(2);
      else if (eq !== -1) value = a.slice(eq + 1);
      else if (flags.value.has(f)) value = args[++i];
      if (value !== undefined) {
        if (flags.pkg?.has(f)) add(ctx, eco, value);
        if (flags.reqFile?.has(f)) readRequirements(value, ctx);
      }
      continue;
    }
    pos.push(a);
    if (stopAfterFirst) break;
  }
  return pos;
}

function readRequirements(file: string, ctx: Ctx) {
  if (ctx.depth > 3) return;
  const full = path.resolve(ctx.cwd, file);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    ctx.out.skipped.push({ spec: `-r ${file}`, reason: "couldn't read requirements file" });
    return;
  }
  const inner: Ctx = { ...ctx, cwd: path.dirname(full), depth: ctx.depth + 1 };
  for (let line of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    line = line.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const nested = line.match(/^(?:-r|--requirement)[\s=]+(\S+)/);
    if (nested) {
      readRequirements(nested[1]!, inner);
      continue;
    }
    if (line.startsWith('-')) continue; // -e, -i, --hash, --index-url...
    add(inner, 'pypi', line.replace(/\s--\S+.*$/, ''));
  }
}

const NPM_INSTALL = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add']);
const NPM_FLAGS: FlagSpec = {
  value: new Set(['--registry', '--prefix', '-C', '--workspace', '-w', '--tag', '--omit', '--include', '--cache', '--userconfig', '--globalconfig', '--loglevel', '--install-strategy', '--before', '--otp', '--filter', '-F', '--dir', '--store-dir', '--reporter', '--cwd', '--network-timeout', '--modules-folder', '--backend', '--cache-dir', '-c', '--config', '--save-prefix']),
};
const NPX_FLAGS: FlagSpec = {
  value: new Set(['-p', '--package', '-c', '--call', '--registry', '--prefix', '--cache', '--userconfig', '-w', '--workspace', '--shell']),
  pkg: new Set(['-p', '--package']),
};

function npxLike(args: string[], ctx: Ctx) {
  ctx.out.isInstall = true;
  const before = ctx.out.packages.length;
  const pos = positionals(args, NPX_FLAGS, ctx, 'npm', true);
  // With --package, the positional is the binary to run, not a package.
  if (ctx.out.packages.length === before && pos[0]) add(ctx, 'npm', pos[0]);
}

function npmFamily(cmd: string, allArgs: string[], ctx: Ctx) {
  // Skip global flags before the subcommand: `pnpm --filter web add axios`
  let start = 0;
  while (allArgs[start]?.startsWith('-')) {
    const f = allArgs[start]!;
    start += !f.includes('=') && NPM_FLAGS.value.has(f) ? 2 : 1;
  }
  const args = allArgs.slice(start);
  const sub = args[0];
  if (!sub) return;
  const rest = args.slice(1);
  if (cmd === 'npm' && (sub === 'exec' || sub === 'x')) return npxLike(rest, ctx);
  if (cmd === 'pnpm' && sub === 'dlx') return npxLike(rest, ctx);
  if (cmd === 'yarn' && sub === 'dlx') return npxLike(rest, ctx);
  if (cmd === 'bun' && sub === 'x') return npxLike(rest, ctx);
  if (cmd === 'yarn' && sub === 'global' && rest[0] === 'add') return npmFamily(cmd, rest, ctx);

  const isInstall = NPM_INSTALL.has(sub) && (cmd !== 'bun' || ['add', 'a', 'install', 'i'].includes(sub));
  if (!isInstall && !(cmd === 'bun' && sub === 'a')) return;
  ctx.out.isInstall = true;
  for (const p of positionals(rest, NPM_FLAGS, ctx, 'npm')) add(ctx, 'npm', p);
}

const PIP_FLAGS: FlagSpec = {
  value: new Set(['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '-f', '--find-links', '-t', '--target', '--prefix', '--root', '--src', '--platform', '--python-version', '--implementation', '--abi', '--upgrade-strategy', '--progress-bar', '--log', '--cache-dir', '--python', '-p', '--only-binary', '--no-binary', '--config-settings', '-C', '--global-option', '--trusted-host', '--proxy', '--timeout', '--retries', '--exists-action', '--report', '--index-strategy', '--resolution', '--prerelease', '-P', '--upgrade-package', '--exclude-newer', '--index', '--default-index', '--keyring-provider', '--link-mode', '--group', '--extra', '--override', '--build-constraint']),
  reqFile: new Set(['-r', '--requirement']),
};
const UV_ADD_FLAGS: FlagSpec = {
  value: new Set(['--optional', '--group', '--extra', '--tag', '--branch', '--rev', '--index', '--default-index', '--python', '-p', '--package', '--script', '--directory', '--project', '--bounds', '--marker', '-m', '-r', '--requirements', '--index-url', '--extra-index-url', '-c', '--constraints']),
  reqFile: new Set(['-r', '--requirements']),
};
const UV_RUN_FLAGS: FlagSpec = {
  value: new Set(['--with', '--with-requirements', '--with-editable', '--from', '--python', '-p', '--directory', '--project', '--package', '--index', '--index-url', '--extra-index-url', '--group', '--extra', '--env-file', '-w']),
  pkg: new Set(['--with', '--from', '-w']),
  reqFile: new Set(['--with-requirements']),
};
const POETRY_FLAGS: FlagSpec = {
  value: new Set(['--group', '-G', '--extras', '-E', '--source', '--python', '--platform', '--markers', '--directory', '-C', '--project', '-P', '-dG']),
};
const PIPX_FLAGS: FlagSpec = {
  value: new Set(['--spec', '--python', '--index-url', '-i', '--pip-args', '--suffix', '--preinstall']),
  pkg: new Set(['--spec', '--preinstall']),
};

function pipInstall(args: string[], ctx: Ctx) {
  if (args[0] !== 'install') return;
  ctx.out.isInstall = true;
  for (const p of positionals(args.slice(1), PIP_FLAGS, ctx, 'pypi')) add(ctx, 'pypi', p);
}

function uvRunLike(args: string[], ctx: Ctx, runsPackage: boolean) {
  ctx.out.isInstall = true;
  // `uvx --from pkg cmd`: the positional is a command name, not a package.
  const hadFrom = args.some((a) => a === '--from' || a.startsWith('--from='));
  const pos = positionals(args, UV_RUN_FLAGS, ctx, 'pypi', true);
  if (runsPackage && !hadFrom && pos[0]) add(ctx, 'pypi', pos[0]);
}

function uv(args: string[], ctx: Ctx) {
  const [sub, ...rest] = args;
  if (sub === 'pip') return pipInstall(rest, ctx);
  if (sub === 'add') {
    ctx.out.isInstall = true;
    for (const p of positionals(rest, UV_ADD_FLAGS, ctx, 'pypi')) add(ctx, 'pypi', p);
    return;
  }
  if (sub === 'tool' && rest[0] === 'install') {
    ctx.out.isInstall = true;
    for (const p of positionals(rest.slice(1), UV_RUN_FLAGS, ctx, 'pypi')) add(ctx, 'pypi', p);
    return;
  }
  if (sub === 'tool' && rest[0] === 'run') return uvRunLike(rest.slice(1), ctx, true);
  if (sub === 'run' && rest.some((a) => a.startsWith('--with') || a === '-w')) return uvRunLike(rest, ctx, false);
}

function pipx(args: string[], ctx: Ctx) {
  const [sub, ...rest] = args;
  if (sub === 'install' || sub === 'inject' || sub === 'run') {
    ctx.out.isInstall = true;
    const before = ctx.out.packages.length;
    const pos = positionals(rest, PIPX_FLAGS, ctx, 'pypi', sub === 'run');
    // `pipx inject <venv> pkg...`: first positional is the venv name.
    const pkgs = sub === 'inject' ? pos.slice(1) : pos;
    if (sub === 'run' && ctx.out.packages.length > before) return; // --spec given
    for (const p of pkgs) add(ctx, 'pypi', p);
  }
}

function poetryLike(args: string[], ctx: Ctx) {
  if (args[0] !== 'add') return;
  ctx.out.isInstall = true;
  for (const p of positionals(args.slice(1), POETRY_FLAGS, ctx, 'pypi')) add(ctx, 'pypi', p);
}

const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'nice', 'doas', 'caffeinate']);
const SUDO_VALUE = new Set(['-u', '-g', '-C', '-h', '-p', '-U']);

function handleCommand(words: string[], ctx: Ctx) {
  let w = [...words];
  // Strip env assignments and wrappers.
  for (;;) {
    if (w[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
    else if (w[0] && WRAPPERS.has(w[0])) {
      w.shift();
      while (w[0]?.startsWith('-')) {
        const f = w.shift()!;
        if (SUDO_VALUE.has(f)) w.shift();
      }
    } else break;
  }
  if (!w.length) return;
  const cmd = path.basename(w[0]!);
  const args = w.slice(1);

  if (cmd === 'cd') {
    if (args[0]) ctx.cwd = path.resolve(ctx.cwd, args[0].replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
    return;
  }
  if ((cmd === 'bash' || cmd === 'sh' || cmd === 'zsh') && args[0] === '-c' && args[1] && ctx.depth < 3) {
    const inner: Ctx = { ...ctx, depth: ctx.depth + 1 };
    for (const c of splitShell(args[1])) handleCommand(c, inner);
    return;
  }

  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') return npmFamily(cmd, args, ctx);
  if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') return npxLike(args, ctx);
  if (/^pip(\d+(\.\d+)?)?$/.test(cmd)) return pipInstall(args, ctx);
  if (/^python(\d+(\.\d+)?)?$/.test(cmd) || cmd === 'py') {
    const m = args.indexOf('-m');
    if (m !== -1 && args[m + 1] === 'pip') return pipInstall(args.slice(m + 2), ctx);
    return;
  }
  if (cmd === 'uv') return uv(args, ctx);
  if (cmd === 'uvx') return uvRunLike(args, ctx, true);
  if (cmd === 'pipx') return pipx(args, ctx);
  if (cmd === 'poetry' || cmd === 'pdm' || cmd === 'rye') return poetryLike(args, ctx);
}

/** Parses a shell command string. `cwd` is used to resolve requirements files. */
export function parseInstallCommand(command: string, cwd = process.cwd()): ParseResult {
  const out: ParseResult = { packages: [], skipped: [], isInstall: false };
  const ctx: Ctx = { cwd, out, depth: 0 };
  for (const words of splitShell(command)) handleCommand(words, ctx);
  // Dedupe (same ecosystem + name + version).
  const seen = new Set<string>();
  out.packages = out.packages.filter((p) => {
    const k = `${p.ecosystem}:${p.name.toLowerCase()}@${p.version ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return out;
}

/** Cheap pre-filter so hooks can skip non-install commands without tokenizing. */
export const MAYBE_INSTALL = /\b(npm|npx|pnpm|pnpx|yarn|bun|bunx|pip\d*(\.\d+)?|python\d*(\.\d+)?|py|uv|uvx|pipx|poetry|pdm|rye)\b/;
