# Three.js board, grid regions, and meter — design

**Status:** proposed, awaiting review
**Date:** 2026-08-25
**Supersedes:** go-spec.md §3.2 (subdivision tree), §3.4 (no meter in v1), §5 (canvas renderer), parts of §6.1 and §7

---

## 1. Why

Three mockups set the target, kept in `docs/design-refs/`:

- `board-perspective-lavender.png` — the board itself: glowing stones on a receding
  lavender grid. (Its stones sit in cells; ours sit on intersections.)
- `theme-zen-garden.png` — matte stone, engraved hairlines, daylight, moss and sand.
- `theme-synthwave.png` — emissive grid on dark ground, sunset backdrop, and coloured
  cells that are already the subdivision language we need.

Both theme references draw a finite slab with an edge; the board is boundless, so neither
may be copied literally (§4.4). The current board is a flat 2D canvas, stones sit *in cells* rather than on
intersections, and the subdivision model cannot express note values coarser than a
quarter.

Three things follow, in increasing order of cost:

1. Stones mark **onsets on line intersections**; sustain is a separate rounded highlight.
2. The rhythmic grid is chosen from a **ladder of note values** — 32nd-triplet through
   whole — shown as coloured cells, with meter driving heavier lines on beat one.
3. The board is rendered with **Three.js**, tiltable and navigable, and themeable from a
   single object.

---

## 2. Decisions taken

| Question | Decision |
|---|---|
| Renderer | Three.js is the shipping view; the 2D canvas board stays behind a flag as a fallback. A shared `layout.ts` is the single source of geometric truth. |
| Half and whole notes | Real snap targets. Grid spacing generalizes from "divide a quarter" to "lines every *v* quarters". |
| Grid ownership | Per layer, as today. The board draws the active layer's grid; other layers' stones stay visible and dimmed. |
| Meter | A meter *map* that changes through the piece, edited by dragging markers in the ruler. Lands as its own change, after regions. |
| Camera | Pan and zoom always; tilt is a control, from flat overhead for precise editing to the mockup's three-quarter view. |
| Draw strategy | Shader ground plus instanced stones — roughly four draw calls at any zoom or board size. |

### Visual language (from the user)

- The stone is **where the note begins**. It is not stretched.
- A **rounded highlight** shows how long the note sustains. Envelope shading (decay,
  release) lands here later; nothing is built for it now.
- **Velocity applies at the point where the note is played** — it is a property of the
  onset, which is what §6.1 already models.
- The board is **borderless**. No theme may draw a rim; distance is ended with fog or an
  alpha falloff.

---

## 3. Model

### 3.1 Grid value

```ts
/** Grid line spacing, in quarter notes. */
export type GridValue = Frac   //  1/256 <= v <= 4, denominator on the §3.1 lattice
```

`GridValue` is **any** lattice fraction in range, not a member of a closed ladder. This is
load-bearing: a ladder built from 2s and 3s cannot express quintuplets, septuplets, or the
9/11/13-tuplets that §3.1 exists for, and today's model reaches all of them
(`split_1 × split_2` for splits 1–16, up to 256 slots per quarter).

The eleven named rungs are **UI presets**, not the type:

| preset | v (quarters) | | preset | v (quarters) |
|---|---|---|---|---|
| whole | 4 | | 8th | 1/2 |
| half | 2 | | 8th-triplet | 1/3 |
| half-triplet | 4/3 | | 16th | 1/4 |
| quarter | 1 | | 16th-triplet | 1/6 |
| quarter-triplet | 2/3 | | 32nd | 1/8 |
| | | | 32nd-triplet | 1/12 |

A "custom" entry takes any tuplet the lattice allows, replacing the SubdivMenu's split
pickers. Validation on import: `v` reduced, `1/256 <= v <= 4`, denominator divides the
§3.1 lattice bound.

### 3.2 Grid regions replace `Subdiv`

```ts
export type GridRegion = { readonly start: Pos; readonly value: GridValue }

export type Layer = {
  // ...
  readonly grid: readonly GridRegion[]   // sorted by start; replaces `subdivs`
}
```

- A region runs until the next region starts, or forever if it is the last.
- **Before the first region, and for an empty array, the grid is one quarter** — the
  implicit default. The board is boundless leftward, so this also governs negative
  columns. This is deliberately *not* `tempoMap`'s backward-extrapolation rule.
- **Phase is anchored at `region.start`**, not at a global origin. A region of value 2/3
  starting at col 5 + 1/4 puts its first intersection exactly there.
- **Two adjacent regions of equal value are legal and meaningful** — the second resets the
  phase.
