#!/usr/bin/env python3
"""Renders the recorded casts (docs/casts/*.cast) into a showcase video + GIF.

    python3 scripts/demo/record.py && python3 scripts/demo/render.py

Outputs:
    docs/showcase.mp4   1920x1080 H.264, for X / social
    docs/demo.gif       960px wide, for the README

Contains a small VT100 emulator (just what pkgsentry and a shell emit) so the
video shows exactly what the terminal showed. Needs Pillow, fontTools, ffmpeg.
"""
import json
import math
import subprocess
import sys
from pathlib import Path

from fontTools.ttLib import TTCollection, TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
CASTS = ROOT / "docs" / "casts"
W, H, FPS = 1920, 1080, 30
FONT_SIZE = 20
MENLO = "/System/Library/Fonts/Menlo.ttc"
FALLBACK = "/System/Library/Fonts/Apple Symbols.ttf"

# --- fonts ---------------------------------------------------------------------
FONTS = {k: ImageFont.truetype(MENLO, FONT_SIZE, index=i) for k, i in [("r", 0), ("b", 1), ("i", 2), ("bi", 3)]}
FB = ImageFont.truetype(FALLBACK, FONT_SIZE)
MENLO_CMAP = set(TTCollection(MENLO).fonts[0].getBestCmap().keys())
CW = round(FONTS["r"].getlength("M"))
CH = round(FONT_SIZE * 1.32)


def font_for(ch, bold, italic):
    if ord(ch) not in MENLO_CMAP:
        return FB
    return FONTS[("b" if bold else "") + ("i" if italic else "") or "r"]


# --- colours -------------------------------------------------------------------
BG = (17, 19, 24)
FG = (222, 226, 232)
BASIC = [(40, 42, 54), (235, 87, 87), (80, 200, 120), (240, 196, 25), (97, 175, 239), (198, 120, 221), (86, 182, 194), (220, 223, 228)]
BRIGHT = [(110, 116, 130), (255, 110, 110), (110, 230, 150), (255, 215, 80), (130, 195, 255), (220, 150, 240), (110, 210, 220), (255, 255, 255)]


def xterm256(n):
    if n < 8:
        return BASIC[n]
    if n < 16:
        return BRIGHT[n - 8]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    v = 8 + (n - 232) * 10
    return (v, v, v)


