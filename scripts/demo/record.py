#!/usr/bin/env python3
"""Records REAL pkgsentry sessions in a pseudo-terminal as asciicast v2 files.

    npm run build && python3 scripts/demo/record.py

Each scene runs `node dist/cli.js ...` in a pty with scripted keypresses (an
"expect" script), against a throwaway HOME, so your real agent configs are never
touched. Output: docs/casts/<scene>.cast (replay with `asciinema play`).
"""
import fcntl
import json
import os
import pty
import re
import select
import struct
import sys
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASTS = ROOT / "docs" / "casts"
COLS, ROWS = 96, 30
ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")


class Session:
    def __init__(self, argv, env, cwd):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.t0 = time.monotonic()
        self.events = []
        self.buf = b""
        self.plain = b""
        self.done = False

    def _pump(self, timeout):
        r, _, _ = select.select([self.fd], [], [], timeout)
        if not r:
            return
        try:
            data = os.read(self.fd, 65536)
        except OSError:
            data = b""
        if not data:
            self.done = True
            return
        self.events.append([round(time.monotonic() - self.t0, 4), "o", data.decode("utf8", "replace")])
        self.buf += data
        self.plain += ANSI.sub(b"", data)

    def idle(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end and not self.done:
            self._pump(min(0.02, end - time.monotonic()))

    def expect(self, pattern, timeout=30):
        """Waits until `pattern` appears in output produced after the previous expect."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            idx = self.plain.find(pattern.encode())
            if idx != -1:
                self.plain = self.plain[idx + len(pattern):]
                return
            if self.done:
                break
            self._pump(0.02)
        tail = self.plain[-600:].decode("utf8", "replace")
        raise TimeoutError(f"never saw {pattern!r}. Last output:\n{tail}")

    def send(self, data, gap=0.0):
        for ch in data if gap else [data]:
            os.write(self.fd, ch.encode())
            self.idle(gap)

    def type(self, text, cps=14):
        self.send(text, gap=1 / cps)

    def wait_exit(self, timeout=20):
        end = time.monotonic() + timeout
        while not self.done and time.monotonic() < end:
            self._pump(0.05)
        os.waitpid(self.pid, 0)

    def save(self, name, title):
        CASTS.mkdir(parents=True, exist_ok=True)
        path = CASTS / f"{name}.cast"
        with open(path, "w") as f:
            f.write(json.dumps({"version": 2, "width": COLS, "height": ROWS, "title": title, "env": {"TERM": "xterm-256color"}}) + "\n")
            for e in self.events:
                f.write(json.dumps(e) + "\n")
        print(f"wrote {path.relative_to(ROOT)} ({self.events[-1][0]:.1f}s)")
        return path


UP, DOWN, ENTER = "\x1b[A", "\x1b[B", "\r"


def make_env():
    home = Path(tempfile.mkdtemp(prefix="pkgsentry-rec-home-"))
    for d in [".claude", ".cursor", ".codex"]:
        (home / d).mkdir()
    project = home / "my-app"
    (project / ".git").mkdir(parents=True)
    state = tempfile.mkdtemp(prefix="pkgsentry-rec-state-")
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "LANG": "en_US.UTF-8",
        "PKGSENTRY_HOME": state,
        "PKGSENTRY_SETUP_COMMAND": "npx -y pkgsentry",
        "PS1": "$ ",
    }
    return env, project


CLI = ["node", str(ROOT / "dist" / "cli.js")]


def warm(env, cwd):
    # Fill the cache first so the recording shows steady-state speed.
    import subprocess

    for args in (["check", "pypi", "reqeusts", "huggingface-cli", "fastapi", "pyvaisala"], ["check", "npm", "reqeusts", "lodahs", "express", "expresss"]):
        subprocess.run(CLI + args, env={**env, "NO_COLOR": "1"}, cwd=cwd, capture_output=True)


def scene_setup(env, cwd):
    s = Session(CLI + ["setup"], env, cwd)
    s.expect("Which agents should pkgsentry protect?")
    s.idle(1.6)
    s.send(DOWN); s.idle(0.45)
    s.send(DOWN); s.idle(0.45)
    s.send(" "); s.idle(0.7)   # untick Codex...
    s.send(" "); s.idle(0.6)   # ...changed my mind
    s.send(UP); s.idle(0.35)
    s.send(UP); s.idle(0.6)
    s.send(ENTER)
    s.expect("Apply these changes?")
    s.idle(2.2)
    s.send("y")
    s.expect("package or command")
    s.idle(1.4)
    for attempt in ["reqeusts", "npm i lodahs", "pip install huggingface-cli", "express"]:
        s.type(attempt)
        s.idle(0.4)
        s.send(ENTER)
        s.expect("enter to finish")  # the next prompt
        s.idle(2.3)
    s.send(ENTER)
    s.wait_exit()
    s.idle(0.8)
    return s


def scene_run(env, cwd):
    s = Session(["/bin/sh"], {**env, "PS1": "$ "}, cwd)
    s.expect("$ ")
    s.idle(0.6)
    s.type("npx pkgsentry run -- pip install fastapi pyvaisala", cps=22)
    s.idle(0.3)
    s.send(ENTER)
    s.expect("Not running")
    s.idle(3.0)
    s.send("exit\r")
    s.wait_exit()
    return s


def main():
    if not (ROOT / "dist" / "cli.js").exists():
        sys.exit("Run `npm run build` first.")
    env, cwd = make_env()
    # `npx pkgsentry` inside the shell scene should run this checkout's build.
    bindir = Path(tempfile.mkdtemp(prefix="pkgsentry-rec-bin-"))
    (bindir / "npx").write_text(f'#!/bin/sh\nshift\nexec node "{ROOT / "dist" / "cli.js"}" "$@"\n')
    (bindir / "npx").chmod(0o755)
    env["PATH"] = f"{bindir}:{env['PATH']}"
    warm(env, cwd)
    scene_setup(env, cwd).save("setup", "npx pkgsentry setup")
    scene_run(env, cwd).save("run", "npx pkgsentry run")


if __name__ == "__main__":
    main()
