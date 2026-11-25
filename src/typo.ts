/**
 * Typosquat detection: is `name` suspiciously close to a popular package?
 *
 * Checks, in order:
 *   - separator confusion   cross-env vs crossenv, python-dateutil vs python_dateutil
 *   - scope confusion       @types/node vs types-node, @babel/core vs babelcore
 *   - edit distance         Damerau-Levenshtein (adjacent swaps count as 1 edit)
 *                           <= 1 for names of 4-7 chars, <= 2 for 8+ chars
 *   - homoglyphs            l/1/I, 0/o, rn/m
 */

export interface TypoMatch {
  /** The popular package this name resembles. */
  target: string;
  /** Rank of the target in the top list (0 = most popular). */
  rank: number;
  distance: number;
  kind: 'separator' | 'scope' | 'homoglyph' | 'edit';
}

/** Optimal string alignment distance with an early exit once `max` is exceeded. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[n]!;
}

const stripSeparators = (s: string) => s.replace(/[-_.@/]/g, '');
const homoglyphs = (s: string) => s.replace(/rn/g, 'm').replace(/[1lI|]/g, 'l').replace(/0/g, 'o').replace(/vv/g, 'w');

export function maxDistanceFor(name: string): number {
  const len = stripSeparators(name).length;
  if (len < 4) return 0;
  if (len < 8) return 1;
  return 2;
}

/**
 * Finds the most popular package `name` could be a typo of.
 * `top` must be normalized and ranked most-popular first.
 * Returns undefined if `name` itself is in the list.
 */
export function findTypoTarget(name: string, top: readonly string[], topSet?: ReadonlySet<string>): TypoMatch | undefined {
  const set = topSet ?? new Set(top);
  if (set.has(name)) return undefined;

  const bare = stripSeparators(name);
  const glyph = homoglyphs(name);
  const maxDist = maxDistanceFor(name);
  let best: TypoMatch | undefined;

  for (let rank = 0; rank < top.length; rank++) {
    const target = top[rank]!;
    let match: TypoMatch | undefined;

    if (bare.length >= 3 && stripSeparators(target) === bare) {
      match = { target, rank, distance: 1, kind: target.startsWith('@') ? 'scope' : 'separator' };
    } else if (glyph !== name && homoglyphs(target) === glyph) {
      match = { target, rank, distance: 1, kind: 'homoglyph' };
    } else if (maxDist > 0) {
      const d = editDistance(name, target, maxDist);
      // Short targets (<= 4 chars) only match on a single edit to avoid noise like "ms" vs "mz".
      const allowed = Math.min(maxDist, maxDistanceFor(target));
      if (d > 0 && d <= allowed) match = { target, rank, distance: d, kind: 'edit' };
    }

    if (match && (!best || match.distance < best.distance)) {
      best = match;
      if (match.distance === 1 && match.kind !== 'edit') break;
    }
  }
  return best;
}

/** Closest popular name for "did you mean" hints, with a looser threshold. */
export function suggest(name: string, top: readonly string[]): string | undefined {
  const hit = findTypoTarget(name, top);
  if (hit) return hit.target;
  // Looser: one more edit, only against the top 1000, only for longer names.
  if (stripSeparators(name).length < 6) return undefined;
  const max = maxDistanceFor(name) + 1;
  let best: { t: string; d: number } | undefined;
  for (const t of top.slice(0, 1000)) {
    const d = editDistance(name, t, max);
    if (d <= max && (!best || d < best.d)) best = { t, d };
  }
  return best?.t;
}
