import { createChecker, type Checker } from '../check.js';
import { resolveEcosystem } from '../ecosystems/index.js';
import { parseInstallCommand } from '../parse.js';
import type { CheckResult, PackageRef, Verdict } from '../types.js';
import {
  Block,
  Cancelled,
  confirm,
  gradient,
  hideCursor,
  Keys,
  multiselect,
  showCursor,
  sleep,
  spin,
  styles,
  textInput,
  typewriter,
  write,
  type Styles,
  type Term,
} from '../tui.js';
import { VERSION } from '../version.js';
import { AGENTS, applyEdit, tilde, type AgentDef, type Env, type FileEdit } from './setup.js';

/**
 * The fun `pkgsentry setup`:
 *
 *   1. animated banner
 *   2. scans for agents (spinner per agent; notices ones already protected)
 *   3. pick which to protect (arrow keys + space)
 *   4. shows exactly what will change, asks, writes with backups
 *   5. "Try to sneak a package past me": a little game against the real checker
 *
 * Falls back to the plain flow for --yes, --dry-run, non-TTY and CI.
 */

const LOGO = [
  '  ▟▀▀▀▀▀▀▀▙',
  '  █   ✔   █',
  '  ▜▖     ▗▛',
  '   ▀▙▄▄▄▟▀ ',
];

const HOW: Record<string, string> = {
  'claude-code': 'hard block · PreToolUse hook',
  cursor: 'MCP tool + project rule',
  windsurf: 'MCP tool + global rule',
  codex: 'MCP tool + AGENTS.md rule',
};

const CAUGHT = ['Nice try.', 'Not today.', 'Caught it.', 'Nope.', 'Blocked before it ran.', "That's a no from me."];
const ALLOWED = ["That one's legit.", 'Real package. Go ahead.', 'All clear.'];
const WARNED = ["Suspicious. You'd be asked first.", 'Hmm. Flagged for a human.'];

export interface InteractiveDeps {
  checker?: Checker;
  /** Deterministic banter for tests and recordings. */
  random?: () => number;
}

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}

async function banner(term: Term, s: Styles) {
  write(term, '\n');
  const block = new Block(term);
  const word = 'pkgsentry';
  const frames = term.motion ? 14 : 1;
  for (let f = 0; f < frames; f++) {
    const shift = frames === 1 ? 0 : f - frames;
    const lines = LOGO.map((l, i) => {
      const art = gradient(l, term.color, shift + i * 2);
      if (i === 1) return `${art}   ${s.bold(gradient(word, term.color, shift))}  ${s.gray('v' + VERSION)}`;
      return art;
    });
    block.render(lines);
    await sleep(term, 45);
  }
  block.commit();
  // Type the tagline into the line under the wordmark by drawing it below the logo.
  await typewriter(term, '  ', "The bouncer for your AI agent's npm and pip installs.", s.gray);
  write(term, '\n');
}

function step(term: Term, s: Styles, n: number, total: number, title: string) {
  write(term, `  ${s.gray(`${n}/${total}`)} ${s.bold(gradient(title, term.color))}\n`);
}

interface Found {
  agent: AgentDef;
  detected: boolean;
  edits: FileEdit[];
  notes: string[];
  error?: string;
}

async function scan(term: Term, s: Styles, env: Env): Promise<Found[]> {
  const found: Found[] = [];
  for (const agent of AGENTS) {
    const f = await spin(
      term,
      `Looking for ${agent.name}…`,
      (async (): Promise<Found> => {
        const detected = agent.detect(env);
        if (!detected) return { agent, detected, edits: [], notes: [] };
        try {
          const plan = await agent.install(env);
          return { agent, detected, edits: plan.edits.filter((e) => e.before !== e.after), notes: plan.notes };
        } catch (e) {
          return { agent, detected, edits: [], notes: [], error: e instanceof Error ? e.message : String(e) };
        }
      })(),
      (f) => {
        const name = f.agent.name.padEnd(12);
        if (!f.detected) return `  ${s.gray('·')} ${s.gray(name)} ${s.gray('not installed')}`;
        if (f.error) return `  ${s.yellow('!')} ${name} ${s.yellow("can't edit its config")} ${s.gray(f.error)}`;
        if (!f.edits.length) return `  ${s.green('✔')} ${name} ${s.green('already protected')}`;
        return `  ${s.cyan('●')} ${name} ${s.cyan('found')}`;
      },
      260,
    );
    found.push(f);
  }
  return found;
}

