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
pnpm test           # 446 unit tests (vitest, headless)
pnpm test:e2e       # 4 Playwright smoke flows
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
e2e/           Playwright smoke flows
```

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
