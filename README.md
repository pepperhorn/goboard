# Go — grid composition

A boundless grid sequencer built around a Go-board metaphor: stones on a wooden field,
one row per semitone, one column per quarter note. Columns subdivide independently and
per layer, so an 11-tuplet can sit next to a straight 16th without either bending to a
global grid.

The full design and rationale is in [`go-spec.md`](./go-spec.md); this README is the
short version.

## What makes it different

- **Rational time, not floats.** Positions are `{col, frac}` with exact `Frac`
  arithmetic over a fixed denominator lattice (`2^8·3^4·5^2·7^2·11^2·13^2`). Two notes
  written the same way are the same instant, forever — no epsilon comparisons, no drift.
- **Per-layer, per-column subdivision, two levels deep.** A column can be 11 slots on
  the drum layer and 4 on the bass, and any of those slots can split again.
- **Boundless board.** No song length, no bar count, negative columns included; the
  viewport culls to what is visible plus the longest note.
- **Velocity as a first-class lane.** Layer default → column velocity → per-note
  override, resolved by one pure function.

## Stack

React 19 for chrome only, canvas for the board, zustand for chrome state, a plain
vanilla store for the document. `smplr` for sampled instruments, `@tonejs/midi` for
export, `idb` for autosave. Vite, TypeScript, Vitest, Playwright.

The board never re-renders through React: gestures write to the document store, which
bumps a dirty flag that a single rAF loop reads. React only sees derived scalars
(`canUndo`, the selected note, the transport state) pushed once per commit.

## Running it

```bash
pnpm install
pnpm dev            # http://localhost:5173
pnpm test           # 469 unit tests (vitest, headless)
pnpm test:e2e       # 4 Playwright smoke flows
pnpm bench          # the §5.3 frame-time benchmark
pnpm build
```

Audio needs a click first — browsers refuse to start an `AudioContext` without a
gesture. The board is fully usable while silent.

## Layout

```
src/core/      rational time, positions, subdivision trees, tempo map, command stack
src/board/     viewport, canvas passes, sprite atlas, hit testing, pointer gestures
src/audio/     scheduler (worker timer + lookahead), instrument pool, manifests
src/io/        .go.json import/export, IndexedDB autosave, SMF type 1 export
src/state/     the document store and the React chrome store
src/ui/        React shell: transport, layer panel, inspector, velocity lane
src/bench/     the §5.3 benchmark fixture and page (bench.html)
e2e/           Playwright smoke flows
bench/         the frame-time benchmark and its recorded numbers
```

## Performance

§5.3 asks for 60 fps pan and zoom with 5,000 notes in the viewport and 50,000 in the
project, and insists the number be recorded rather than asserted in prose. `pnpm bench`
drives the real board through a scripted pan and zoom at a pinned viewport and DPR;
`bench/latest.json` holds the last run. On software-rendered headless Chromium:

| phase              | notes in view | p50    | p95    | over 16.7 ms |
|--------------------|---------------|--------|--------|--------------|
| pan @ min zoom     | 4,974         | 1.1 ms | 2.2 ms | 0 / 180      |
| pan @ default zoom | 818           | 0.6 ms | 1.6 ms | 0 / 120      |
| zoom sweep         | 207           | 1.6 ms | 2.9 ms | 0 / 120      |

The first version of that table read 24.4 ms / 29.0 ms / 180 of 180 frames over budget.
Three things closed the gap, all of them §5.3 requirements that had not been
implemented or had been implemented backwards: pan blits the previous frame and
repaints only the exposed strip, the sprite atlas is rebuilt when the zoom *settles*
rather than on every zoom frame, and the atlas keeps its sprites when its texture
grows instead of re-baking every glow in the next frame.

## Notable implementation details

- **MIDI PPQ is chosen per file.** SMF's division field is 16 bits with bit 15 reserved,
  so the real ceiling is 32767, not the conventional 960 — and 960 is exact for none of
  this app's headline tuplets. The exporter takes the lcm of every denominator in the
  project and writes the largest multiple of it that fits. Ticks are rounded as
  absolutes and then differenced, so error never accumulates across a piece.
- **Autosave diffs bytes, not objects.** `.go.json` serialization is deterministic
  (sorted `Map` entries, rebuilt key order), so dragging a note away and back writes
  nothing.
- **The renderer's performance rules are requirements, not optimizations** — sprite
  atlas, baked glow, self-blit pan, overlay canvas for the playhead, one `Path2D` per
  gridline pass. See §5.3 of the spec for why each one exists.

## Status

Milestones M1–M7 of the spec's build order are implemented: time core, board render,
project I/O, editing, playback, velocity, instruments, persistence and export.
Out of scope for v1: time signatures, tempo-map editing UI, multi-select, copy/paste,
MEI export.
