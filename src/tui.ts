import { emitKeypressEvents } from 'node:readline';

/**
 * A tiny, dependency-free terminal UI kit: raw-mode keys, re-renderable blocks,
 * spinners, a multi-select, a confirm prompt and a line editor.
 *
 * It only emits a small set of escape codes (CR, cursor up, erase-below,
 * cursor show/hide, SGR colours) so it behaves on every modern terminal.
 */

export interface TermInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}
export interface TermOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
}

export interface Term {
  input: TermInput;
  output: TermOutput;
  /** Emit colours. */
  color: boolean;
  /** Animate (spinners, typewriter, pauses). Off for CI, NO_MOTION, tests. */
  motion: boolean;
}

export function defaultTerm(): Term {
  const env = process.env;
  return {
    input: process.stdin,
    output: process.stdout,
    color: !env.NO_COLOR && (Boolean(env.FORCE_COLOR) || process.stdout.isTTY === true),
    motion: !env.CI && !env.PKGSENTRY_NO_MOTION && !env.NO_MOTION,
  };
}

// --- styling -----------------------------------------------------------------

export function styles(color: boolean) {
  const w = (open: string, close: string) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  const fg = (n: number) => w(`38;5;${n}`, '39');
  return {
    bold: w('1', '22'),
    dim: w('2', '22'),
    italic: w('3', '23'),
    red: fg(203),
    green: fg(78),
    yellow: fg(221),
    cyan: fg(80),
    blue: fg(75),
    magenta: fg(177),
    gray: fg(245),
    fg,
    /** White-on-colour pill, e.g. verdict badges. */
    pill: (s: string, bg: number, fgc = 16) => (color ? `\x1b[48;5;${bg};38;5;${fgc};1m ${s} \x1b[0m` : `[${s}]`),
  };
}
export type Styles = ReturnType<typeof styles>;

/** Cyan -> blue -> violet. 256-colour indices so it works without truecolor. */
export const GRADIENT = [51, 45, 39, 33, 63, 99, 135, 171];

/** Colours each character along the gradient, optionally shifted (for a shimmer). */
export function gradient(text: string, color: boolean, shift = 0, palette = GRADIENT): string {
  if (!color) return text;
  const chars = [...text];
  const visible = chars.filter((c) => c !== ' ').length || 1;
  let i = 0;
  return (
    chars
      .map((ch) => {
        if (ch === ' ') return ch;
        const idx = Math.floor(((i++ + shift) / visible) * palette.length) % palette.length;
        return `\x1b[38;5;${palette[(idx + palette.length) % palette.length]}m${ch}`;
      })
      .join('') + '\x1b[39m'
  );
}

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
export const visibleLength = (s: string) => [...stripAnsi(s)].length;

/** Pads a string with ANSI codes to a visible width. */
export const padEnd = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - visibleLength(s)));

function fit(line: string, columns: number): string {
  if (visibleLength(line) < columns) return line;
  return [...stripAnsi(line)].slice(0, Math.max(1, columns - 2)).join('') + '…';
}

// --- output primitives ---------------------------------------------------------

export function write(term: Term, s: string) {
  term.output.write(s);
}

export function hideCursor(term: Term) {
  if (term.output.isTTY) write(term, '\x1b[?25l');
}
export function showCursor(term: Term) {
  if (term.output.isTTY) write(term, '\x1b[?25h');
}

