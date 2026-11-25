import type { OsvFinding } from './sources/osv.js';
import type { RepoStatus } from './sources/repo.js';
import type { TypoMatch } from './typo.js';
import type { PackageMeta, Signal, Verdict } from './types.js';

/**
 * Scoring
 * -------
 * Each risk signal adds points. Some signals are hard blocks regardless of score.
 *
 *   score >= 70  -> BLOCK
 *   score >= 25  -> WARN
 *   otherwise    -> ALLOW
 *
 * Popular packages (in the bundled top-5000 list, or >= 50k downloads/week) are
 * capped at WARN unless a hard-block signal fires. Heuristics alone should never
 * stop someone installing express.
 */
export const BLOCK_AT = 70;
export const WARN_AT = 25;
export const POPULAR_WEEKLY = 50_000;

export const POINTS = {
  typosquat: 50,
  typosquatPopular: 0,
  veryNew: 35, // < 7 days
  new: 25, // < 30 days
  veryLowDownloads: 25, // < 50/week
  lowDownloads: 10, // < 1000/week
  installScript: 20,
  suspiciousInstallScript: 35,
  noRepo: 10,
  repoMissing: 25,
  deprecated: 10,
  versionMissing: 25,
  knownVulns: 25,
  oldMalware: 15,
  lookupFailed: 30,
} as const;

export interface Evidence {
  displayEcosystem: string;
  meta?: PackageMeta;
  lookupError?: string;
  popular: boolean;
  weeklyDownloads?: number;
  osv?: OsvFinding;
  osvError?: string;
  repo?: RepoStatus;
  typo?: TypoMatch;
  /** Did-you-mean for packages that don't exist. */
  suggestion?: string;
  requestedVersion?: string;
  exactVersion: boolean;
  installScriptsApply: boolean;
  now: Date;
}

const SUSPICIOUS_SCRIPT =
  /\b(curl|wget|Invoke-WebRequest|iwr|powershell|bash\s+-c|sh\s+-c|eval|base64|child_process|https?:\/\/|\/dev\/tcp|nc\s+-|python\s+-c)\b/i;

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function ageDays(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / 86_400_000;
}

function plural(n: number, w: string) {
  if (n === 1) return `${n} ${w}`;
  return `${n} ${w.endsWith('y') ? w.slice(0, -1) + 'ies' : w + 's'}`;
}

