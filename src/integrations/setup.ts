import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { paint } from '../output.js';
import { VERSION } from '../version.js';

/**
 * `pkgsentry setup` / `pkgsentry uninstall`
 *
 *   Claude Code  PreToolUse hook on Bash in ~/.claude/settings.json (hard enforcement)
 *   Cursor       MCP server in ~/.cursor/mcp.json + .cursor/rules/pkgsentry.mdc in the current project
 *   Windsurf     MCP server in ~/.codeium/windsurf/mcp_config.json + global_rules.md
 *   Codex CLI    MCP server in ~/.codex/config.toml + ~/.codex/AGENTS.md
 *
 * Every change is shown before it's written, original files are backed up to
 * <file>.pkgsentry.bak, and uninstall removes exactly what setup added.
 */

export interface Invocation {
  command: string;
  args: string[];
}

export interface Env {
  home: string;
  cwd: string;
  self: Invocation;
  onPath: (bin: string) => boolean;
}

export interface FileEdit {
  path: string;
  before: string | undefined;
  /** undefined = delete the file */
  after: string | undefined;
  summary: string;
}

export interface AgentPlan {
  edits: FileEdit[];
  notes: string[];
}

export interface AgentDef {
  id: string;
  name: string;
  detect(env: Env): boolean;
  install(env: Env): Promise<AgentPlan>;
  uninstall(env: Env): Promise<AgentPlan>;
}

const MARK = 'pkgsentry';

export const RULES = `## Package safety (pkgsentry)

Before installing any npm or PyPI package (npm/pnpm/yarn/bun add or install, npx, pip/uv/poetry add or install, uvx, pipx), call the \`check_package\` tool from the pkgsentry MCP server for each new package, or \`check_install_command\` with the full command.

- BLOCK: do not install it. Tell the user why. If a correct name is suggested, use that instead.
- WARN: explain the concerns to the user and ask before installing.
- ALLOW: go ahead.

Never guess package names. If you are not sure a package exists, check it first.`;

// --- helpers ---------------------------------------------------------------

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function readJson(file: string): Promise<{ text: string | undefined; data: Record<string, any> }> {
  const text = await readText(file);
  if (text === undefined || !text.trim()) return { text, data: {} };
  try {
    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('not an object');
    return { text, data };
  } catch {
    throw new Error(`${file} isn't valid JSON; not touching it. Fix it or edit it by hand.`);
  }
}

const json = (data: unknown) => JSON.stringify(data, null, 2) + '\n';

function blockMarkers(style: 'hash' | 'html') {
  return style === 'hash'
    ? { start: `# >>> ${MARK} (managed by \`pkgsentry setup\`) >>>`, end: `# <<< ${MARK} <<<` }
    : { start: `<!-- >>> ${MARK} (managed by \`pkgsentry setup\`) >>> -->`, end: `<!-- <<< ${MARK} <<< -->` };
}

export function upsertBlock(text: string | undefined, body: string, style: 'hash' | 'html'): string {
  const { start, end } = blockMarkers(style);
  const block = `${start}\n${body}\n${end}`;
  const current = text ?? '';
  const re = new RegExp(`${escape(start)}[\\s\\S]*?${escape(end)}`);
  if (re.test(current)) return current.replace(re, block);
  return current ? `${current.replace(/\n*$/, '')}\n\n${block}\n` : `${block}\n`;
}

export function removeBlock(text: string | undefined, style: 'hash' | 'html'): string | undefined {
  if (text === undefined) return undefined;
  const { start, end } = blockMarkers(style);
  const re = new RegExp(`\\n*${escape(start)}[\\s\\S]*?${escape(end)}\\n?`);
  const out = text.replace(re, '\n').replace(/^\n+/, '');
  // If our block was all there was, remove the file rather than leave it empty.
  return out.trim() ? out : undefined;
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const tilde = (env: Env, p: string) => (p.startsWith(env.home) ? '~' + p.slice(env.home.length) : path.relative(env.cwd, p) || p);
const shellJoin = (inv: Invocation, ...extra: string[]) => [inv.command, ...inv.args, ...extra].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
const isOurs = (cmd: unknown) => typeof cmd === 'string' && /pkgsentry/.test(cmd);

function mcpEntry(env: Env) {
  return { command: env.self.command, args: [...env.self.args, 'mcp'] };
}

function looksLikeProject(dir: string): boolean {
  return ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml', 'go.mod'].some((f) =>
    existsSync(path.join(dir, f)),
  );
}

