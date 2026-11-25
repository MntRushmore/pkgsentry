# Good first issues

Ready to file once the GitHub repo exists (`gh issue create` with the title and body below, label `good first issue`). Each one is self-contained. See CONTRIBUTING.md for the walkthrough.

## Add crates.io (Rust) support
Implement `src/ecosystems/cargo.ts`. Metadata: `https://crates.io/api/v1/crates/<name>` (requires a User-Agent). Downloads: `recent_downloads`. OSV ecosystem: `crates.io`. Commands: `cargo add <crate>`, `cargo install <crate>`. Top list: crates.io `/api/v1/crates?sort=downloads`. Note crates.io treats `-` and `_` as equivalent.

## Add Go modules support
Implement `src/ecosystems/go.ts`. Existence: `https://proxy.golang.org/<module>/@latest` (module paths must be case-encoded: uppercase letters become `!` + lowercase). There's no public downloads API, so skip that signal. OSV ecosystem: `Go`. Commands: `go get`, `go install pkg@version`. Typosquats in Go look like `github.com/<lookalike-org>/<repo>`, so compare org names against a list of popular orgs.

## Add RubyGems support
`https://rubygems.org/api/v1/gems/<name>.json`. OSV ecosystem: `RubyGems`. Commands: `gem install`, `bundle add`.

## Parse `npm install` with no arguments
Today `npm install` (installing from package.json) is skipped. Diff package.json dependencies against the lockfile and check only new names.

## Check `deno add npm:` and `jsr:` specs
`parse.ts` skips `jsr:` today. Add a JSR adapter (`https://jsr.io/@scope/name/meta.json`) and handle `deno add`/`deno install`.

## Cursor hooks (beforeShellExecution)
Cursor supports hooks that can deny shell commands. Add a `pkgsentry hook cursor` target and wire it into `pkgsentry setup` alongside the MCP server for hard enforcement like Claude Code gets.

## Private registry support
Read `.npmrc` / `pip.conf` / `PIP_INDEX_URL` and check packages against the configured registry, so internal packages don't need allowlisting.

## Homoglyph table for Unicode lookalikes
`typo.ts` handles ASCII lookalikes (l/1, 0/o, rn/m). npm forbids non-ASCII names but PyPI normalizes some. Investigate whether confusable Unicode can reach either registry and add tests.
