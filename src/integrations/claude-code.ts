import { createChecker, worstVerdict } from '../check.js';
import { agentReason } from '../output.js';
import { MAYBE_INSTALL, parseInstallCommand } from '../parse.js';
import type { CheckOptions } from '../types.js';

/**
 * Claude Code PreToolUse hook.
 *
 * Claude Code pipes JSON like {"tool_name":"Bash","tool_input":{"command":"..."},"cwd":"..."}
 * on stdin. We answer with a permission decision:
 *
 *   BLOCK -> "deny"  (the command never runs; the reason goes back to Claude so it can fix the name)
 *   WARN  -> "ask"   (the user sees the reasons and decides)
 *   ALLOW -> no output, normal permission flow continues
 *
 * Internal errors fail open with a note on stderr: a bug in pkgsentry should never brick the agent.
 */
export interface HookOutput {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string };
  cwd?: string;
}

export async function runClaudeHook(raw: string, opts: CheckOptions = {}): Promise<HookOutput> {
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return { exitCode: 0, stderr: 'pkgsentry: hook got invalid JSON on stdin, skipping check\n' };
  }
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string' || !MAYBE_INSTALL.test(command)) {
    return { exitCode: 0 };
  }

  try {
    const cwd = input.cwd || process.cwd();
    const parsed = parseInstallCommand(command, cwd);
    if (!parsed.packages.length) return { exitCode: 0 };

    const results = await createChecker({ ...opts, cwd }).checkAll(parsed.packages);
    const verdict = worstVerdict(results);
    if (verdict === 'ALLOW') return { exitCode: 0 };

    const flagged = results.filter((r) => r.verdict !== 'ALLOW');
    const details = agentReason(flagged);
    const reason =
      verdict === 'BLOCK'
        ? `pkgsentry blocked this install:\n${details}\n\nDo not retry with the same name. Use the correct package name if one is suggested, or ask the user. If the user trusts this package, they can add it to "allow" in .pkgsentry.json.`
        : `pkgsentry flagged this install for review:\n${details}`;

    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict === 'BLOCK' ? 'deny' : 'ask',
          permissionDecisionReason: reason,
        },
      }),
    };
  } catch (e) {
    return { exitCode: 0, stderr: `pkgsentry: check failed (${e instanceof Error ? e.message : e}); allowing command\n` };
  }
}