// --- agents ----------------------------------------------------------------

const claudeCode: AgentDef = {
  id: 'claude-code',
  name: 'Claude Code',
  detect: (env) => existsSync(path.join(env.home, '.claude')) || env.onPath('claude'),
  async install(env) {
    const file = path.join(env.home, '.claude', 'settings.json');
    const { text, data } = await readJson(file);
    const command = shellJoin(env.self, 'hook', 'claude-code');
    stripClaudeHook(data);
    data.hooks ??= {};
    data.hooks.PreToolUse ??= [];
    data.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 60 }] });
    return {
      edits: [{ path: file, before: text, after: json(data), summary: `PreToolUse hook on Bash: ${command}` }],
      notes: ['Claude Code: installs are checked before they run. BLOCK denies the command, WARN asks you.'],
    };
  },
  async uninstall(env) {
    const file = path.join(env.home, '.claude', 'settings.json');
    const { text, data } = await readJson(file);
    if (!stripClaudeHook(data)) return { edits: [], notes: [] };
    return { edits: [{ path: file, before: text, after: json(data), summary: 'remove pkgsentry PreToolUse hook' }], notes: [] };
  },
};

/** Removes our hook entries in place. Returns true if anything was removed. */
function stripClaudeHook(data: Record<string, any>): boolean {
  const list = data.hooks?.PreToolUse;
  if (!Array.isArray(list)) return false;
  let removed = false;
  for (const group of list) {
    if (!Array.isArray(group?.hooks)) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter((h: any) => !isOurs(h?.command));
    if (group.hooks.length !== before) removed = true;
  }
  data.hooks.PreToolUse = list.filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
  if (data.hooks.PreToolUse.length === 0) delete data.hooks.PreToolUse;
  if (Object.keys(data.hooks).length === 0) delete data.hooks;
  return removed;
}

function jsonMcpAgent(def: { id: string; name: string; dir: string[]; file: string[]; rules?: (env: Env) => { path: string; style: 'html' | 'file' } | undefined }): AgentDef {
  return {
    id: def.id,
    name: def.name,
    detect: (env) => existsSync(path.join(env.home, ...def.dir)),
    async install(env) {
      const file = path.join(env.home, ...def.file);
      const { text, data } = await readJson(file);
      data.mcpServers ??= {};
      data.mcpServers.pkgsentry = mcpEntry(env);
      const edits: FileEdit[] = [{ path: file, before: text, after: json(data), summary: `MCP server "pkgsentry": ${shellJoin(env.self, 'mcp')}` }];
      const notes: string[] = [];
      const rules = def.rules?.(env);
      if (rules) {
        const before = await readText(rules.path);
        edits.push({
          path: rules.path,
          before,
          after: rules.style === 'file' ? cursorRuleFile() : upsertBlock(before, RULES, 'html'),
          summary: 'rule: check packages with pkgsentry before installing',
        });
      } else if (def.id === 'cursor') {
        notes.push('Cursor: run `pkgsentry setup cursor` inside each project to add the rules file, or paste the rule into Settings > Rules.');
      }
      notes.push(`${def.name}: restart it (or reload MCP servers) to pick up pkgsentry.`);
      return { edits, notes };
    },
    async uninstall(env) {
      const edits: FileEdit[] = [];
      const file = path.join(env.home, ...def.file);
      const { text, data } = await readJson(file);
      if (data.mcpServers?.pkgsentry) {
        delete data.mcpServers.pkgsentry;
        edits.push({ path: file, before: text, after: json(data), summary: 'remove MCP server "pkgsentry"' });
      }
      const rules = def.rules?.(env);
      if (rules) {
        const before = await readText(rules.path);
        if (before?.includes(MARK)) {
          const after = rules.style === 'file' ? undefined : removeBlock(before, 'html');
          edits.push({ path: rules.path, before, after, summary: rules.style === 'file' ? 'delete rules file' : 'remove pkgsentry rule' });
        }
      }
      return { edits, notes: [] };
    },
  };
}