export function sleep(term: Term, ms: number): Promise<void> {
  return term.motion && ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** A region of lines that can be redrawn in place. */
export class Block {
  private height = 0;
  constructor(private readonly term: Term) {}

  render(lines: string[]) {
    const cols = this.term.output.columns || 100;
    const up = this.height ? `\x1b[${this.height}A` : '';
    write(this.term, `${up}\r\x1b[J${lines.map((l) => fit(l, cols)).join('\n')}\n`);
    this.height = lines.length;
  }

  /** Stop tracking: the next render starts below the current content. */
  commit() {
    this.height = 0;
  }
}

/** Types text out character by character. */
export async function typewriter(term: Term, prefix: string, text: string, style: (s: string) => string = (s) => s, cps = 55) {
  if (!term.motion) return void write(term, `${prefix}${style(text)}\n`);
  for (let i = 1; i <= text.length; i++) {
    write(term, `\r${prefix}${style(text.slice(0, i))}`);
    await sleep(term, 1000 / cps);
  }
  write(term, '\n');
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Shows `label` with a spinner until `task` settles (and at least `minMs`, so
 * it reads as deliberate rather than flickering), then the line `done` returns.
 */
export async function spin<T>(term: Term, label: string, task: Promise<T>, done: (v: T) => string, minMs = 0): Promise<T> {
  const s = styles(term.color);
  const block = new Block(term);
  let frame = 0;
  let settled = false;
  const timer = term.motion
    ? setInterval(() => !settled && block.render([`  ${s.cyan(SPIN[frame++ % SPIN.length]!)} ${label}`]), 80)
    : undefined;
  if (term.motion) block.render([`  ${s.cyan(SPIN[0]!)} ${label}`]);
  try {
    const [v] = await Promise.all([task, sleep(term, minMs)]);
    settled = true;
    block.render([done(v)]);
    return v;
  } finally {
    settled = true;
    if (timer) clearInterval(timer);
  }
}

// --- input ---------------------------------------------------------------------

export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/** Async key reader over a raw-mode input stream. */
export class Keys {
  private queue: Array<{ str?: string; key: Key }> = [];
  private waiting?: (k: { str?: string; key: Key }) => void;
  private readonly onKey = (str: string | undefined, key: Key | undefined) => {
    const item = { str, key: key ?? { sequence: str } };
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w(item);
    } else this.queue.push(item);
  };

  constructor(private readonly term: Term) {
    emitKeypressEvents(term.input);
    term.input.setRawMode?.(true);
    term.input.on('keypress', this.onKey);
    term.input.resume();
  }

  async next(): Promise<{ str?: string; key: Key }> {
    const item = this.queue.shift() ?? (await new Promise<{ str?: string; key: Key }>((r) => (this.waiting = r)));
    if (item.key.ctrl && (item.key.name === 'c' || item.key.name === 'd')) throw new Cancelled();
    return item;
  }

  close() {
    this.term.input.off('keypress', this.onKey);
    this.term.input.setRawMode?.(false);
    this.term.input.pause();
  }
}

export interface Choice {
  label: string;
  detail?: string;
  checked: boolean;
  /** Shown dimmed; still selectable. */
  muted?: boolean;
}

/** ↑↓ to move, space to toggle, a to toggle all, enter to confirm. */
export async function multiselect(term: Term, keys: Keys, title: string, choices: Choice[]): Promise<boolean[]> {
  const s = styles(term.color);
  const state = choices.map((c) => c.checked);
  let cursor = Math.max(0, choices.findIndex((c) => !c.muted));
  const width = Math.max(...choices.map((c) => c.label.length)) + 3;
  const block = new Block(term);
  const draw = (final = false) => {
    if (final) {
      const picked = choices.filter((_, i) => state[i]).map((c) => c.label);
      block.render([`  ${s.green('✔')} ${s.bold(title)} ${s.cyan(picked.length ? picked.join(', ') : 'none')}`]);
      return;
    }
    const lines = [`  ${s.cyan('?')} ${s.bold(title)}  ${s.gray('↑↓ move · space toggle · enter confirm')}`];
    choices.forEach((c, i) => {
      const here = i === cursor;
      const box = state[i] ? s.green('◉') : s.gray('◯');
      const label = here ? s.bold(c.label) : c.muted ? s.gray(c.label) : c.label;
      const detail = c.detail ? (c.muted ? s.gray(c.detail) : s.gray(c.detail)) : '';
      lines.push(`  ${here ? s.cyan('❯') : ' '} ${box} ${padEnd(label, width)}${detail}`);
    });
    block.render(lines);
  };
  draw();
  for (;;) {
    const { str, key } = await keys.next();
    if (key.name === 'up' || key.name === 'k') cursor = (cursor - 1 + choices.length) % choices.length;
    else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') cursor = (cursor + 1) % choices.length;
    else if (key.name === 'space' || str === ' ') state[cursor] = !state[cursor];
    else if (str === 'a') {
      const all = state.every(Boolean);
      state.fill(!all);
    } else if (key.name === 'return' || key.name === 'enter') {
      draw(true);
      return state;
    } else if (key.name === 'escape') throw new Cancelled();
    draw();
  }
}

export async function confirm(term: Term, keys: Keys, question: string, initial = true): Promise<boolean> {
  const s = styles(term.color);
  const block = new Block(term);
  const hint = initial ? 'Y/n' : 'y/N';
  block.render([`  ${s.cyan('?')} ${s.bold(question)} ${s.gray(`(${hint})`)}`]);
  for (;;) {
    const { str, key } = await keys.next();
    let answer: boolean | undefined;
    if (str === 'y' || str === 'Y') answer = true;
    else if (str === 'n' || str === 'N' || key.name === 'escape') answer = false;
    else if (key.name === 'return' || key.name === 'enter') answer = initial;
    if (answer !== undefined) {
      block.render([`  ${answer ? s.green('✔') : s.red('✖')} ${s.bold(question)} ${s.cyan(answer ? 'yes' : 'no')}`]);
      return answer;
    }
  }
}

/** Single-line editor with a dim placeholder. Enter submits. */
export async function textInput(term: Term, keys: Keys, prompt: string, placeholder = ''): Promise<string> {
  const s = styles(term.color);
  const block = new Block(term);
  let value = '';
  const draw = (cursor: boolean) =>
    block.render([`  ${s.magenta('›')} ${prompt}${value}${value || !cursor ? '' : s.gray(placeholder)}${cursor && term.color ? '\x1b[7m \x1b[27m' : ''}`]);
  draw(true);
  for (;;) {
    const { str, key } = await keys.next();
    if (key.name === 'return' || key.name === 'enter') {
      draw(false);
      return value.trim();
    }
    if (key.name === 'backspace') value = value.slice(0, -1);
    else if (key.ctrl && key.name === 'u') value = '';
    else if (key.name === 'escape') {
      value = '';
      draw(false);
      return '';
    } else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') value += str;
    draw(true);
  }
}
