// Programmatic API. The CLI lives in cli.ts.
export { createChecker, checkPackage, worstVerdict, type Checker } from './check.js';
export { parseInstallCommand, parseNpmSpec, parsePySpec, type ParseResult, type ParsedPackage, type SkippedSpec } from './parse.js';
export { ECOSYSTEMS, resolveEcosystem, type Ecosystem } from './ecosystems/index.js';
export { findTypoTarget, editDistance } from './typo.js';
export { score, BLOCK_AT, WARN_AT, POINTS } from './score.js';
export { loadConfig, CONFIG_FILE } from './config.js';
export { handleMcpMessage, startMcpServer, TOOLS as MCP_TOOLS } from './mcp.js';
export { runClaudeHook } from './integrations/claude-code.js';
export { VERSION } from './version.js';
export type * from './types.js';