function verdictPill(s: Styles, v: Verdict) {
  return v === 'BLOCK' ? s.pill('BLOCK', 203, 231) : v === 'WARN' ? s.pill('WARN ', 221) : s.pill('ALLOW', 78);
}

function renderResult(s: Styles, r: CheckResult): string[] {
  const facts = r.facts.length ? `  ${s.gray(r.facts.join(' · '))}` : '';
  const lines = [`    ${verdictPill(s, r.verdict)}  ${s.bold(r.name)}${r.version ? s.gray('@' + r.version) : ''} ${s.gray(`(${r.ecosystem})`)}${facts}`];
  for (const sig of r.signals.filter((x) => x.severity !== 'info').slice(0, 3)) lines.push(`      ${s.gray('–')} ${sig.message}`);
  return lines;
}

/** Turns what the user typed into packages: an install command, "npm foo", or a bare name (checked on both). */
export function refsFromInput(input: string): PackageRef[] {
  const parsed = parseInstallCommand(input);
  if (parsed.packages.length) return parsed.packages;
  const words = input.split(/\s+/).filter(Boolean);
  const eco = words.length > 1 ? resolveEcosystem(words[0]!) : undefined;
  if (eco) return words.slice(1).map((name) => ({ ecosystem: eco.id, name }));
  return words.flatMap((name) => [
    { ecosystem: 'npm' as const, name: name.toLowerCase() },
    { ecosystem: 'pypi' as const, name },
  ]);
}

async function game(term: Term, s: Styles, keys: Keys, checker: Checker, rnd: () => number) {
  write(term, `  ${s.gray("Try to sneak something past me. Type a package name or a whole install command.")}\n`);
  write(term, `  ${s.gray('Ideas: ')}${s.cyan('reqeusts')}${s.gray(', ')}${s.cyan('npm i lodahs')}${s.gray(', ')}${s.cyan('pip install huggingface-cli')}${s.gray(', ')}${s.cyan('express')}\n\n`);
  const tally: Record<Verdict, number> = { BLOCK: 0, WARN: 0, ALLOW: 0 };
  for (;;) {
    const input = await textInput(term, keys, '', 'package or command · enter to finish');
    if (!input) break;
    const refs = refsFromInput(input);
    if (!refs.length) {
      write(term, `    ${s.gray("That doesn't look like a package. Try again.")}\n`);
      continue;
    }
    const results = await spin(term, s.gray('Checking registries, OSV.dev and lookalikes…'), checker.checkAll(refs), () => '', 350);
    // spin() leaves an empty line where the spinner was; move up over it.
    if (term.output.isTTY) write(term, '\x1b[1A\r\x1b[J');
    // A bare name is checked on both registries. If it's real on one, only show that one.
    const bareName = refs.length === 2 && refs[0]!.name.toLowerCase() === refs[1]!.name.toLowerCase() && !input.includes(' ');
    const shown = !bareName
      ? results
      : results.some((r) => r.verdict !== 'BLOCK')
        ? results.filter((r) => r.verdict !== 'BLOCK')
        : [results.find((r) => r.suggestion) ?? results[0]!];
    for (const r of shown) write(term, renderResult(s, r).join('\n') + '\n');
    const worst = shown.some((r) => r.verdict === 'BLOCK') ? 'BLOCK' : shown.some((r) => r.verdict === 'WARN') ? 'WARN' : 'ALLOW';
    tally[worst]++;
    const quip =
      worst === 'BLOCK'
        ? `${s.red(pick(CAUGHT, rnd))} ${s.gray(`(${tally.BLOCK} blocked)`)}`
        : worst === 'WARN'
          ? s.yellow(pick(WARNED, rnd))
          : s.green(pick(ALLOWED, rnd));
    write(term, `    ${quip}\n\n`);
  }
  return tally;
}

async function sparkle(term: Term, s: Styles, text: string) {
  const block = new Block(term);
  const glyphs = ['✦', '✧', '·', '✶'];
  const frames = term.motion ? 10 : 1;
  for (let f = 0; f < frames; f++) {
    const left = [0, 1, 2].map((i) => s.fg([221, 177, 80][(i + f) % 3]!)(glyphs[(i + f) % glyphs.length]!)).join(' ');
    const right = [0, 1, 2].map((i) => s.fg([80, 177, 221][(i + f) % 3]!)(glyphs[(i + f + 2) % glyphs.length]!)).join(' ');
    block.render([`  ${left}  ${s.bold(text)}  ${right}`]);
    await sleep(term, 90);
  }
}

