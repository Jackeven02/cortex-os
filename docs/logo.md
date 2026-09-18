# The Cortex mark

The mark is one idea, not three. #050 asked for "layers, nuclei, or branching — not a
brain clip-art," and the honest answer is that all three of those are the *same*
shape in this project:

- The **layers** are the cortex itself — the thin outer layer where the interesting
  work happens, and the reason the project is not called *brain*. Two concentric
  arcs, not a filled blob: a cortex is a surface, and a surface has an inside.
- The **nucleus** is the innermost node — the process. It is the only thing in the
  mark that is a *thing* rather than an *edge*.
- The **branch** is the fork. The layers do not close; they open at the upper right,
  and what comes out of that opening is a process tree.

So the composition is a sentence: **a layered structure whose inner layer is a
process that forks.** Layers → nucleus → branch, read left to right and outside in.

## Why this and not something else

**Layers, not folds.** A real cortex is a wrinkled sheet, and the obvious move is to
draw gyrification — wavy folds. It fails at 16px (the wrinkles turn into noise) and
it says "brain" too literally, which #050 explicitly ruled out. Concentric arcs
survive downscaling because they are just two thick strokes, and they read as
*layers of something* without naming the something.

**A gap, not a closed ring.** A closed ring is a donut. A ring with a deliberate
opening on one side is a *vessel*, and it gives the fork somewhere to come from. The
opening is on the upper right (the "forward" direction of reading, and the direction
the wordmark runs) so the eye leaves the mark travelling out, not circling back.

**The fork is a process tree, not an arrow.** The branch ends in filled nodes — this
is `spawn`, not a cursor or a lightning bolt. Filled nodes are also what keeps the
mark legible when the arcs get blurry: at small sizes the three dots still read.

**Two colors, one accent.** The arcs and branch are ink; only the three *nodes* are
accent (teal). That means the mark degrades gracefully to a single color — drop the
accent and you still have the whole idea — which is what `logo-mono.svg` does.

## Files

| File | Use |
|---|---|
| [`assets/logo.svg`](../assets/logo.svg) | Primary mark, for light backgrounds. Ink `#2C2C2A`, accent `#0F6E56`. |
| [`assets/logo-dark.svg`](../assets/logo-dark.svg) | For dark backgrounds. Ink `#F1EFE8`, accent `#5DCAA5`. |
| [`assets/logo-mono.svg`](../assets/logo-mono.svg) | Single-color, inherits `currentColor`. For stamps, watermarks, print, and anywhere the accent would clash. |
| [`assets/logo-tile.svg`](../assets/logo-tile.svg) | 512×512 rounded-square tile with a baked-in dark background. Use as the GitHub/social avatar — it needs no background of its own. |
| [`assets/favicon.svg`](../assets/favicon.svg) | Simplified for small sizes: the inner arc is dropped, and the remaining strokes are thickened so the ring and fork survive at 16px. |
| [`assets/wordmark.svg`](../assets/wordmark.svg) | Mark + "cortex", for places that need the name too. |

All files are plain SVG with no scripts, no `<style>` blocks, and no external
references, so GitHub renders them directly in Markdown and they work as `favicon`
links without conversion. They scale to any size; there is no raster master.

> **Wordmark caveat:** the `cortex` text in `wordmark.svg` uses a system-font stack
> (`-apple-system, Segoe UI, Roboto, …`), not outlined paths. That keeps the file
> editable and tiny, but it means the wordmark's exact letterforms depend on the
> viewer's fonts. If you need a locked-down wordmark for print or a sticker, convert
> the text to paths first — that is a deliberate post-v0 chore, not an oversight.

## Usage

- **Minimum size:** 16px for `favicon.svg`, 24px for the full mark. Below that the
  two arcs collapse into one another.
- **Clear space:** keep a margin of one stroke-width (10/128 of the width) on all
  sides.
- **Don't** rotate it, recolor the accent to something that fights the ink, add a
  shadow, or set it on a busy photo — the gap and the thin inner arc are the first
  things to disappear.
- On light backgrounds use `logo.svg`; on dark, `logo-dark.svg`. Do not use the dark
  variant on light "because it looks more premium" — the ink is near-white and it
  will vanish.
