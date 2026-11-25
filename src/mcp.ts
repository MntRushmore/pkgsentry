import { createInterface } from 'node:readline';
import { createChecker, worstVerdict } from './check.js';
import { resolveEcosystem } from './ecosystems/index.js';
import { agentReason } from './output.js';
import { parseInstallCommand } from './parse.js';
import type { CheckOptions, PackageRef } from './types.js';
import { VERSION } from './version.js';

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Hand-rolled so pkgsentry ships with zero runtime dependencies. A supply-chain
 * tool should not drag in a supply chain.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  'Call check_package (or check_install_command) BEFORE installing any npm or PyPI package. ' +
  'BLOCK means do not install: tell the user why and use the suggested name if any. ' +
  'WARN means explain the concerns and ask the user first. ALLOW means proceed.';

export const TOOLS = [
  {
    name: 'check_package',
    title: 'Check a package before installing',
    description:
      'Checks whether an npm or PyPI package is safe to install. Detects hallucinated names that do not exist, ' +
      'typosquats of popular packages, brand-new or barely used packages, install scripts, and known malware (OSV.dev). ' +
      'Returns ALLOW, WARN, or BLOCK with reasons. Call this before every package install.',
    inputSchema: {
      type: 'object',
      properties: {
        ecosystem: { type: 'string', enum: ['npm', 'pypi'], description: 'Package registry.' },
        name: { type: 'string', description: 'Package name, e.g. "requests" or "@types/node".' },
        version: { type: 'string', description: 'Optional version or range.' },
      },
      required: ['ecosystem', 'name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'check_install_command',
    title: 'Check an install command',
    description:
      'Parses a shell command (npm/pnpm/yarn/bun install or add, npx, pip/uv/poetry install or add, uvx, pipx) ' +
      'and checks every package it would install. Returns the overall verdict plus per-package reasons.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The full shell command, e.g. "pip install -r requirements.txt flask".' },
        cwd: { type: 'string', description: 'Working directory, used to read requirements files and .pkgsentry.json.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const;

type JsonRpcId = string | number | null;
interface Request {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export async function handleMcpMessage(msg: Request, opts: CheckOptions = {}): Promise<object | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case 'initialize': {
      const requested = String(msg.params?.protocolVersion ?? '');
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pkgsentry', title: 'pkgsentry', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        if (name === 'check_package') return reply(await checkPackageTool(args, opts));
        if (name === 'check_install_command') return reply(await checkCommandTool(args, opts));
        return error(-32602, `Unknown tool: ${String(name)}`);
      } catch (e) {
        return reply({ isError: true, content: [{ type: 'text', text: `pkgsentry error: ${e instanceof Error ? e.message : e}` }] });
      }
    }
    default:
      if (isNotification) return undefined;
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

async function checkPackageTool(args: Record<string, unknown>, opts: CheckOptions) {
  const eco = resolveEcosystem(String(args.ecosystem ?? ''));
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!eco || !name) {
    return { isError: true, content: [{ type: 'text', text: 'Provide ecosystem ("npm" or "pypi") and name.' }] };
  }
  const ref: PackageRef = { ecosystem: eco.id, name, ...(typeof args.version === 'string' && args.version ? { version: args.version } : {}) };
  const result = await createChecker(opts).check(ref);
  return {
    content: [{ type: 'text', text: agentReason([result]) + advice(result.verdict) }],
    structuredContent: { verdict: result.verdict, results: [result] },
  };
}

async function checkCommandTool(args: Record<string, unknown>, opts: CheckOptions) {
  const command = typeof args.command === 'string' ? args.command : '';
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : opts.cwd;
  const parsed = parseInstallCommand(command, cwd);
  if (!parsed.packages.length) {
    const text = parsed.isInstall
      ? 'No registry packages named in this command (it installs from a manifest or local path). Nothing to check.'
      : 'Not a recognized install command. Nothing to check.';
    return { content: [{ type: 'text', text }], structuredContent: { verdict: 'ALLOW', results: [], skipped: parsed.skipped } };
  }
  const results = await createChecker({ ...opts, ...(cwd ? { cwd } : {}) }).checkAll(parsed.packages);
  const verdict = worstVerdict(results);
  return {
    content: [{ type: 'text', text: `Overall: ${verdict}\n` + agentReason(results, parsed.skipped) + advice(verdict) }],
    structuredContent: { verdict, results, skipped: parsed.skipped },
  };
}

function advice(v: string): string {
  if (v === 'BLOCK') return '\n\nDo not install. Use the suggested name if there is one, or ask the user.';
  if (v === 'WARN') return '\n\nExplain these concerns to the user and get confirmation before installing.';
  return '';
}

export function startMcpServer(opts: CheckOptions = {}): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (obj: object) => process.stdout.write(JSON.stringify(obj) + '\n');
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: Request;
    try {
      msg = JSON.parse(line) as Request;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    handleMcpMessage(msg, opts).then((res) => res && send(res));
  });
  return new Promise((resolve) => rl.on('close', resolve));
}

