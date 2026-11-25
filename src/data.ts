import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tests, via vitest) and dist/ (published package).
const dataDir = path.join(here, '..', 'data');

const lists = new Map<string, readonly string[]>();

export function loadTopList(ecosystem: string): readonly string[] {
  let list = lists.get(ecosystem);
  if (!list) {
    try {
      const raw = JSON.parse(readFileSync(path.join(dataDir, `top-${ecosystem}.json`), 'utf8'));
      list = raw.packages as string[];
    } catch {
      list = [];
    }
    lists.set(ecosystem, list);
  }
  return list;
}
