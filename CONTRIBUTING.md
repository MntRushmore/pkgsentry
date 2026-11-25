# Contributing to pkgsentry

Thanks for helping keep AI agents from installing things they shouldn't.

## Setup

```bash
git clone https://github.com/MntRushmore/pkgsentry && cd pkgsentry
npm install
npm test            # vitest, fully offline (registries are faked)
npm run build       # tsc -> dist/
node dist/cli.js check pypi reqeusts
```

Node 20+. There are **zero runtime dependencies** and we'd like to keep it that way: a supply-chain tool shouldn't bring its own supply chain. Dev dependencies are fine.

## Layout

```
src/
  cli.ts                 command line entry (check, run, setup, uninstall, mcp, hook)
  check.ts               orchestrates one check: allowlist -> registry -> OSV -> typo -> score
  score.ts               turns evidence into signals, a score, and ALLOW / WARN / BLOCK
  typo.ts                typosquat detection (edit distance, separators, scopes, homoglyphs)
  parse.ts               finds packages inside install commands
  ecosystems/            one adapter per registry (npm.ts, pypi.ts)
  sources/               OSV.dev and repository checks
  integrations/          Claude Code hook, setup/uninstall for each agent
  mcp.ts                 stdio MCP server
data/top-*.json          bundled top-5000 lists (npm run refresh-top)
bench/                   benchmark dataset + runner
```

## Adding an ecosystem (cargo, go, rubygems, ...)

This is the most valuable kind of contribution. Use `src/ecosystems/pypi.ts` as the template.

1. **Add the id.** Extend `EcosystemId` in `src/types.ts` (e.g. `'npm' | 'pypi' | 'cargo'`).
2. **Write the adapter** in `src/ecosystems/<id>.ts` implementing `Ecosystem` from `src/ecosystems/types.ts`:
   - `normalize(name)`: canonical form for comparisons (crates.io treats `-` and `_` as the same, for example).
   - `validateName(name)`: return an error string for names that can never exist.
   - `isExactVersion(v)`: so pinned versions get OSV version-specific lookups.
   - `fetchMeta(name, version, ctx, { popular })`: return `PackageMeta`. Use `ctx.http` and wrap in `ctx.cache.wrap(...)`. Return `{ exists: false, name }` on 404, throw `RegistryError` on other failures.
   - `fetchWeeklyDownloads(name, ctx)`: weekly downloads, `0` if the registry has no record, `undefined` if unknown.
   - `osvEcosystem`: the OSV name ([list](https://ossf.github.io/osv-schema/#affectedpackage-field)), e.g. `crates.io`, `Go`.
   - `hasInstallScriptSignal`: `true` if installs can run code (cargo `build.rs` counts).
3. **Register it** in `src/ecosystems/index.ts`, including CLI aliases.
4. **Top list.** Add a source to `scripts/refresh-top.mjs` that writes `data/top-<id>.json`, then run `npm run refresh-top`.
5. **Install commands.** Teach `src/parse.ts` the ecosystem's commands (`cargo add`, `cargo install`, `go get`, `go install`). Add cases to `test/parse.test.ts`.
6. **Tests.** Add fake-registry tests to `test/check.test.ts` like the npm and PyPI ones. No real network in unit tests.
7. **Benchmark.** Add a few dozen names per category to the benchmark if you can.

Registry API pointers:

| Ecosystem | Metadata | Downloads |
|---|---|---|
| crates.io | `https://crates.io/api/v1/crates/<name>` (set a descriptive User-Agent, it's required) | `recent_downloads` in the same response (90 days) |
| Go | `https://proxy.golang.org/<module>/@v/list` and `/@latest` | none public; fall back to `pkg.go.dev` importers or skip the signal |
| RubyGems | `https://rubygems.org/api/v1/gems/<name>.json` | `downloads` / `version_downloads` |

## Changing scoring

Scoring lives in `src/score.ts` and is intentionally simple: points per signal, thresholds at 25 (WARN) and 70 (BLOCK). If you change weights:

- update `test/score.test.ts`,
- run `npm run bench` and include the before/after table in your PR. A change that improves recall but raises the false-positive rate on good packages needs a strong argument.

## Pull requests

- `npm run typecheck && npm test` must pass.
- Keep terminal output short and friendly. Every signal message should make sense to someone who has never heard of typosquatting.
- One logical change per PR.

## Reporting a false positive or a miss

Open an issue with the exact command or package name, the output of `pkgsentry check <eco> <name> --json`, and what you expected. Misses on real malware are the most useful reports we get.

## Security

If you find a way to make pkgsentry ALLOW something it shouldn't (a parser bypass, for example), please report it privately via GitHub Security Advisories on this repo rather than a public issue.
