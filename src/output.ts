import type { SkippedSpec } from './parse.js';
import type { CheckResult, Verdict } from './types.js';

const useColor = (stream: NodeJS.WriteStream = process.stdout) =>
  !process.env.NO_COLOR && (Boolean(process.env.FORCE_COLOR) || stream.isTTY === true);

export function paint(stream: NodeJS.WriteStream = process.stdout) {
  const on = useColor(stream);
  const wrap = (open: string, close: string) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    red: wrap('31', '39'),
    green: wrap('32', '39'),
    yellow: wrap('33', '39'),
    cyan: wrap('36', '39'),
    badge(v: Verdict) {
      const label = ` ${v.padEnd(5)}`;
      if (!on) return `${v.padEnd(5)}`;
      const bg = v === 'BLOCK' ? '41;97' : v === 'WARN' ? '43;30' : '42;30';
      return `\x1b[${bg};1m${label} \x1b[0m`;
    },
  };
}

/** Formats one result the way the README promises:
 *
 *    BLOCK  reqeusts (pypi)
 *    - Doesn't exist on PyPI. Did you mean "requests"?
 */
export function formatResult(r: CheckResult, stream?: NodeJS.WriteStream): string {
  const c = paint(stream);
  const label = `${r.name}${r.version ? c.dim('@' + r.version) : ''} ${c.dim(`(${r.ecosystem})`)}`;
  const facts = r.facts.length ? `  ${c.dim(r.facts.join(' · '))}` : '';
  const lines = [`  ${c.badge(r.verdict)}  ${c.bold(label)}${facts}`];
  for (const s of r.signals) {
    const bullet = s.severity === 'info' ? c.dim(`  - ${s.message}`) : `  - ${s.message}`;
    lines.push(bullet);
  }
  return lines.join('\n');
}

export function formatResults(results: CheckResult[], skipped: SkippedSpec[] = [], stream?: NodeJS.WriteStream): string {
  const c = paint(stream);
  const out = results.map((r) => formatResult(r, stream));
  for (const s of skipped) out.push(c.dim(`  SKIP   ${s.spec} (${s.reason})`));
  return out.join('\n');
}

export function summaryLine(results: CheckResult[], stream?: NodeJS.WriteStream): string {
  const c = paint(stream);
  const n = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  const parts = [
    n('BLOCK') && c.red(`${n('BLOCK')} blocked`),
    n('WARN') && c.yellow(`${n('WARN')} need a look`),
    n('ALLOW') && c.green(`${n('ALLOW')} ok`),
  ].filter(Boolean);
  return parts.join(', ');
}

/** Compact, plain-text explanation for agents (hook reasons, MCP replies). */
export function agentReason(results: CheckResult[], skipped: SkippedSpec[] = []): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.verdict} ${r.name}${r.version ? '@' + r.version : ''} (${r.ecosystem})`);
    for (const s of r.signals.filter((s) => s.severity !== 'info')) lines.push(`  - ${s.message}`);
  }
  for (const s of skipped) lines.push(`SKIP ${s.spec} (${s.reason})`);
  return lines.join('\n');
}
