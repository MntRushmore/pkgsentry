import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { runClaudeHook } from '../src/integrations/claude-code.js';
import { removeBlock, runSetup, runUninstall, upsertBlock, type Env } from '../src/integrations/setup.js';
import { handleMcpMessage } from '../src/mcp.js';
import { fakeFetch, OSV_EMPTY, tempHome } from './helpers.js';

const OSV = 'https://api.osv.dev/v1/querybatch';
const now = new Date('2026-11-25T00:00:00Z');
const routes = {
  [OSV]: OSV_EMPTY,
  'https://registry.npmjs.org/express/latest': { status: 200, body: { version: '5.1.0' } },
};

beforeEach(() => {
  tempHome();
});

describe('Claude Code hook', () => {
  const hook = (command: string, tool = 'Bash') =>
    runClaudeHook(JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: os.tmpdir() }), { fetch: fakeFetch(routes), now });

  it('ignores non-Bash tools and non-install commands without network', async () => {
    expect(await hook('npm i reqeusts', 'Write')).toEqual({ exitCode: 0 });
    expect(await hook('ls -la')).toEqual({ exitCode: 0 });
    expect(await hook('npm test')).toEqual({ exitCode: 0 });
  });

  it('stays quiet for safe installs', async () => {
    expect(await hook('npm install express')).toEqual({ exitCode: 0 });
  });

  it('denies blocked installs with a reason Claude can act on', async () => {
    const out = await hook('cd app && npm install expresss');
    const res = JSON.parse(out.stdout!);
    expect(res.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('Did you mean "express"?');
  });

  it('asks the user on WARN', async () => {
    const out = await runClaudeHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm i some-pkg' } }), {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      now,
    });
    expect(JSON.parse(out.stdout!).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('fails open on garbage input', async () => {
    const out = await runClaudeHook('not json');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBeUndefined();
  });
});

describe('MCP server', () => {
  const call = (method: string, params?: Record<string, unknown>, id: number | undefined = 1) =>
    handleMcpMessage({ jsonrpc: '2.0', id, method, params }, { fetch: fakeFetch(routes), now }) as Promise<any>;

  it('initializes and negotiates the protocol version', async () => {
    const res = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(res.result.protocolVersion).toBe('2025-03-26');
    expect(res.result.serverInfo.name).toBe('pkgsentry');
    expect(res.result.capabilities.tools).toBeDefined();
    const unknown = await call('initialize', { protocolVersion: '1999-01-01' });
    expect(unknown.result.protocolVersion).toBe('2025-06-18');
  });

  it('lists tools', async () => {
    const res = await call('tools/list');
    expect(res.result.tools.map((t: any) => t.name)).toEqual(['check_package', 'check_install_command']);
  });

  it('check_package blocks hallucinations', async () => {
    const res = await call('tools/call', { name: 'check_package', arguments: { ecosystem: 'pypi', name: 'reqeusts' } });
    expect(res.result.structuredContent.verdict).toBe('BLOCK');
    expect(res.result.content[0].text).toContain('Did you mean "requests"?');
    expect(res.result.content[0].text).toContain('Do not install');
  });

  it('check_install_command checks every package', async () => {
    const res = await call('tools/call', { name: 'check_install_command', arguments: { command: 'npm i express expresss' } });
    expect(res.result.structuredContent.verdict).toBe('BLOCK');
    expect(res.result.structuredContent.results).toHaveLength(2);
  });

  it('handles bad arguments, unknown tools, notifications, and unknown methods', async () => {
    expect((await call('tools/call', { name: 'check_package', arguments: {} })).result.isError).toBe(true);
    expect((await call('tools/call', { name: 'nope', arguments: {} })).error.code).toBe(-32602);
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect((await call('resources/list')).error.code).toBe(-32601);
    expect((await call('ping')).result).toEqual({});
  });
});

