import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long to trust a metadata lookup. A missing package or a missing pinned version
 * may be published any minute (registries take a few minutes to propagate a release),
 * so those are re-checked soon instead of blocking for a day.
 */
export function metaTtl(m: { exists: boolean; versionExists?: boolean }): number {
  if (!m.exists) return DAY_MS / 24;
  if (m.versionExists === false) return 10 * 60 * 1000;
  return DAY_MS;
}

/** Root directory for pkgsentry state. Override with PKGSENTRY_HOME. */
export function homeDir(): string {
  return process.env.PKGSENTRY_HOME || path.join(os.homedir(), '.pkgsentry');
}

export function cacheDir(): string {
  return path.join(homeDir(), 'cache');
}

interface Entry<T> {
  t: number;
  ttl: number;
  v: T;
}

function fileFor(key: string): string {
  const h = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return path.join(cacheDir(), h.slice(0, 2), `${h}.json`);
}

/**
 * Tiny JSON file cache. One file per key, so concurrent pkgsentry processes
 * (an agent can fire several installs at once) never corrupt a shared index.
 */
export class Cache {
  constructor(private readonly enabled = true, private readonly now: () => number = Date.now) {}

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.enabled) return undefined;
    try {
      const entry = JSON.parse(await readFile(fileFor(key), 'utf8')) as Entry<T>;
      if (this.now() - entry.t > entry.ttl) return undefined;
      return entry.v;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs = DAY_MS): Promise<void> {
    if (!this.enabled) return;
    const file = fileFor(key);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify({ t: this.now(), ttl: ttlMs, v: value }));
      await rename(tmp, file);
    } catch {
      // A read-only home directory should never break a check.
    }
  }

  /** Returns the cached value, or computes, stores and returns it. */
  async wrap<T>(key: string, ttlMs: number | ((v: T) => number), fn: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== undefined) return hit;
    const v = await fn();
    await this.set(key, v, typeof ttlMs === 'function' ? ttlMs(v) : ttlMs);
    return v;
  }
}

export async function clearCache(): Promise<void> {
  await rm(cacheDir(), { recursive: true, force: true });
}
