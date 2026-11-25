import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Checker } from '../src/check.js';
import { interactiveSetup, refsFromInput } from '../src/integrations/setup-interactive.js';
import type { Env } from '../src/integrations/setup.js';
import { gradient, stripAnsi, visibleLength, type Term } from '../src/tui.js';
import type { CheckResult, PackageRef } from '../src/types.js';

const DOWN = '\x1b[B';
const ENTER = '\r';
const CTRL_C = '\x03';

function makeEnv(agents: string[]): Env {
  const home = mkdtempSync(path.join(os.tmpdir(), 'pkgsentry-tui-'));
  const cwd = path.join(home, 'project');
  mkdirSync(path.join(cwd, '.git'), { recursive: true });
  if (agents.includes('claude')) mkdirSync(path.join(home, '.claude'));
  if (agents.includes('cursor')) mkdirSync(path.join(home, '.cursor'));
  return { home, cwd, self: { command: 'npx', args: ['-y', 'pkgsentry@0.2.0'] }, onPath: () => false };
}

/** A terminal whose keyboard is `keys`, typed up front. Output is captured as plain text. */
function makeTerm(keys: string) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
  let out = '';
  const output = Object.assign(
    new Writable({
      write(chunk, _e, cb) {
        out += chunk;
        cb();
      },
    }),
    { isTTY: false, columns: 120 },
  );
  input.write(keys);
  const term: Term = { input, output, color: false, motion: false };
  return { term, text: () => stripAnsi(out) };
}

const fakeChecker: Checker = {
  async check(ref: PackageRef): Promise<CheckResult> {
    const bad = ref.name.startsWith('req') || ref.name === 'lodahs';
    return {
      ecosystem: ref.ecosystem,
      name: ref.name,
      verdict: bad ? 'BLOCK' : 'ALLOW',
      score: bad ? 100 : 0,
      signals: bad ? [{ id: 'not_found', severity: 'block', points: 100, message: `Doesn't exist. Did you mean "requests"?` }] : [],
      facts: [],
      ...(bad ? { suggestion: 'requests' } : {}),
      durationMs: 1,
    };
  },
  async checkAll(refs) {
    return Promise.all(refs.map((r) => this.check(r)));
  },
};

const deps = { checker: fakeChecker, random: () => 0 };

describe('interactive setup', () => {
  it('walks through scan, select, confirm, apply and the game', async () => {
    const env = makeEnv(['claude', 'cursor']);
    const { term, text } = makeTerm(`${ENTER}y` + `pypi reqeusts${ENTER}` + `express${ENTER}` + ENTER);
    expect(await interactiveSetup(env, term, deps)).toBe(0);

    const out = text();
    expect(out).toContain('Claude Code  found');
    expect(out).toContain('Windsurf     not installed');
    expect(out).toContain('Which agents should pkgsentry protect? Claude Code, Cursor');
    expect(out).toContain('~/.claude/settings.json');
    expect(out).toContain('Apply these changes? yes');
    expect(out).toContain('[BLOCK]  reqeusts');
    expect(out).toContain('Nice try. (1 blocked)');
    expect(out).toContain("[ALLOW]  express");
    expect(out).toContain("You're protected in Claude Code, Cursor.");
    expect(out).toContain('Blocked 1 bad package and let 1 real one through.');

    const settings = JSON.parse(readFileSync(path.join(env.home, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('npx -y pkgsentry@0.2.0 hook claude-code');
    expect(existsSync(path.join(env.home, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(path.join(env.cwd, '.cursor', 'rules', 'pkgsentry.mdc'))).toBe(true);
  });

  it('only installs the agents left ticked', async () => {
    const env = makeEnv(['claude', 'cursor']);
    const { term } = makeTerm(` ${ENTER}y${ENTER}`); // untick Claude Code
    await interactiveSetup(env, term, deps);
    expect(existsSync(path.join(env.home, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(path.join(env.home, '.cursor', 'mcp.json'))).toBe(true);
  });

  it('can move the cursor and toggle', async () => {
    const env = makeEnv(['claude', 'cursor']);
    const { term } = makeTerm(`${DOWN} ${ENTER}y${ENTER}`); // untick Cursor
    await interactiveSetup(env, term, deps);
    expect(existsSync(path.join(env.home, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(path.join(env.home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('writes nothing when you say no', async () => {
    const env = makeEnv(['claude']);
    const { term, text } = makeTerm(`${ENTER}n${ENTER}`);
    expect(await interactiveSetup(env, term, deps)).toBe(0);
    expect(text()).toContain('No changes made.');
    expect(existsSync(path.join(env.home, '.claude', 'settings.json'))).toBe(false);
  });

  it('notices agents that are already protected', async () => {
    const env = makeEnv(['claude']);
    await interactiveSetup(env, makeTerm(`${ENTER}y${ENTER}`).term, deps);
    const again = makeTerm(ENTER);
    await interactiveSetup(env, again.term, deps);
    expect(again.text()).toContain('Claude Code  already protected');
    expect(again.text()).toContain('Everything you have is already protected.');
  });

  it('still offers the game when no agents are installed', async () => {
    const env = makeEnv([]);
    const { term, text } = makeTerm(`npm i lodahs${ENTER}${ENTER}`);
    expect(await interactiveSetup(env, term, deps)).toBe(0);
    expect(text()).toContain('No supported agents found');
    expect(text()).toContain('[BLOCK]  lodahs');
  });

  it('Ctrl-C cancels cleanly without writing', async () => {
    const env = makeEnv(['claude']);
    const { term, text } = makeTerm(CTRL_C);
    expect(await interactiveSetup(env, term, deps)).toBe(130);
    expect(text()).toContain('Cancelled');
    expect(existsSync(path.join(env.home, '.claude', 'settings.json'))).toBe(false);
  });
});

describe('refsFromInput', () => {
  it.each([
    ['pip install reqeusts', ['pypi:reqeusts']],
    ['npm i lodahs express', ['npm:lodahs', 'npm:express']],
    ['pypi reqeusts', ['pypi:reqeusts']],
    ['npm left-pad', ['npm:left-pad']],
    ['Flask', ['npm:flask', 'pypi:Flask']],
  ])('%s', (input, expected) => {
    expect(refsFromInput(input).map((r) => `${r.ecosystem}:${r.name}`)).toEqual(expected);
  });
});

describe('tui helpers', () => {
  it('gradient keeps the visible text intact', () => {
    const g = gradient('pkgsentry', true);
    expect(g).not.toBe('pkgsentry');
    expect(stripAnsi(g)).toBe('pkgsentry');
    expect(visibleLength(g)).toBe(9);
    expect(gradient('pkgsentry', false)).toBe('pkgsentry');
  });
});