function cursorRuleFile(): string {
  return `---\ndescription: Check packages with pkgsentry before installing them (managed by pkgsentry setup)\nalwaysApply: true\n---\n\n${RULES}\n`;
}

const cursor = jsonMcpAgent({
  id: 'cursor',
  name: 'Cursor',
  dir: ['.cursor'],
  file: ['.cursor', 'mcp.json'],
  rules: (env) => (looksLikeProject(env.cwd) && env.cwd !== env.home ? { path: path.join(env.cwd, '.cursor', 'rules', 'pkgsentry.mdc'), style: 'file' } : undefined),
});

const windsurf = jsonMcpAgent({
  id: 'windsurf',
  name: 'Windsurf',
  dir: ['.codeium', 'windsurf'],
  file: ['.codeium', 'windsurf', 'mcp_config.json'],
  rules: (env) => ({ path: path.join(env.home, '.codeium', 'windsurf', 'memories', 'global_rules.md'), style: 'html' }),
});

const codex: AgentDef = {
  id: 'codex',
  name: 'Codex CLI',
  detect: (env) => existsSync(path.join(env.home, '.codex')) || env.onPath('codex'),
  async install(env) {
    const config = path.join(env.home, '.codex', 'config.toml');
    const agents = path.join(env.home, '.codex', 'AGENTS.md');
    const before = await readText(config);
    const stripped = removeBlock(before, 'hash') ?? '';
    if (/^\s*\[mcp_servers\.pkgsentry\]/m.test(stripped)) {
      return { edits: [], notes: [`Codex: ${tilde(env, config)} already defines [mcp_servers.pkgsentry]; leaving it alone.`] };
    }
    const toml = `[mcp_servers.pkgsentry]\ncommand = ${JSON.stringify(env.self.command)}\nargs = ${JSON.stringify([...env.self.args, 'mcp'])}`;
    const agentsBefore = await readText(agents);
    return {
      edits: [
        { path: config, before, after: upsertBlock(before, toml, 'hash'), summary: `MCP server "pkgsentry": ${shellJoin(env.self, 'mcp')}` },
        { path: agents, before: agentsBefore, after: upsertBlock(agentsBefore, RULES, 'html'), summary: 'rule: check packages with pkgsentry before installing' },
      ],
      notes: ['Codex CLI: start a new session to pick up pkgsentry.'],
    };
  },
  async uninstall(env) {
    const edits: FileEdit[] = [];
    for (const [file, style, summary] of [
      [path.join(env.home, '.codex', 'config.toml'), 'hash', 'remove MCP server "pkgsentry"'],
      [path.join(env.home, '.codex', 'AGENTS.md'), 'html', 'remove pkgsentry rule'],
    ] as const) {
      const before = await readText(file);
      if (before?.includes(MARK)) edits.push({ path: file, before, after: removeBlock(before, style), summary });
    }
    return { edits, notes: [] };
  },
};

export const AGENTS: AgentDef[] = [claudeCode, cursor, windsurf, codex];

// --- environment -----------------------------------------------------------

export function onPath(bin: string): boolean {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      try {
        if (dir && statSync(path.join(dir, bin + ext)).isFile()) return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

/** How agents should invoke pkgsentry: a global install if there is one, otherwise a pinned npx. */
export function selfInvocation(): Invocation {
  const override = process.env.PKGSENTRY_SETUP_COMMAND;
  if (override) {
    const [command, ...args] = override.split(' ').filter(Boolean);
    return { command: command!, args };
  }
  if (onPath('pkgsentry') && !process.argv[1]?.includes('_npx')) return { command: 'pkgsentry', args: [] };
  return { command: 'npx', args: ['-y', `pkgsentry@${VERSION}`] };
}

export function defaultEnv(): Env {
  return { home: os.homedir(), cwd: process.cwd(), self: selfInvocation(), onPath };
}

// --- runner ----------------------------------------------------------------

interface RunOpts {
  yes?: boolean;
  dryRun?: boolean;
  only?: string[];
  env?: Env;
  out?: NodeJS.WritableStream & { isTTY?: boolean };
  confirm?: (q: string) => Promise<boolean>;
}

async function ask(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(q)).trim());
  } finally {
    rl.close();
  }
}