# --- emulator --------------------------------------------------------------------
class Screen:
    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.x = self.y = 0
        self.cursor_visible = True
        self.reset_attr()
        self.cells = [[self.blank() for _ in range(cols)] for _ in range(rows)]
        self.pending = ""

    def reset_attr(self):
        self.fg, self.bg, self.bold, self.dim, self.italic, self.inverse = None, None, False, False, False, False

    def blank(self):
        return (" ", None, None, False, False, False, False)

    def scroll(self):
        self.cells.pop(0)
        self.cells.append([self.blank() for _ in range(self.cols)])
        self.y = self.rows - 1

    def newline(self):
        self.y += 1
        if self.y >= self.rows:
            self.scroll()

    def put(self, ch):
        if self.x >= self.cols:
            self.x = 0
            self.newline()
        self.cells[self.y][self.x] = (ch, self.fg, self.bg, self.bold, self.dim, self.italic, self.inverse)
        self.x += 1

    def erase(self, y, x0, x1):
        for x in range(max(0, x0), min(self.cols, x1)):
            self.cells[y][x] = self.blank()

    def sgr(self, params):
        ps = [int(p) if p else 0 for p in params.split(";")] if params else [0]
        i = 0
        while i < len(ps):
            p = ps[i]
            if p == 0:
                self.reset_attr()
            elif p == 1:
                self.bold = True
            elif p == 2:
                self.dim = True
            elif p == 3:
                self.italic = True
            elif p == 7:
                self.inverse = True
            elif p == 22:
                self.bold = self.dim = False
            elif p == 23:
                self.italic = False
            elif p == 27:
                self.inverse = False
            elif 30 <= p <= 37:
                self.fg = BASIC[p - 30]
            elif 90 <= p <= 97:
                self.fg = BRIGHT[p - 90]
            elif 40 <= p <= 47:
                self.bg = BASIC[p - 40]
            elif p == 39:
                self.fg = None
            elif p == 49:
                self.bg = None
            elif p in (38, 48) and i + 1 < len(ps):
                if ps[i + 1] == 5 and i + 2 < len(ps):
                    c = xterm256(ps[i + 2])
                    i += 2
                elif ps[i + 1] == 2 and i + 4 < len(ps):
                    c = tuple(ps[i + 2 : i + 5])
                    i += 4
                else:
                    c = None
                if p == 38:
                    self.fg = c
                else:
                    self.bg = c
            i += 1

    def feed(self, data):
        data = self.pending + data
        self.pending = ""
        i = 0
        n = len(data)
        while i < n:
            ch = data[i]
            if ch == "\x1b":
                if i + 1 >= n:
                    self.pending = data[i:]
                    return
                if data[i + 1] == "[":
                    j = i + 2
                    while j < n and not ("@" <= data[j] <= "~"):
                        j += 1
                    if j >= n:
                        self.pending = data[i:]
                        return
                    self.csi(data[i + 2 : j], data[j])
                    i = j + 1
                    continue
                i += 2
                continue
            if ch == "\r":
                self.x = 0
            elif ch == "\n":
                self.newline()
            elif ch == "\b":
                self.x = max(0, self.x - 1)
            elif ch == "\t":
                self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)
            elif ch >= " ":
                self.put(ch)
            i += 1

    def csi(self, params, final):
        private = params.startswith("?")
        p = params.lstrip("?")
        num = lambda d=1: int(p.split(";")[0]) if p and p.split(";")[0] else d
        if final == "m":
            self.sgr(p)
        elif final == "A":
            self.y = max(0, self.y - num())
        elif final == "B":
            self.y = min(self.rows - 1, self.y + num())
        elif final == "C":
            self.x = min(self.cols - 1, self.x + num())
        elif final == "D":
            self.x = max(0, self.x - num())
        elif final == "G":
            self.x = max(0, num() - 1)
        elif final == "H":
            parts = (p.split(";") + ["1", "1"])[:2]
            self.y = max(0, int(parts[0] or 1) - 1)
            self.x = max(0, int(parts[1] or 1) - 1)
        elif final == "J":
            mode = num(0)
            if mode == 0:
                self.erase(self.y, self.x, self.cols)
                for y in range(self.y + 1, self.rows):
                    self.erase(y, 0, self.cols)
            elif mode == 2:
                for y in range(self.rows):
                    self.erase(y, 0, self.cols)
        elif final == "K":
            mode = num(0)
            if mode == 0:
                self.erase(self.y, self.x, self.cols)
            elif mode == 1:
                self.erase(self.y, 0, self.x + 1)
            else:
                self.erase(self.y, 0, self.cols)
        elif private and final in "hl" and p == "25":
            self.cursor_visible = final == "h"


# --- drawing ---------------------------------------------------------------------
def background():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=(int(14 + 10 * t), int(16 + 6 * t), int(30 + 22 * t)))
    # soft colour blobs
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse([-200, -300, 900, 600], fill=(20, 60, 110))
    g.ellipse([1200, 500, 2300, 1400], fill=(70, 30, 110))
    glow = glow.filter(ImageFilter.GaussianBlur(180))
    return Image.blend(img, Image.composite(glow, img, Image.new("L", (W, H), 255)), 0.55)


BG_IMG = background()


CAPTION_SPACE = 110