- **Canonical form**, which autosave's byte-diff depends on: sorted by start, no duplicate
  starts, and a region is dropped only when it is a true no-op — same value as its
  predecessor *and* a start that already lies on the predecessor's lattice
  (`(start − prev.start) mod prev.value == 0`). A same-valued region starting off that
  lattice changes the phase and must be kept.
- Duplicate starts are rejected on import, as duplicate `colVel` columns already are.

Regions subsume today's depth-2 nesting. A tree is a finite sequence of uniform runs, and
each run becomes a region anchored at its own start: `{split:4, children:[null,null,{split:3},null]}`
becomes regions at `0` (1/4), `2/4` (1/12), `3/4` (1/4). Arbitrary depth comes free, since
a region starts at a `Pos` rather than a column.

### 3.3 Slots

Slot *k* of a region is the half-open interval

```
[ start + k·v ,  min(start + (k+1)·v , next.start) )
```

The last slot before a region boundary may be **clipped**. A clipped slot is a real slot:
it draws a line, accepts a stone, and its (short) duration is what a stone placed there
inherits. `hitTest.noteRect` currently assumes a slot is never wider than a column — false
once `v` can be 2 or 4 — and must be fixed.

**Off-grid** (§7) becomes: the onset is not a slot start, i.e. `(pos − region.start) mod v ≠ 0`.
Exact in rationals. Region boundaries draw as grid lines so a flagged note is visually
explicable.

### 3.4 Velocity under coarse grids

§6.1 resolves `note.vel → layer.colVel.get(col) → layer.defaultVel`, and the lane buckets
notes by slot *within a column*. When one slot spans two or four columns, the lane would
show one value while the scheduler played another for a note in the second column.

**Rule:** storage stays column-keyed. A slot's displayed velocity is the value at the
slot's **starting** column, and a lane edit on a slot writes that value to **every column
the slot covers**, clearing stale entries in the covered range. §6.1's resolution order is
unchanged for every note, on-grid or off; only the lane's write path changes.

### 3.5 Kit layers

§9.3 forces one-slot durations because drum samples are one-shots. Under a whole-note grid
that would mean a four-quarter kick. **Rule:** kit placement snaps to the grid, but
duration is `min(slotDur, 1/4)` quarters, and kit stones always render as circles, never
stretched. Resize stays disabled there, as now.

### 3.6 Lookup

Grid resolution happens per note per frame in the draw path and per pointer move in hit
testing. A binary search per note (rational compares, gcd per probe) is a real regression
against the §5.3 budget.

**Requirement, not optimization:** draw paths resolve the grid through
`createGridCursor(regions)` — a monotone cursor modelled on `createTempoCursor`, stepping
forward from a cached index and binary-searching only on a backward seek. Both draw paths
already iterate in position order. Re-run the M2 benchmark after the change.

### 3.7 Meter

```ts
export type Meter = {
  readonly pos: Pos
  readonly beatUnit: Frac        // in quarters; 4/beatUnit must be a power of two
  readonly groups: readonly number[]   // 6/8 = [3,3];  7/8 = [2,2,3];  4/4 = [1,1,1,1]
}

export type Project = { /* ... */ readonly meterMap: readonly Meter[] }
```

- Bar length is `sum(groups) × beatUnit`. Bar starts draw the thick line, group starts a
  medium one, region intersections the thin one.
- Absent `meterMap` means one 4/4 at the origin.
- `beatUnit` is restricted to powers of two as a fraction of a quarter because SMF's
  time-signature denominator is a 2^k field. Triplet values from the grid ladder must not
  leak into it.
- MIDI export writes one time-signature event per meter change (numerator `sum(groups)`,
  denominator `4/beatUnit`). **Grouping is lost at the SMF boundary** — 7/8 [2,2,3] exports
  as 7/8. It survives in `.go.json`.
- Meter positions join note and tempo positions in `midi.ts`'s `denominators()`, or
  time-signature ticks round while notes do not.

### 3.8 Persistence

`.go.json` goes to **format v2**, with a v1 reader retained. The converter, per layer:

1. Walk columns with entries in ascending order. For each column, enumerate its uniform
   runs from the `Subdiv` tree and emit a region at each run's start with that run's slot
   duration. (Not one region per column — that would flatten nested columns and make every
   note in a nested slot off-grid.)
2. After a column's last run, emit a region of value 1 at `col + 1` — unless the next
   column carries its own entry starting there, in which case that entry wins and the
   restore is dropped.
3. Canonicalize away no-ops: `{split:1}`, and `{split:n, children: all null}` where the
   children add nothing.