function previewLines(edit: FileEdit): string[] {
  const before = new Set((edit.before ?? '').split('\n'));
  const after = edit.after === undefined ? [] : edit.after.split('\n');
  const added = after.filter((l) => l.trim() && !before.has(l));
  const afterSet = new Set(after);
  const removed = (edit.before ?? '').split('\n').filter((l) => l.trim() && !afterSet.has(l));
  return [...removed.slice(0, 12).map((l) => `- ${l}`), ...added.slice(0, 12).map((l) => `+ ${l}`)];
}

async function execute(mode: 'install' | 'uninstall', opts: RunOpts): Promise<number> {
  const env = opts.env ?? defaultEnv();
  const out = opts.out ?? process.stdout;
  const c = paint(out as NodeJS.WriteStream);
  const say = (s = '') => out.write(s + '\n');
  const only = (opts.only ?? []).map((s) => s.toLowerCase());
  const unknown = only.filter((o) => !AGENTS.some((a) => a.id === o));
  if (unknown.length) {
    say(`${c.red('error')} unknown agent ${unknown.join(', ')}. Known: ${AGENTS.map((a) => a.id).join(', ')}`);
    return 64;
  }

  const candidates = only.length ? AGENTS.filter((a) => only.includes(a.id)) : AGENTS;
  const found = mode === 'install' ? candidates.filter((a) => only.length || a.detect(env)) : candidates;

  say(c.bold(`pkgsentry ${mode === 'install' ? 'setup' : 'uninstall'}`));
  if (mode === 'install' && !only.length) {
    say(`Found:     ${found.length ? found.map((a) => a.name).join(', ') : c.dim('no supported agents')}`);
    const missing = AGENTS.filter((a) => !found.includes(a));
    if (missing.length) say(c.dim(`Not found: ${missing.map((a) => a.name).join(', ')}`));
  }
  say();

  const plans: Array<{ agent: AgentDef; plan: AgentPlan }> = [];
  for (const agent of found) {
    try {
      const plan = await (mode === 'install' ? agent.install(env) : agent.uninstall(env));
      plan.edits = plan.edits.filter((e) => e.before !== e.after);
      plans.push({ agent, plan });
    } catch (e) {
      say(`${c.yellow('skip')} ${agent.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const edits = plans.flatMap((p) => p.plan.edits);
  if (!edits.length) {
    say(mode === 'install' ? 'Nothing to change. Already set up.' : 'Nothing to remove.');
    return 0;
  }

  for (const { agent, plan } of plans) {
    if (!plan.edits.length) continue;
    say(c.bold(agent.name));
    for (const e of plan.edits) {
      const tag = e.before === undefined ? c.green(' (new file)') : e.after === undefined ? c.red(' (delete)') : '';
      say(`  ${c.cyan(tilde(env, e.path))}${tag}`);
      say(`    ${e.summary}`);
      for (const l of previewLines(e)) say(c.dim(`      ${l}`));
    }
    say();
  }

  if (opts.dryRun) {
    say(c.dim('Dry run: nothing written.'));
    return 0;
  }
  const go = opts.yes || (await (opts.confirm ?? ask)(`${mode === 'install' ? 'Apply' : 'Remove'} these changes? [y/N] `));
  if (!go) {
    say('No changes made.');
    return 1;
  }

  for (const e of edits) {
    if (e.before !== undefined) await copyFile(e.path, `${e.path}.pkgsentry.bak`);
    if (e.after === undefined) {
      await rm(e.path, { force: true });
    } else {
      await mkdir(path.dirname(e.path), { recursive: true });
      await writeFile(e.path, e.after);
    }
  }
  say(c.green(`Done.`) + c.dim(` Backups saved next to each file as *.pkgsentry.bak`));
  for (const n of plans.flatMap((p) => p.plan.notes)) say(c.dim(`- ${n}`));
  if (mode === 'install') say(c.dim('Undo any time with: pkgsentry uninstall'));
  return 0;
}

export const runSetup = (opts: RunOpts = {}) => execute('install', opts);
export const runUninstall = (opts: RunOpts = {}) => execute('uninstall', opts);