describe('setup / uninstall', () => {
  function sink() {
    let text = '';
    const out = new Writable({
      write(chunk, _enc, cb) {
        text += chunk;
        cb();
      },
    });
    return { out, text: () => text };
  }

  function makeEnv(agents: string[]): Env {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pkgsentry-home-'));
    const cwd = path.join(home, 'project');
    mkdirSync(path.join(cwd, '.git'), { recursive: true });
    if (agents.includes('claude')) mkdirSync(path.join(home, '.claude'));
    if (agents.includes('cursor')) mkdirSync(path.join(home, '.cursor'));
    if (agents.includes('windsurf')) mkdirSync(path.join(home, '.codeium', 'windsurf'), { recursive: true });
    if (agents.includes('codex')) mkdirSync(path.join(home, '.codex'));
    return { home, cwd, self: { command: 'npx', args: ['-y', 'pkgsentry@0.1.0'] }, onPath: () => false };
  }

  const read = (p: string) => readFileSync(p, 'utf8');

  it('detects agents and shows the plan without writing on dry run', async () => {
    const env = makeEnv(['claude', 'cursor']);
    const s = sink();
    expect(await runSetup({ env, out: s.out, dryRun: true })).toBe(0);
    expect(s.text()).toContain('Found:     Claude Code, Cursor');
    expect(s.text()).toContain('Not found: Windsurf, Codex CLI');
    expect(s.text()).toContain('~/.claude/settings.json');
    expect(s.text()).toContain('Dry run');
    expect(existsSync(path.join(env.home, '.claude', 'settings.json'))).toBe(false);
  });

  it('writes nothing if the user declines', async () => {
    const env = makeEnv(['claude']);
    expect(await runSetup({ env, out: sink().out, confirm: async () => false })).toBe(1);
    expect(existsSync(path.join(env.home, '.claude', 'settings.json'))).toBe(false);
  });

  it('round-trips every agent, preserving existing config', async () => {
    const env = makeEnv(['claude', 'cursor', 'windsurf', 'codex']);
    const claudeSettings = path.join(env.home, '.claude', 'settings.json');
    const existing = {
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }] },
    };
    writeFileSync(claudeSettings, JSON.stringify(existing, null, 2) + '\n');
    const cursorMcp = path.join(env.home, '.cursor', 'mcp.json');
    writeFileSync(cursorMcp, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const codexToml = path.join(env.home, '.codex', 'config.toml');
    writeFileSync(codexToml, 'model = "o4"\n');

    expect(await runSetup({ env, out: sink().out, yes: true })).toBe(0);

    const settings = JSON.parse(read(claudeSettings));
    expect(settings.model).toBe('opus');
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[1]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'npx -y pkgsentry@0.1.0 hook claude-code', timeout: 60 }],
    });
    expect(JSON.parse(read(cursorMcp)).mcpServers).toEqual({
      other: { command: 'x' },
      pkgsentry: { command: 'npx', args: ['-y', 'pkgsentry@0.1.0', 'mcp'] },
    });
    expect(read(path.join(env.cwd, '.cursor', 'rules', 'pkgsentry.mdc'))).toContain('alwaysApply: true');
    expect(JSON.parse(read(path.join(env.home, '.codeium', 'windsurf', 'mcp_config.json'))).mcpServers.pkgsentry).toBeDefined();
    expect(read(path.join(env.home, '.codeium', 'windsurf', 'memories', 'global_rules.md'))).toContain('check_package');
    expect(read(codexToml)).toContain('model = "o4"\n\n# >>> pkgsentry');
    expect(read(codexToml)).toContain('[mcp_servers.pkgsentry]\ncommand = "npx"\nargs = ["-y","pkgsentry@0.1.0","mcp"]');
    expect(read(path.join(env.home, '.codex', 'AGENTS.md'))).toContain('Package safety (pkgsentry)');
    expect(read(claudeSettings + '.pkgsentry.bak')).toBe(JSON.stringify(existing, null, 2) + '\n');

    // Idempotent
    const again = sink();
    await runSetup({ env, out: again.out, yes: true });
    expect(again.text()).toContain('Already set up');

    expect(await runUninstall({ env, out: sink().out, yes: true })).toBe(0);
    expect(JSON.parse(read(claudeSettings))).toEqual(existing);
    expect(JSON.parse(read(cursorMcp)).mcpServers).toEqual({ other: { command: 'x' } });
    expect(existsSync(path.join(env.cwd, '.cursor', 'rules', 'pkgsentry.mdc'))).toBe(false);
    expect(read(codexToml)).toBe('model = "o4"\n');
    expect(existsSync(path.join(env.home, '.codex', 'AGENTS.md'))).toBe(false);
  });

  it('refuses to touch invalid JSON', async () => {
    const env = makeEnv(['claude']);
    writeFileSync(path.join(env.home, '.claude', 'settings.json'), '{ nope');
    const s = sink();
    await runSetup({ env, out: s.out, yes: true });
    expect(s.text()).toContain("isn't valid JSON");
    expect(read(path.join(env.home, '.claude', 'settings.json'))).toBe('{ nope');
  });

  it('can target one agent', async () => {
    const env = makeEnv(['claude', 'cursor']);
    await runSetup({ env, out: sink().out, yes: true, only: ['cursor'] });
    expect(existsSync(path.join(env.home, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(path.join(env.home, '.cursor', 'mcp.json'))).toBe(true);
    expect(await runSetup({ env, out: sink().out, yes: true, only: ['vim'] })).toBe(64);
  });
});

describe('marker blocks', () => {
  it('upserts and removes cleanly', () => {
    const once = upsertBlock('# Mine\n', 'hello', 'html');
    expect(upsertBlock(once, 'hello', 'html')).toBe(once);
    expect(upsertBlock(once, 'bye', 'html')).toContain('bye');
    expect(removeBlock(once, 'html')).toBe('# Mine\n');
    expect(removeBlock(upsertBlock(undefined, 'x', 'hash'), 'hash')).toBeUndefined();
  });
});
