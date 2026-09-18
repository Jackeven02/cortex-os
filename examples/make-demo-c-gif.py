#!/usr/bin/env python3
"""
Render Demo C (fork and compare) as an animated GIF: ``docs/demo-c.gif``.

Needs Pillow and a monospace TTF. In the offline build sandbox Pillow cannot be
installed and there is no browser for Playwright, so this script is the path to
the *real* GIF; for an immediately viewable, dependency-free replay use
``make-demo-c-html.py`` (produces ``docs/demo-c.html``).

Usage:
    python examples/make-demo-c-gif.py
Reads:
    examples/demo-c.capture.log
Writes:
    docs/demo-c.gif
"""
from __future__ import annotations

import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - the offline sandbox hits this
    sys.stderr.write(
        "Pillow is not installed. Run:  pip install pillow\n"
        "Then re-run this script to produce docs/demo-c.gif.\n"
        "For a dependency-free animated replay, use make-demo-c-html.py.\n"
    )
    raise SystemExit(2)


HERE = os.path.dirname(os.path.abspath(__file__))
CAPTURE = os.path.join(HERE, "demo-c.capture.log")
OUT = os.path.join(HERE, os.pardir, "docs", "demo-c.gif")

BG = (11, 14, 20)
PAD = 18
LINE_H = 22
CHAR_W_FALLBACK = 9.0

COLORS = {
    "role": (139, 233, 253),
    "ansA": (126, 231, 135),
    "ansB": (255, 166, 87),
    "minus": (255, 123, 114),
    "plus": (63, 185, 80),
    "diff": (241, 250, 140),
    "sys": (189, 147, 249),
    "banner": (255, 121, 198),
    "exit": (126, 231, 135),
    "muted": (107, 114, 128),
    "out": (230, 230, 230),
}


def load_font() -> ImageFont.ImageFont:
    for path in (
        "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/cour.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ):
        if os.path.exists(path):
            return ImageFont.truetype(path, 15)
    return ImageFont.load_default()


def classify(line: str) -> str:
    if line.startswith("###"):
        return "banner"
    if "process exited" in line:
        return "exit"
    if "diverged after" in line:
        return "diff"
    if line.startswith("  - "):
        return "minus"
    if line.startswith("  + "):
        return "plus"
    if line.startswith("[parent") or "resumed from the fork" in line:
        return "role"
    if "[branch A pid" in line:
        return "ansA"
    if "[branch B pid" in line:
        return "ansB"
    if line.startswith("  A ") or line.startswith("  B ") or "syscall diff" in line:
        return "sys"
    if (
        line.startswith("[pid")
        or line.startswith("tokens:")
        or line.startswith("  note:")
        or line.startswith("  summary")
        or line.startswith("  last llm_call")
        or set(line.strip()) <= set("-")
    ):
        return "muted"
    return "out"


def main() -> int:
    if not os.path.exists(CAPTURE):
        sys.stderr.write(f"capture not found: {CAPTURE}\n")
        return 1
    with open(CAPTURE, "r", encoding="utf-8") as fh:
        raw = fh.read().split("\n")
    if raw and raw[-1] == "":
        raw.pop()
    if not raw:
        sys.stderr.write("capture is empty\n")
        return 1

    font = load_font()
    char_w = font.getlength("M") or CHAR_W_FALLBACK
    max_len = max(len(ln) for ln in raw)
    width = int(max_len * char_w) + PAD * 2 + 4
    height = LINE_H * len(raw) + PAD * 2

    frames = []
    durations = []
    for shown in range(1, len(raw) + 1):
        img = Image.new("RGB", (width, height), BG)
        d = ImageDraw.Draw(img)
        for idx in range(shown):
            ln = raw[idx]
            color = COLORS[classify(ln)]
            d.text((PAD, PAD + idx * LINE_H), ln, font=font, fill=color)
        last = raw[shown - 1]
        cx = PAD + len(last) * char_w
        cy = PAD + (shown - 1) * LINE_H
        d.rectangle([cx, cy + 2, cx + char_w * 0.6, cy + LINE_H - 4], fill=(205, 214, 244))
        frames.append(img)
        durations.append(240)
    durations[-1] = 1800

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    frames[0].save(
        OUT,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        disposal=2,
    )
    print(f"wrote {OUT} ({len(frames)} frames, {width}x{height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
