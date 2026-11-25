#!/usr/bin/env python3
"""Renders docs/demo.gif from REAL pkgsentry output.

    npm run build && python3 scripts/demo/make-gif.py

Each scene's command is actually executed (as `node dist/cli.js ...`) and its
output captured, then drawn as a typed-out terminal session. Requires Pillow.
(If you have charmbracelet/vhs, scripts/demo/demo.tape produces a similar GIF.)
"""
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "demo.gif"

W, H = 1100, 620
PAD_X, PAD_Y, LINE_H = 28, 56, 24
FONT_PATHS = ["/System/Library/Fonts/Menlo.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]
FONT = next((ImageFont.truetype(p, 16) for p in FONT_PATHS if os.path.exists(p)), ImageFont.load_default())
BOLD = next((ImageFont.truetype(p, 16, index=1) for p in FONT_PATHS[:1] if os.path.exists(p)), FONT)

BG, FG, DIM = (22, 24, 29), (220, 223, 228), (120, 126, 138)
GREEN, RED, YELLOW, CYAN = (80, 200, 120), (235, 87, 87), (240, 196, 25), (97, 175, 239)
BADGE = {"BLOCK": (RED, (255, 255, 255)), "WARN": (YELLOW, (20, 20, 20)), "ALLOW": (GREEN, (20, 20, 20))}

home = tempfile.mkdtemp(prefix="pkgsentry-demo-")
fake_home = Path(tempfile.mkdtemp(prefix="pkgsentry-demo-user-"))
for d in [".claude", ".cursor", ".codex"]:
    (fake_home / d).mkdir()
(fake_home / "my-app" / ".git").mkdir(parents=True)

SCENES = [
    ("npx pkgsentry check pypi reqeusts", ["check", "pypi", "reqeusts"], {}),
    ("npx pkgsentry check npm lodahs expresss express", ["check", "npm", "lodahs", "expresss", "express"], {}),
    (
        "npx pkgsentry run -- pip install fastapi pyvaisala",
        # Blocked, so pip never runs.
        ["run", "--", "pip", "install", "fastapi", "pyvaisala"],
        {},
    ),
    ("npx pkgsentry setup --dry-run", ["setup", "--dry-run"], {"HOME": str(fake_home), "cwd": str(fake_home / "my-app")}),
]


def run(args, extra):
    env = {**os.environ, "NO_COLOR": "1", "PKGSENTRY_HOME": home, "PKGSENTRY_SETUP_COMMAND": "npx -y pkgsentry@0.1.0"}
    cwd = extra.pop("cwd", None)
    env.update(extra)
    p = subprocess.run(
        ["node", str(ROOT / "dist" / "cli.js"), *args], capture_output=True, text=True, env=env, cwd=cwd
    )
    text = (p.stdout + p.stderr).replace("\r", "")
    return [l.rstrip() for l in text.splitlines() if "\x1b[2K" not in l]


def trim_setup(lines):
    # Keep the demo short: drop the per-line config previews, keep files and summaries.
    return [l for l in lines if not l.startswith("      ") and not l.startswith("Not found")][:20]


def draw_line(d, x, y, line):
    """Draws one line with light syntax colouring for verdict badges, bullets and facts."""
    m = re.match(r"^(\s*)(BLOCK|WARN|ALLOW)(\s+)(\S+)( \([a-z]+\))?(.*)$", line)
    if m:
        indent, verdict, _, name, eco, rest = m.groups()
        x += d.textlength(indent, font=FONT)
        bg, fg = BADGE[verdict]
        label = f" {verdict} "
        wpx = d.textlength(label, font=BOLD)
        d.rectangle([x, y - 2, x + wpx, y + LINE_H - 6], fill=bg)
        d.text((x, y), label, font=BOLD, fill=fg)
        x += wpx + d.textlength("  ", font=FONT)
        d.text((x, y), name, font=BOLD, fill=FG)
        x += d.textlength(name, font=BOLD)
        if eco:
            d.text((x, y), eco, font=FONT, fill=DIM)
            x += d.textlength(eco, font=FONT)
        if rest:
            d.text((x, y), rest, font=FONT, fill=DIM)
        return
    colour = FG
    if line.startswith("Not running"):
        colour = RED
    elif line.lstrip().startswith(("+ ", "- ")) and line.startswith("      "):
        colour = DIM
    elif line.startswith(("Found:", "Not found:", "Dry run", "Fix the package")):
        colour = DIM
    elif line.strip().startswith("~/") or line.strip().startswith(".cursor"):
        colour = CYAN
    elif line in ("Claude Code", "Cursor", "Codex CLI", "pkgsentry setup"):
        d.text((x, y), line, font=BOLD, fill=FG)
        return
    d.text((x, y), line, font=FONT, fill=colour)


def frame(lines, cursor=False):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # window chrome
    d.rectangle([0, 0, W, 36], fill=(34, 37, 43))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([18 + i * 22, 12, 30 + i * 22, 24], fill=c)
    d.text((W / 2 - 40, 10), "pkgsentry", font=FONT, fill=DIM)
    visible = lines[-((H - PAD_Y - 10) // LINE_H):]
    y = PAD_Y
    for l in visible:
        if l.startswith("$ "):
            d.text((PAD_X, y), "$", font=BOLD, fill=GREEN)
            d.text((PAD_X + d.textlength("$ ", font=FONT), y), l[2:], font=FONT, fill=FG)
        else:
            draw_line(d, PAD_X, y, l)
        y += LINE_H
    if cursor:
        last = visible[-1] if visible else ""
        cx = PAD_X + d.textlength(last, font=FONT)
        d.rectangle([cx + 2, y - LINE_H, cx + 11, y - 6], fill=FG)
    return img


def main():
    if not (ROOT / "dist" / "cli.js").exists():
        sys.exit("Run `npm run build` first.")
    # Warm the cache so the recording reflects steady-state speed (and is reproducible).
    for _, args, extra in SCENES:
        run(args, dict(extra))

    frames, durations = [], []

    def add(img, ms):
        frames.append(img)
        durations.append(ms)

    screen = []
    for title, args, extra in SCENES:
        output = run(args, dict(extra))
        if args[0] == "setup":
            output = trim_setup(output)
        screen.append("$ ")
        add(frame(screen, cursor=True), 700)
        for i in range(1, len(title) + 1):
            screen[-1] = "$ " + title[:i]
            add(frame(screen, cursor=True), 45 if title[i - 1] != " " else 70)
        add(frame(screen, cursor=True), 450)
        for l in output:
            screen.append(l)
        add(frame(screen), 4200 if args[0] != "setup" else 5600)
        screen.append("")
    add(frame(screen + ["$ "], cursor=True), 2500)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    # One shared palette so colours don't drift between frames.
    sheet = Image.new("RGB", (W, H * 3))
    for i, f in enumerate([frames[0], frames[len(frames) // 2], frames[-1]]):
        sheet.paste(f, (0, H * i))
    palette = sheet.quantize(colors=64, method=Image.Quantize.MEDIANCUT)
    pal = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
    pal[0].save(OUT, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f"wrote {OUT.relative_to(ROOT)}: {len(frames)} frames, {sum(durations) / 1000:.1f}s, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
