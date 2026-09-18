#!/usr/bin/env python3
"""
Generate a self-contained, animated HTML terminal that replays Demo B (pause
across reboots) from ``demo-b.capture.log``.

Same rationale as Demo A: the offline sandbox has no Pillow / ImageMagick /
ffmpeg and no browser for Playwright, so a raster GIF cannot be rendered here.
This script needs only the Python standard library and produces a zero-dependency
file (no CDN, works offline) that replays the captured spawn -> reboot -> restore
run verbatim. For the actual GIF, run ``make-demo-b-gif.py`` where Pillow is
installed.

Usage:
    python examples/make-demo-b-html.py
Writes:
    docs/demo-b.html
"""
from __future__ import annotations

import html
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CAPTURE = os.path.join(HERE, "demo-b.capture.log")
OUT = os.path.join(HERE, os.pardir, "docs", "demo-b.html")


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

    rows = [{"t": html.escape(ln) if ln else " ", "c": classify(ln)} for ln in raw]
    data = json.dumps(rows, ensure_ascii=False)

    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cortex — Demo B: pause across reboots</title>
<style>
  :root {{
    --bg: #0b0e14; --bar: #11151f; --edge: #1c2230;
    --fg: #e6e6e6; --role: #8be9fd; --checkpoint: #ffb86c;
    --recovered: #50fa7b; --skip: #6272a4; --sys: #bd93f9;
    --banner: #ff79c6; --muted: #6b7280;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: #05070b; color: var(--fg);
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 24px;
  }}
  .term {{
    width: min(880px, 96vw); background: var(--bg);
    border: 1px solid var(--edge); border-radius: 10px; overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,.5);
  }}
  .bar {{
    display: flex; align-items: center; gap: 8px;
    background: var(--bar); padding: 10px 14px; border-bottom: 1px solid var(--edge);
  }}
  .dot {{ width: 12px; height: 12px; border-radius: 50%; }}
  .r {{ background: #ff5f56; }} .y {{ background: #ffbd2e; }} .g {{ background: #27c93f; }}
  .title {{ margin-left: 10px; color: #9aa4b2; font-size: 13px; }}
  .body {{
    margin: 0; padding: 16px 18px; height: 560px; overflow: auto;
    white-space: pre-wrap; word-break: break-word;
  }}
  .line {{ min-height: 1.5em; }}
  .role {{ color: var(--role); }}
  .checkpoint {{ color: var(--checkpoint); }}
  .recovered {{ color: var(--recovered); }}
  .skip {{ color: var(--skip); }}
  .sys {{ color: var(--sys); }}
  .banner {{ color: var(--banner); font-weight: 700; }}
  .exit {{ color: var(--recovered); font-weight: 700; }}
  .muted {{ color: var(--muted); }}
  .out {{ color: var(--fg); }}
  .cursor {{
    display: inline-block; width: 9px; height: 1.05em; vertical-align: -2px;
    background: #cdd6f4; animation: blink 1s steps(1) infinite;
  }}
  @keyframes blink {{ 50% {{ opacity: 0; }} }}
  .cap {{ color: #6b7280; font-size: 12px; padding: 0 18px 14px; }}
</style>
</head>
<body>
  <div class="term">
    <div class="bar">
      <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
      <span class="title">cortex &middot; examples/checkpoint-agent.ts — Demo B: pause across reboots</span>
    </div>
    <pre class="body" id="body"></pre>
    <div class="cap">Replay of the real CLI run (offline, mock driver): spawn &rarr; reboot &rarr; restore. Loops automatically.</div>
  </div>
<script>
  const ROWS = {data};
  const body = document.getElementById('body');
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  let i = 0;
  function step() {{
    if (i < ROWS.length) {{
      const d = document.createElement('div');
      d.className = 'line ' + ROWS[i].c;
      d.textContent = ROWS[i].t;
      body.appendChild(d);
      body.appendChild(cursor);
      i++;
      body.scrollTop = body.scrollHeight;
      setTimeout(step, 230);
    }} else {{
      setTimeout(() => {{
        body.innerHTML = '';
        i = 0;
        step();
      }}, 4500);
    }}
  }}
  step();
</script>
</body>
</html>
"""
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(doc)
    print(f"wrote {OUT} ({len(rows)} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
