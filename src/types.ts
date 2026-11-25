/** Ecosystems pkgsentry knows how to check. Add new ids here (e.g. 'cargo', 'go'). */
export type EcosystemId = 'npm' | 'pypi';

export type Verdict = 'ALLOW' | 'WARN' | 'BLOCK';

export interface PackageRef {
  ecosystem: EcosystemId;
  name: string;
  /** Exact version or range as the user wrote it, if any. */
  version?: string;
}

/** Normalized registry metadata. Every ecosystem adapter returns this shape. */
export interface PackageMeta {
  exists: boolean;
  /** Canonical name as reported by the registry. */
  name: string;
  /** ISO timestamp of the first ever publish. */
  createdAt?: string;
  latestVersion?: string;
  /** Only set when an exact version was requested. */
  versionExists?: boolean;
  repositoryUrl?: string;
  /** npm lifecycle scripts that run on install, e.g. { postinstall: "node build.js" }. */
  installScripts?: Record<string, string>;
  deprecated?: string;
  /** npm replaced the package with a "security holding" placeholder (it was malware). */
  securityHolding?: boolean;
  description?: string;
}

export type Severity = 'block' | 'high' | 'medium' | 'low' | 'info';

export interface Signal {
  /** Stable machine id, e.g. "not_found", "typosquat", "new_package". */
  id: string;
  severity: Severity;
  /** Contribution to the risk score. Hard-block signals use Infinity semantics via severity "block". */
  points: number;
  /** Short, human friendly explanation. */
  message: string;
}

export interface CheckResult {
  ecosystem: EcosystemId;
  name: string;
  version?: string;
  verdict: Verdict;
  score: number;
  signals: Signal[];
  /** Short facts for display, e.g. "first published 2011", "45M downloads/week". */
  facts: string[];
  /** Set when a .pkgsentry.json allow/block rule decided the verdict. */
  rule?: string;
  /** Closest popular package name if the name looks like a typo. */
  suggestion?: string;
  durationMs: number;
}

export interface CheckOptions {
  /** Skip the on-disk cache. */
  noCache?: boolean;
  /** Directory to start searching for .pkgsentry.json from. Defaults to process.cwd(). */
  cwd?: string;
  /** Skip the OSV.dev malicious-package lookup (used for benchmark ablations). */
  noOsv?: boolean;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Injected fetch, for tests. */
  fetch?: typeof fetch;
  /** Fixed "now" for tests. */
  now?: Date;
}