export async function interactiveSetup(env: Env, term: Term, deps: InteractiveDeps = {}): Promise<number> {
  const s = styles(term.color);
  const rnd = deps.random ?? Math.random;
  let keys: Keys | undefined;
  const restore = () => {
    keys?.close();
    showCursor(term);
  };
  const onExit = () => showCursor(term);
  process.once('exit', onExit);
  hideCursor(term);

  try {
    await banner(term, s);

    step(term, s, 1, 3, 'Finding your AI agents');
    const found = await scan(term, s, env);
    write(term, '\n');

    keys = new Keys(term);
    const installable = found.filter((f) => f.detected && !f.error && f.edits.length);
    const protectedAlready = found.filter((f) => f.detected && !f.error && !f.edits.length);
    let applied: Found[] = [];

    step(term, s, 2, 3, 'Protect them');
    if (!installable.length) {
      write(
        term,
        protectedAlready.length
          ? `  ${s.green('✔')} Everything you have is already protected.\n\n`
          : `  ${s.gray('No supported agents found. You can still guard any install with')} ${s.cyan('npx pkgsentry run -- <command>')}\n\n`,
      );
    } else {
      const picks = await multiselect(
        term,
        keys,
        'Which agents should pkgsentry protect?',
        installable.map((f) => ({ label: f.agent.name, detail: HOW[f.agent.id], checked: true })),
      );
      const chosen = installable.filter((_, i) => picks[i]);
      if (chosen.length) {
        write(term, `\n  ${s.gray("Here's exactly what changes:")}\n`);
        for (const f of chosen) {
          for (const e of f.edits) {
            const tag = e.before === undefined ? s.green('new  ') : s.yellow('edit ');
            const what = e.summary.startsWith('rule') ? 'rule: check packages before installing' : e.summary.replace(/: .*/, '');
            write(term, `    ${tag} ${s.cyan(tilde(env, e.path).padEnd(32))} ${s.gray(what)}\n`);
          }
        }
        write(term, `  ${s.gray('Originals are backed up next to each file as *.pkgsentry.bak')}\n\n`);
        if (await confirm(term, keys, 'Apply these changes?', true)) {
          for (const f of chosen) {
            for (const e of f.edits) {
              await spin(term, `Writing ${tilde(env, e.path)}`, applyEdit(e), () => `  ${s.green('✔')} ${tilde(env, e.path)}`, 220);
            }
          }
          applied = chosen;
        } else {
          write(term, `  ${s.gray('No changes made.')}\n`);
        }
      }
      write(term, '\n');
    }

    step(term, s, 3, 3, 'Take it for a spin');
    const checker = deps.checker ?? createChecker({ cwd: env.cwd });
    const score = await game(term, s, keys, checker, rnd);

    const protectedNow = [...protectedAlready, ...applied].map((f) => f.agent.name);
    write(term, '\n');
    if (protectedNow.length) {
      await sparkle(term, s, `You're protected in ${protectedNow.join(', ')}.`);
    } else {
      write(term, `  ${s.bold('All set.')}\n`);
    }
    const parts = [
      score.BLOCK && `blocked ${score.BLOCK} bad package${score.BLOCK === 1 ? '' : 's'}`,
      score.WARN && `flagged ${score.WARN} for review`,
      score.ALLOW && `let ${score.ALLOW} real one${score.ALLOW === 1 ? '' : 's'} through`,
    ].filter(Boolean) as string[];
    if (parts.length) {
      const sentence = parts.join(', ').replace(/, ([^,]*)$/, parts.length > 1 ? ' and $1' : ', $1');
      write(term, `  ${s.gray(sentence[0]!.toUpperCase() + sentence.slice(1) + '.')}\n`);
    }
    for (const n of applied.flatMap((f) => f.notes)) write(term, `  ${s.gray('· ' + n)}\n`);
    write(term, `  ${s.gray('Guard any one-off install:')} ${s.cyan('npx pkgsentry run -- npm install <pkg>')}\n`);
    write(term, `  ${s.gray('Undo any time:')} ${s.cyan('npx pkgsentry uninstall')}\n\n`);
    return 0;
  } catch (e) {
    if (e instanceof Cancelled) {
      write(term, `\n  ${s.gray('Cancelled. Nothing else was changed.')}\n`);
      return 130;
    }
    throw e;
  } finally {
    restore();
    process.off('exit', onExit);
  }
}