def geometry(cols, rows):
    tw, th = cols * CW + 56, rows * CH + 40 + 56
    x0 = (W - tw) // 2
    y0 = max(24, (H - CAPTION_SPACE - th) // 2)
    return x0, y0, tw, th


def window_frame(cols, rows, title):
    x0, y0, tw, th = geometry(cols, rows)
    base = BG_IMG.copy()
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([x0, y0 + 18, x0 + tw, y0 + th + 18], 18, fill=150)
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    base.paste((0, 0, 0), (0, 0), shadow)
    d = ImageDraw.Draw(base)
    d.rounded_rectangle([x0, y0, x0 + tw, y0 + th], 16, fill=BG, outline=(48, 52, 62), width=1)
    d.rounded_rectangle([x0, y0, x0 + tw, y0 + 44], 16, fill=(30, 33, 41))
    d.rectangle([x0, y0 + 28, x0 + tw, y0 + 44], fill=(30, 33, 41))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([x0 + 20 + i * 24, y0 + 16, x0 + 34 + i * 24, y0 + 30], fill=c)
    tf = FONTS["r"]
    d.text((x0 + tw / 2 - tf.getlength(title) / 2, y0 + 11), title, font=tf, fill=(140, 146, 160))
    return base, (x0 + 28, y0 + 44 + 24)


def draw_screen(screen, frame_img, origin, show_cursor, rows):
    img = frame_img.copy()
    d = ImageDraw.Draw(img)
    ox, oy = origin
    for y, row in enumerate(screen.cells[:rows]):
        for x, (ch, fg, bg, bold, dim, italic, inv) in enumerate(row):
            fgc, bgc = fg or FG, bg
            if inv:
                fgc, bgc = (bg or BG), (fg or FG)
            if dim:
                fgc = tuple(int(c * 0.55 + BG[i] * 0.45) for i, c in enumerate(fgc))
            px, py = ox + x * CW, oy + y * CH
            if bgc:
                d.rectangle([px, py - 3, px + CW, py + CH - 4], fill=bgc)
            if ch != " ":
                d.text((px, py), ch, font=font_for(ch, bold, italic), fill=fgc)
    if show_cursor and screen.cursor_visible:
        px, py = ox + screen.x * CW, oy + screen.y * CH
        d.rectangle([px, py - 2, px + CW - 1, py + CH - 5], fill=(200, 205, 215))
    return img


# --- cards -----------------------------------------------------------------------
def card(lines, alpha=1.0):
    img = BG_IMG.copy()
    d = ImageDraw.Draw(img)
    total = sum(sz * 1.45 for _, sz, _ in lines)
    y = (H - total) / 2
    for text, size, style in lines:
        f = ImageFont.truetype(MENLO, size, index=1 if style in ("bold", "accent") else 0)
        col = {"bold": (240, 242, 246), "dim": (150, 158, 175), "accent": (110, 200, 255), "red": (255, 110, 110)}[style]
        col = tuple(int(c * alpha + BG_IMG.getpixel((W // 2, int(y)))[i] * (1 - alpha)) for i, c in enumerate(col))
        d.text((W / 2 - f.getlength(text) / 2, y), text, font=f, fill=col)
        y += size * 1.45
    return img


def card_frames(lines, seconds):
    n = int(seconds * FPS)
    for i in range(n):
        fade = min(1.0, i / (0.35 * FPS), (n - i) / (0.3 * FPS))
        yield card(lines, max(0.0, fade))


# --- casts -----------------------------------------------------------------------
def load_cast(name):
    lines = (CASTS / f"{name}.cast").read_text().splitlines()
    header = json.loads(lines[0])
    events = [json.loads(l) for l in lines[1:]]
    # Compress long pauses so the video keeps moving.
    t_prev, shift = 0.0, 0.0
    for e in events:
        gap = e[0] - t_prev
        if gap > 2.6:
            shift += gap - 2.6
        t_prev = e[0]
        e[0] -= shift
    return header, events


def cast_frames(name, title, tail=1.2, show_cursor=True, rows=None):
    header, events = load_cast(name)
    screen = Screen(header["width"], header["height"])
    rows = rows or header["height"]
    frame, origin = window_frame(header["width"], rows, title)
    duration = events[-1][0] + tail
    i, last = 0, None
    for f in range(int(duration * FPS)):
        t = f / FPS
        changed = False
        while i < len(events) and events[i][0] <= t:
            screen.feed(events[i][2])
            i += 1
            changed = True
        blink = show_cursor and (int(t * 2) % 2 == 0)
        if changed or last is None or show_cursor:
            last = draw_screen(screen, frame, origin, blink, rows)
        yield last


def caption(img, text):
    """Lower-third caption under the terminal window."""
    img = img.copy()
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(MENLO, 30, index=1)
    w = f.getlength(text)
    d.rounded_rectangle([W / 2 - w / 2 - 26, H - 78, W / 2 + w / 2 + 26, H - 24], 14, fill=(12, 14, 20))
    d.text((W / 2 - w / 2, H - 70), text, font=f, fill=(235, 238, 245))
    return img


def captioned(frames, cues):
    """cues: list of (start_seconds, text)."""
    for n, img in enumerate(frames):
        t = n / FPS
        text = None
        for start, txt in cues:
            if t >= start:
                text = txt
        yield caption(img, text) if text else img


def main():
    out_mp4 = ROOT / "docs" / "showcase.mp4"
    out_gif = ROOT / "docs" / "demo.gif"
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_mp4)],
        stdin=subprocess.PIPE,
    )
    count = 0

    def emit(frames):
        nonlocal count
        for img in frames:
            ff.stdin.write(img.tobytes())
            count += 1

    emit(card_frames([
        ("AI coding agents install packages for you.", 52, "bold"),
        ("", 30, "dim"),
        ("We asked Claude for packages for niche tasks.", 36, "dim"),
        ("46% of the names it suggested don't exist.", 44, "red"),
        ("Anyone can register them.", 36, "dim"),
    ], 4.6))
    emit(card_frames([("pkgsentry", 96, "accent"), ("checks every install before it runs.", 40, "bold")], 2.4))
    emit(captioned(cast_frames("setup", "npx pkgsentry setup", show_cursor=False), [
        (0.0, "One command. It finds your agents."),
        (4.3, "Pick which to protect."),
        (9.8, "See exactly what changes. Backups included."),
        (13.6, "Then try to sneak something past it."),
    ]))
    emit(captioned(cast_frames("run", "terminal", tail=1.5, rows=11), [(0.0, "Or guard any install yourself.")]))
    emit(card_frames([
        ("npx pkgsentry setup", 72, "accent"),
        ("", 24, "dim"),
        ("Claude Code · Cursor · Windsurf · Codex", 34, "bold"),
        ("free · open source · zero dependencies", 30, "dim"),
        ("github.com/MntRushmore/pkgsentry", 30, "dim"),
    ], 4.5))
    ff.stdin.close()
    if ff.wait() != 0:
        sys.exit("ffmpeg failed")
    print(f"wrote {out_mp4.relative_to(ROOT)}: {count / FPS:.1f}s, {out_mp4.stat().st_size // 1024} KB")

    # README GIF: crop to the terminal window, smaller and at a lower frame rate.
    cols, rows = json.loads((CASTS / "setup.cast").read_text().splitlines()[0])["width"], json.loads((CASTS / "setup.cast").read_text().splitlines()[0])["height"]
    x0, y0, tw, th = geometry(cols, rows)
    pad = 24
    crop = f"crop={tw + 2 * pad}:{th + 2 * pad + CAPTION_SPACE}:{x0 - pad}:{max(0, y0 - pad)}"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", "7.0", "-i", str(out_mp4),
         "-vf", f"fps=12,{crop},scale=900:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
         str(out_gif)],
        check=True,
    )
    print(f"wrote {out_gif.relative_to(ROOT)}: {out_gif.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