4. An empty `subdivs` map becomes an empty `grid` array — the implicit quarter everywhere.

Losslessness is defined as §3.2 defines subdivision equality: **enumerated slots are
identical before and after**. Tree shape is not preserved and does not need to be.

Autosave's byte-determinism (sorted entries, rebuilt key order) extends to regions and the
meter map: sorted by position, canonical `Frac` key order, adjacent equal values preserved
rather than merged.

### 3.9 Untouched

`Pos`, `Frac`, the tempo map, the note index, the scheduler, the instrument pool, the
autosave mechanism, and MIDI export apart from time signatures and the PPQ denominator
set. Notes remain `{col, frac}` with a `Frac` duration.

---

## 4. Renderer

### 4.1 Scene

```
backdrop   sky gradient | image | none                        — theme
ground     one plane; grid lines, pitch-row shading and cell fills
           computed in the fragment shader from a data texture of the
           visible regions and meter
stones     one InstancedMesh — onsets only, on intersections;
           per-instance colour (layer tint) and scale (velocity)
sustains   one instanced rounded-rect quad per sounding note
```

Roughly four draw calls at any zoom and any board size.

The grid is shader work rather than geometry, which is what makes boundlessness free: the
ground plane follows the camera in whole-cell steps so it never runs out, and the theme
ends the distance with fog or an alpha falloff. The visible span's regions and meter are a
few hundred floats, re-uploaded on pan, gathered by the same monotone cursor the draw path
uses.

Pitch rows are lines too, so a stone sits at a genuine crossing — time line × pitch line —
with white/black key rows shaded behind them.

### 4.2 Level of detail

§5.3's LOD rules carry over in WebGL form. Below ~4 px radius, stones lose their ring (an
instance flag, not a per-pixel branch). Grid lines fade by `smoothstep` as their spacing
approaches a pixel, so minimum zoom degrades gracefully rather than aliasing.

### 4.3 Axis chrome

The ruler, pitch gutter and velocity lane stay **flat 2D strips** outside the 3D canvas —
they are axis chrome, not part of the perspective. Under perspective a column's screen x
varies with depth, so these strips align to the board's **near edge**, exactly at tilt 0
and at the near edge otherwise. Precise lane work is a tilt-0 activity; this is a stated
limitation, not a bug to chase.

### 4.4 Theme

One object, read by everything the renderer draws, hot-swappable at runtime:

```
backdrop   sky gradient | image | none, horizon height
ground     base colour/texture, roughness, fog colour + density (ends the board)
grid       per level — bar / group / intersection: colour, width, opacity, emissive
cells      fill colour + opacity per named grid value, plus a ramp keyed on
           log(v) for custom tuplets, so a 1/7 grid lands between the
           presets that bracket it rather than falling back to one colour
stones     white/dark base, material (matte ↔ emissive), rim, glow,
           velocity → brightness and scale mapping
sustain    tint source (layer colour), corner radius, opacity ramp  ← decay lands here
lighting   key / fill / ambient, bloom on|off
camera     default tilt, FOV, zoom limits
```

Two themes ship, one per reference in `docs/design-refs/`:

- **Zen** — matte stone, engraved hairlines, daylight key/fill, sand-and-moss backdrop.
- **Neon** — emissive grid on dark ground, flat rimmed stones, sunset backdrop, bloom.

No colour, width or material literal appears in renderer code. The 2D fallback reads the
same object and ignores materials and lighting.

### 4.5 Modules

```
src/board/layout.ts     board-space geometry: intersections, slots, rows, bar/group lines
src/board/theme.ts      Theme type; themes/zen.ts, themes/neon.ts
src/three/scene.ts      renderer, camera rig, fog
src/three/ground.ts     plane and grid/cell shader
src/three/stones.ts     instanced stones, velocity mapping
src/three/sustains.ts   instanced rounded quads
src/three/pick.ts       raycast → board space
src/board/*             existing 2D renderer, retained as fallback
```

---

## 5. Interaction

Layout stays two-dimensional: board space is quarters × semitones, and the camera is a
mapping from board space to screen. Picking raycasts onto the board plane and yields a
board-space point, so every existing gesture in `interaction.ts` works unchanged — the
one-way drag latch, the click-versus-drag threshold, place/move/resize/paint, and one
command per gesture.

```ts
export type Camera = {
  readonly xQuarters: number
  readonly yPitch: number
  readonly pxPerQuarter: number
  readonly pxPerSemitone: number
  readonly tiltDeg: number     // 0 = overhead; only the 3D path reads it
}
```

