#!/usr/bin/env python3
"""
Render Demo B (pause across reboots) as an animated GIF: ``docs/demo-b.gif``.

Needs Pillow and a monospace TTF. In the offline build sandbox Pillow cannot be
installed and there is no browser for Playwright, so this script is the path to
the *real* GIF; for an immediately viewable, dependency-free replay use
``make-demo-b-html.py`` (produces ``docs/demo-b.html``).

Usage:
    python examples/make-demo-b-gif.py
Reads:
    examples/demo-b.capture.log
Writes:
    docs/demo-b.gif
"""
from __future__ import annotations

import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - the offline sandbox hits this
    sys.stderr.write(
        "Pillow is not installed. Run:  pip install pillow\n"
        "Then re-run this script to produce docs/demo-b.gif.\n"
        "For a dependency-free animated replay, use make-demo-b-html.py.\n"
    )
    raise SystemExit(2)


HERE = os.path.dirname(os.path.abspath(__file__))
CAPTURE = os.path.join(HERE, "demo-b.capture.log")
OUT = os.path.join(HERE, os.pardir, "docs", "demo-b.gif")

BG = (11, 14, 20)
PAD = 18
LINE_H = 22
CHAR_W_FALLBACK = 9.0

COLORS = {
    "role": (139, 233, 253),
    "checkpoint": (255, 184, 108),
    "recovered": (80, 250, 123),
    "skip": (98, 114, 164),
    "sys": (189, 147, 249),
    "banner": (255, 121, 198),
    "exit": (80, 250, 123),
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
    if "inbox cleared" in line:
        return "exit"
    if "checkpointing" in line or "suspended at" in line:
        return "checkpoint"
    if "recovered" in line:
        return "recovered"
    if "skip" in line:
        return "skip"
    if line.startswith("[inbox-watcher"):
        return "role"
    if (
        line.startswith("process suspended")
        or line.startswith("process exited")
        or line.startswith("restored as pid")
    ):
        return "sys"
    if (
        line.startswith("[pid")
        or line.startswith("tokens:")
        or line.startswith("  chain:")
        or line.startswith("  resume with:")
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
        durations.append(250)
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