export function score(e: Evidence): { verdict: Verdict; score: number; signals: Signal[]; facts: string[] } {
  const signals: Signal[] = [];
  const facts: string[] = [];
  const add = (s: Signal) => signals.push(s);
  const reg = e.displayEcosystem;

  // --- Hard blocks ---------------------------------------------------------
  // A malware advisory blocks if an install today would get a bad version: it covers every
  // version, the pinned version is affected (OSV already filtered by version), or the current
  // latest release is one of the listed versions. Otherwise only past releases were bad
  // (e.g. has-ansi@6.0.1 in the Sept 2025 npm compromise) and we just note it.
  const mal = e.osv?.malicious ?? [];
  const latest = e.meta?.latestVersion;
  const malAll = mal.filter((m) => m.allVersions || e.exactVersion || (latest !== undefined && m.versions?.includes(latest)) || !e.meta?.exists);
  if (malAll.length) {
    add({
      id: 'malicious',
      severity: 'block',
      points: 100,
      message: `Known malicious package (${malAll.map((m) => m.id).join(', ')}): ${malAll[0]!.summary}`,
    });
  } else if (mal.length && e.meta?.exists && !e.meta.securityHolding) {
    add({
      id: 'malicious_versions',
      severity: 'medium',
      points: POINTS.oldMalware,
      message: `Some past versions were compromised (${mal.map((m) => m.id).join(', ')}). Don't pin old versions.`,
    });
  }

  if (e.lookupError) {
    add({
      id: 'lookup_failed',
      severity: 'medium',
      points: POINTS.lookupFailed,
      message: `Couldn't reach ${reg} to verify this package (${e.lookupError}).`,
    });
  } else if (e.meta && !e.meta.exists) {
    add({
      id: 'not_found',
      severity: 'block',
      points: 100,
      message:
        `Doesn't exist on ${reg}` +
        (e.suggestion ? `. Did you mean "${e.suggestion}"?` : '. Likely a hallucinated name.'),
    });
  } else if (e.meta?.securityHolding) {
    add({
      id: 'security_holding',
      severity: 'block',
      points: 100,
      message: `${reg} removed this package for malicious content and replaced it with a placeholder.`,
    });
  }

  const meta = e.meta?.exists ? e.meta : undefined;

  // --- Soft signals --------------------------------------------------------
  if (meta && !meta.securityHolding) {
    if (e.typo) {
      const popularSelf = (e.weeklyDownloads ?? 0) >= 10_000;
      const how =
        e.typo.kind === 'separator'
          ? 'differs only by separators'
          : e.typo.kind === 'scope'
            ? 'looks like a scoped package without its scope'
            : e.typo.kind === 'homoglyph'
              ? 'uses lookalike characters'
              : `is ${plural(e.typo.distance, 'edit')} away`;
      add({
        id: 'typosquat',
        severity: popularSelf ? 'info' : 'high',
        points: popularSelf ? POINTS.typosquatPopular : POINTS.typosquat,
        message: `Name ${how} from popular package "${e.typo.target}".${popularSelf ? ' It is widely used itself, so probably fine.' : ' Possible typosquat.'}`,
      });
    }

    if (meta.createdAt && !e.popular) {
      const days = ageDays(meta.createdAt, e.now);
      if (days < 7) {
        add({ id: 'new_package', severity: 'high', points: POINTS.veryNew, message: `First published ${days < 1 ? 'today' : plural(Math.floor(days), 'day') + ' ago'}.` });
      } else if (days < 30) {
        add({ id: 'new_package', severity: 'medium', points: POINTS.new, message: `First published ${plural(Math.floor(days), 'day')} ago.` });
      }
    }
    if (e.popular) facts.push(`top-5000 ${reg} package`);
    if (meta.createdAt) facts.push(`since ${meta.createdAt.slice(0, 4)}`);

    if (e.weeklyDownloads !== undefined) {
      facts.push(`${fmtCount(e.weeklyDownloads)} downloads/week`);
      if (!e.popular && e.weeklyDownloads < 50) {
        add({ id: 'low_downloads', severity: 'medium', points: POINTS.veryLowDownloads, message: `Only ${e.weeklyDownloads} downloads last week.` });
      } else if (!e.popular && e.weeklyDownloads < 1000) {
        add({ id: 'low_downloads', severity: 'low', points: POINTS.lowDownloads, message: `Low usage: ${fmtCount(e.weeklyDownloads)} downloads last week.` });
      }
    }

    if (e.installScriptsApply && meta.installScripts) {
      const entries = Object.entries(meta.installScripts);
      const sus = entries.find(([, cmd]) => SUSPICIOUS_SCRIPT.test(cmd));
      const shown = (sus ?? entries[0])!;
      const cmd = shown[1].length > 60 ? shown[1].slice(0, 57) + '...' : shown[1];
      add(
        sus
          ? { id: 'install_script', severity: 'high', points: POINTS.suspiciousInstallScript, message: `Runs a suspicious ${sus[0]} script on install: \`${cmd}\`` }
          : {
              id: 'install_script',
              severity: e.popular ? 'info' : 'low',
              points: e.popular ? 0 : POINTS.installScript,
              message: `Runs a ${shown[0]} script on install: \`${cmd}\``,
            },
      );
    }

    if (!e.popular) {
      if (!meta.repositoryUrl) {
        add({ id: 'no_repository', severity: 'low', points: POINTS.noRepo, message: 'No source repository linked.' });
      } else if (e.repo === 'missing') {
        add({ id: 'repository_missing', severity: 'medium', points: POINTS.repoMissing, message: `Linked repository doesn't exist: ${meta.repositoryUrl}` });
      }
    }

    if (meta.deprecated) {
      add({ id: 'deprecated', severity: 'low', points: POINTS.deprecated, message: `Deprecated: ${meta.deprecated.slice(0, 100)}` });
    }

    if (e.requestedVersion && meta.versionExists === false) {
      add({
        id: 'version_not_found',
        severity: 'medium',
        points: POINTS.versionMissing,
        message: `Version ${e.requestedVersion} doesn't exist (latest is ${meta.latestVersion}).`,
      });
    }

    const vulns = e.osv?.vulnerable ?? [];
    if (vulns.length) {
      add({
        id: 'known_vulnerabilities',
        severity: 'medium',
        points: POINTS.knownVulns,
        message: `${plural(vulns.length, 'known vulnerability')} in ${e.requestedVersion} (${vulns.slice(0, 3).map((v) => v.id).join(', ')}${vulns.length > 3 ? ', ...' : ''}).`,
      });
    }
  }

  if (e.osvError) {
    add({ id: 'osv_unavailable', severity: 'info', points: 0, message: `Couldn't reach OSV.dev malware database (${e.osvError}).` });
  }

  // --- Verdict -------------------------------------------------------------
  const hard = signals.some((s) => s.severity === 'block');
  const total = Math.min(100, signals.reduce((sum, s) => sum + (s.severity === 'block' ? 100 : s.points), 0));
  let verdict: Verdict = hard || total >= BLOCK_AT ? 'BLOCK' : total >= WARN_AT ? 'WARN' : 'ALLOW';

  const isPopular = e.popular || (e.weeklyDownloads ?? 0) >= POPULAR_WEEKLY;
  if (!hard && isPopular && verdict === 'BLOCK') verdict = 'WARN';

  // Most important first.
  const order = { block: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
  signals.sort((a, b) => order[a.severity] - order[b.severity] || b.points - a.points);
  return { verdict, score: total, signals, facts };
}