The first four fields are today's `Viewport`, so the 2D fallback consumes it unchanged.
Under perspective the pixel scales are exact **at the reference depth** — the board's near
edge, which is what the axis chrome aligns to (§4.3) — and the projection derives the rest.
At tilt 0 the reference depth is the whole board and the two renderers agree exactly, which
is what makes the 2D fallback a fallback rather than a different app.

- **Placement** snaps to the nearest intersection rather than the containing cell.
  Duration is the (possibly clipped) slot length; `min(slotDur, 1/4)` on kit layers.
- **Resize** drags the sustain highlight's right edge to a slot boundary; `resizeZone`
  re-anchors from the old stretched sprite to the highlight.
- **The ruler gains meter markers.** It already owns click-seek, drag-loop and
  right-click-grid, so markers take a 12 px band at the top of the strip with explicit hit
  priority. A marker drag is one command.
- **The SubdivMenu becomes a Grid menu**: eleven presets plus custom tuplet, applied to a
  range. "Set this range to *v*" is one command — insert, swallow covered regions, restore
  at the range end — via `batch`, never three.

---

## 6. Performance

§5.3's eight techniques are 2D-specific; the WebGL equivalents are: at most four draw
calls, instancing, a shader grid that never regenerates geometry, one rAF owner, the
`min(dpr, 2)` cap, and LOD.

The bench harness is retargeted rather than retired — same fixture, same phases, plus a
tilt sweep — and `bench/latest.json` gains a `renderer` field so the recorded 2D numbers
stay as the reference line. The new cost to watch is instance-buffer traffic: 5,000
matrices upload when the visible note set or its velocities change, never on camera moves,
which are a view-matrix change and free.

Target is unchanged: 60 fps with 5,000 notes in view and 50,000 in the project.

---

## 7. Testing

**Headless units** for everything pure: `GridValue` validation, region canonicalization and
phase, slot enumeration including clipped partials, cursor monotonicity, meter → line
positions, board-space mapping, the off-grid predicate, and a property test that the v1→v2
converter preserves enumerated slots exactly across a random corpus of v1 projects.

**Smoke** (Playwright): the six existing flows run against the 3D board, plus one that
forces WebGL to fail and asserts the 2D fallback renders. No golden images — WebGL
rasterizes differently per driver — but an assertion that stones land within a pixel or two
of where `layout.ts` says they should.

**Benchmark:** as §6, both renderers recorded.

---

## 8. Order of work

Each step ships green, with the app working at every point.

1. **Regions replace `Subdiv`** — model, core, converter, and every consumer
   (`hitTest.pointToSlot`, `lane.ts`'s draw loop, `grid.ts`, `boardStore`, the menu).
   2D board still rendering. `.go.json` v2.
2. **Meter** — map, ruler markers, MIDI time signatures, PPQ denominators.
3. **Extract `layout.ts`** so both renderers share one geometric truth.
4. **Theme object**, and re-theme the 2D board through it — proving the contract before
   WebGL depends on it.
5. **Three.js renderer** behind a flag, to parity; bench retargeted.
6. **Flip the default** to 3D; 2D remains the fallback.

Steps 1 and 2 are structural rewrites of column-scoped code, not line edits. Expect them to
run past 1,000 lines including tests.

**This design is two implementation plans, not one.** Steps 1–2 (grid regions and meter)
are a model change to the existing app and stand alone: they ship value — half and whole
grids, compound meter — with the 2D board still rendering. Steps 3–6 (layout extraction,
theme, Three.js) are the renderer change and depend on the first plan being landed. Plan
the first, build it, then plan the second.

---

## 9. Risks

- **`lane.ts` is the worst-affected file.** Its draw loop iterates columns and buckets by
  slot-within-column; multi-column slots break that structure, not just its data.
- **WebGL absence and driver variance.** Mitigated by the 2D fallback and by not asserting
  pixels.
- **Text in 3D.** Avoided entirely — labels live in the flat axis chrome.
- **Tilt versus precision.** Dense 32nd-triplet editing at a steep angle is genuinely
  harder; the tilt control is the mitigation.

---

## 10. Deferred

- Keyboard quick-splits (`1`–`9`, §7.2) speak in split counts and lose meaning under
  regions. Redefine or drop when the Grid menu lands.
- Envelope shading (decay, release) on the sustain highlight — the highlight is designed to
  carry it; nothing is built now.
- Whether tilt is a theme default, a per-project setting, or both.
- Ghost bars in the velocity lane (§11 open question 3) — unchanged by this design.
- Meter changes are edited but not yet re-barred mid-piece in MIDI beyond the meta events.
