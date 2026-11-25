import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homeDir } from './cache.js';
import type { EcosystemId } from './types.js';

export const CONFIG_FILE = '.pkgsentry.json';

/**
 * .pkgsentry.json
 *
 * {
 *   "allow": ["internal-utils", "npm:@acme/*", "pypi:our-private-lib"],
 *   "block": ["npm:event-stream"]
 * }
 *
 * Entries without an "npm:" / "pypi:" prefix apply to every ecosystem.
 * A trailing "*" matches any suffix (handy for scopes).
 */
export interface Config {
  allow: string[];
  block: string[];
  /** Files the rules were loaded from, for display. */
  sources: string[];
}

interface RawConfig {
  allow?: unknown;
  block?: unknown;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function readConfig(file: string): RawConfig | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RawConfig;
  } catch {
    return undefined;
  }
}

/** Finds the nearest .pkgsentry.json walking up from `cwd`, plus the global ~/.pkgsentry/config.json. */
export function loadConfig(cwd = process.cwd()): Config {
  const config: Config = { allow: [], block: [], sources: [] };
  const add = (file: string) => {
    const raw = readConfig(file);
    if (!raw) return;
    config.allow.push(...strings(raw.allow));
    config.block.push(...strings(raw.block));
    config.sources.push(file);
  };

  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, CONFIG_FILE);
    if (existsSync(file)) {
      add(file);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const global = path.join(homeDir(), 'config.json');
  if (existsSync(global)) add(global);
  return config;
}

function matches(rule: string, ecosystem: EcosystemId, name: string, normalize: (s: string) => string): boolean {
  let pattern = rule.trim();
  const prefix = pattern.match(/^(npm|pypi):(.+)$/i);
  if (prefix) {
    if (prefix[1]!.toLowerCase() !== ecosystem) return false;
    pattern = prefix[2]!;
  }
  if (pattern.endsWith('*')) return normalize(name).startsWith(normalize(pattern.slice(0, -1)));
  return normalize(pattern) === normalize(name);
}

export function findRule(
  config: Config,
  ecosystem: EcosystemId,
  name: string,
  normalize: (s: string) => string,
): { kind: 'allow' | 'block'; rule: string } | undefined {
  const block = config.block.find((r) => matches(r, ecosystem, name, normalize));
  if (block) return { kind: 'block', rule: block };
  const allow = config.allow.find((r) => matches(r, ecosystem, name, normalize));
  if (allow) return { kind: 'allow', rule: allow };
  return undefined;
}
