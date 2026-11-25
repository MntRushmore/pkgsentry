import { Cache } from './cache.js';
import { findRule, loadConfig, type Config } from './config.js';
import { ECOSYSTEMS, type Ecosystem, type EcosystemContext } from './ecosystems/index.js';
import { Http } from './http.js';
import { score, type Evidence } from './score.js';
import { queryOsv } from './sources/osv.js';
import { checkRepo } from './sources/repo.js';
import { findTypoTarget, suggest } from './typo.js';
import type { CheckOptions, CheckResult, PackageRef } from './types.js';

const topSets = new Map<string, ReadonlySet<string>>();
function topSet(eco: Ecosystem): ReadonlySet<string> {
  let s = topSets.get(eco.id);
  if (!s) topSets.set(eco.id, (s = new Set(eco.topPackages())));
  return s;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timed out';
    return e.message.replace(/^fetch failed$/, 'network error');
  }
  return String(e);
}

export interface Checker {
  check(ref: PackageRef): Promise<CheckResult>;
  checkAll(refs: PackageRef[]): Promise<CheckResult[]>;
}

/** Creates a checker that shares one config, cache, and HTTP client across many checks. */
export function createChecker(opts: CheckOptions = {}): Checker {
  const config: Config = loadConfig(opts.cwd);
  const ctx: EcosystemContext = {
    http: new Http(opts.fetch, opts.timeoutMs ?? 8000),
    cache: new Cache(!opts.noCache && !process.env.PKGSENTRY_NO_CACHE),
  };

  async function check(ref: PackageRef): Promise<CheckResult> {
    const started = performance.now();
    const eco = ECOSYSTEMS[ref.ecosystem];
    const name = ref.ecosystem === 'npm' ? ref.name : ref.name.trim();
    const base = { ecosystem: ref.ecosystem, name, ...(ref.version ? { version: ref.version } : {}) };
    const done = (r: Omit<CheckResult, 'durationMs' | keyof typeof base>): CheckResult => ({
      ...base,
      ...r,
      durationMs: Math.round(performance.now() - started),
    });

    const rule = findRule(config, ref.ecosystem, name, eco.normalize);
    if (rule) {
      return done({
        verdict: rule.kind === 'allow' ? 'ALLOW' : 'BLOCK',
        score: rule.kind === 'allow' ? 0 : 100,
        signals: [
          {
            id: rule.kind === 'allow' ? 'allowlisted' : 'blocklisted',
            severity: rule.kind === 'allow' ? 'info' : 'block',
            points: rule.kind === 'allow' ? 0 : 100,
            message: `${rule.kind === 'allow' ? 'Allowed' : 'Blocked'} by "${rule.rule}" in ${CONFIG_LABEL}.`,
          },
        ],
        facts: [],
        rule: rule.rule,
      });
    }

    const invalid = eco.validateName(name);
    if (invalid) {
      return done({
        verdict: 'BLOCK',
        score: 100,
        signals: [{ id: 'invalid_name', severity: 'block', points: 100, message: invalid }],
        facts: [],
      });
    }

    const normalized = eco.normalize(name);
    const top = topSet(eco);
    const popular = top.has(normalized);
    const exact = ref.version && eco.isExactVersion(ref.version) ? ref.version.replace(/^v/, '') : undefined;

    const [metaR, downloadsR, osvR] = await Promise.allSettled([
      eco.fetchMeta(name, ref.version, ctx, { popular }),
      popular ? Promise.resolve(undefined) : eco.fetchWeeklyDownloads(name, ctx),
      opts.noOsv ? Promise.resolve(undefined) : queryOsv(eco.osvEcosystem, name, exact, ctx, { popular }),
    ]);

    const evidence: Evidence = {
      displayEcosystem: eco.displayName,
      popular,
      requestedVersion: ref.version,
      exactVersion: Boolean(exact),
      installScriptsApply: eco.hasInstallScriptSignal,
      now: opts.now ?? new Date(),
    };
    if (metaR.status === 'fulfilled') evidence.meta = metaR.value;
    else evidence.lookupError = errMsg(metaR.reason);
    if (downloadsR.status === 'fulfilled') evidence.weeklyDownloads = downloadsR.value;
    if (osvR.status === 'fulfilled') evidence.osv = osvR.value;
    else evidence.osvError = errMsg(osvR.reason);

    const meta = evidence.meta;
    if (meta && !meta.exists) {
      evidence.suggestion = suggest(normalized, eco.topPackages());
    } else if (meta?.exists && !popular) {
      evidence.typo = findTypoTarget(normalized, eco.topPackages(), top);
      if (meta.repositoryUrl) evidence.repo = await checkRepo(meta.repositoryUrl, ctx);
    }

    const result = score(evidence);
    return done({
      ...result,
      ...(evidence.typo ? { suggestion: evidence.typo.target } : evidence.suggestion ? { suggestion: evidence.suggestion } : {}),
    });
  }

  async function checkAll(refs: PackageRef[]): Promise<CheckResult[]> {
    const results: CheckResult[] = new Array(refs.length);
    let next = 0;
    const worker = async () => {
      while (next < refs.length) {
        const i = next++;
        results[i] = await check(refs[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, refs.length) }, worker));
    return results;
  }

  return { check, checkAll };
}

const CONFIG_LABEL = '.pkgsentry.json';

/** One-shot convenience wrapper. */
export function checkPackage(ref: PackageRef, opts?: CheckOptions): Promise<CheckResult> {
  return createChecker(opts).check(ref);
}

export function worstVerdict(results: CheckResult[]): 'ALLOW' | 'WARN' | 'BLOCK' {
  if (results.some((r) => r.verdict === 'BLOCK')) return 'BLOCK';
  if (results.some((r) => r.verdict === 'WARN')) return 'WARN';
  return 'ALLOW';
}
