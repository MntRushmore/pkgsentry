import type { EcosystemId } from '../types.js';
import { cargo } from './cargo.js';
import { npm } from './npm.js';
import { pypi } from './pypi.js';
import { rubygems } from './rubygems.js';
import type { Ecosystem } from './types.js';

export type { Ecosystem, EcosystemContext } from './types.js';

/** Register new ecosystems here. */
export const ECOSYSTEMS: Record<EcosystemId, Ecosystem> = { npm, pypi, rubygems, cargo };

const ALIASES: Record<string, EcosystemId> = {
  npm: 'npm',
  node: 'npm',
  js: 'npm',
  pypi: 'pypi',
  pip: 'pypi',
  python: 'pypi',
  py: 'pypi',
  rubygems: 'rubygems',
  gem: 'rubygems',
  gems: 'rubygems',
  ruby: 'rubygems',
  bundler: 'rubygems',
  bundle: 'rubygems',
  cargo: 'cargo',
  crate: 'cargo',
  crates: 'cargo',
  rust: 'cargo',
};

export function resolveEcosystem(input: string): Ecosystem | undefined {
  const id = ALIASES[input.toLowerCase()];
  return id ? ECOSYSTEMS[id] : undefined;
}
