import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Route = { status: number; body?: unknown };
export type Routes = Record<string, Route | ((init?: RequestInit) => Route)>;

/**
 * A fetch stand-in that serves canned responses by URL. URLs not listed
 * return 404. Every requested URL is recorded in `calls`.
 */
export function fakeFetch(routes: Routes) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const r = routes[url];
    const route = typeof r === 'function' ? r(init) : r ?? { status: 404, body: { error: 'not found' } };
    const text = route.body === undefined ? '' : JSON.stringify(route.body);
    return new Response(init?.method === 'HEAD' ? null : text, { status: route.status });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

export function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pkgsentry-test-'));
  process.env.PKGSENTRY_HOME = dir;
  return dir;
}

export const OSV_EMPTY: Route = { status: 200, body: { results: [{}] } };

export const daysAgo = (n: number, now = new Date('2026-11-25T00:00:00Z')) =>
  new Date(now.getTime() - n * 86_400_000).toISOString();
