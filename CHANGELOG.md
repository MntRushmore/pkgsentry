# Changelog

## 0.2.0

- **Interactive `pkgsentry setup`.** Animated banner, agent scan, arrow-key picker, a clear list of every file it will touch, and a "try to sneak a package past me" game that uses the real checker. Falls back to the plain flow with `--yes`, `--dry-run`, `--plain`, a named agent, CI, or piped output.
- Verdict lines no longer nest dim text inside bold, which some terminals rendered as bold.
- Piping output into a command that exits early (`| head`) no longer crashes with EPIPE.
- Showcase video (`docs/showcase.mp4`) and README GIF are rendered from real recorded sessions (`scripts/demo/record.py`, `scripts/demo/render.py`).

## 0.1.0

- First release: `check`, `run`, Claude Code hook, MCP server, `setup`/`uninstall` for Claude Code, Cursor, Windsurf and Codex CLI, 24h cache, `.pkgsentry.json`, benchmark.
