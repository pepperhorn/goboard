# Go — Grid Composition App
## Technical Specification & Build Plan v1.1

**Working name:** Go (as in the board game). Repo name: `go-board` (avoids collision with the Go language in search/tooling).

---

## 1. Concept

A boundless-canvas, grid-based composition environment. Time runs horizontally, pitch runs vertically. Notes are stones placed on a board. Voices live in Photoshop-style layers with independent mute and visibility. Each layer carries its own rhythmic grid — a line spacing that can change anywhere along the timeline, at any tuplet the §3.1 lattice allows (5, 7, 9, 11, 13 included), with no depth limit.

The Go metaphor drives the visual language:

- Notes render as **stones**: white stones on white-key pitch rows, black stones on black-key rows (pitch class determines stone color, exactly like piano key color).
- Layer identity is a **colored ring/glow** around the stone, so voices stay distinguishable regardless of stone color.
- Pitch rows are faintly shaded by key color (white-key rows slightly lighter) so the board reads like a rotated keyboard.

---

## 2. Stack

| Concern | Choice | Rationale |
|---|---|---|
| Build | Vite + TypeScript | Fast, standard. No webpack. |
| UI shell | React 18+ | Panels, transport, inspector only. |
| Board | Single `<canvas>`, Canvas2D | DOM-per-cell dies at scale; Canvas2D with viewport culling handles stones + gridlines easily. |
| State | Zustand (vanilla store + React bindings) | Note data lives **outside** React; board reads the store directly in a rAF loop. |
| Audio | Web Audio API + `smplr` | Sample playback with `time` parameter → plugs into a hand-rolled lookahead scheduler. |
| Scheduling | Hand-rolled lookahead scheduler | ~100 lines. No Tone.js — its Transport (bars:beats:sixteenths, 192 PPQ) can't express per-layer 11/13-tuplets. |
| Escape hatch | PixiJS (WebGL) | Only if Canvas2D can't hold 60fps with thousands of visible stones + smooth zoom. Not v1. |
| WASM | Not used | Bottleneck is rendering, not compute. |

**Architectural rule:** a note edit must never trigger a React render. React renders chrome (layer panel, transport, velocity-lane container, inspector). The board canvas subscribes to the store imperatively and redraws in `requestAnimationFrame` (dirty-flag: redraw only when store version or viewport changes).

The rule is enforced **structurally, not by discipline** — two stores, not two slices:

| Store | Contents | Exports |
|---|---|---|
| `boardStore` (`zustand/vanilla`) | notes, runtime indexes (§4.1), `Viewport`, `renderVersion`, `commitVersion` | **no React hook at all** |
| `uiStore` (Zustand + React) | layer metadata, `activeLayerId`, transport, inspector target, undo/redo enabled, autosave state | hooks |

With a single store, one stray `useStore(s => s.notes.length)` silently breaks the invariant and nothing fails loudly. `Viewport` belongs in `boardStore` because pan/zoom writes 60×/second — which also means the gutter, ruler, and velocity-lane canvases are imperative subscribers, not prop consumers; their React wrappers render once and never again.

**Two version counters.** `renderVersion` bumps on every mutation including intermediate drag frames (the canvas dirty flag); `commitVersion` bumps only on command commit or drag end (what React watches). A single counter forces a choice between 60 Hz React renders during a drag and a stale inspector after it.

React subscribes only to **derived scalars** — `canUndo`, `isDirty`, a selected-note snapshot, throttled note counts — via `store.subscribe` + local state, never to the note array itself. The vanilla store may mutate note objects in place (cloning a 50k array per keystroke is not viable), which is incompatible with reference-equality selectors and is a further reason for the split; the `{do, undo}` command pattern stays valid as long as inverses capture explicit prior values. Guard the rAF loop and store subscriptions against React StrictMode's double-invoked effects, or dev builds get doubled commands on the undo stack.

---

## 3. Time Model (foundational — build first)

### 3.1 Rational time

Fixed-PPQ integer ticks are ruled out: tuplets of 5/7/9/11/13, nested (e.g. 13 inside 11), require an LCM base around 10¹¹ ticks/quarter. Canonical time is **rational**.

```ts
type Frac = { n: number; d: number };        // always gcd-normalized, d > 0
type Pos  = { col: number; frac: Frac };     // col = quarter-note index (integer, boundless, may be negative)
                                             // frac = offset within the column, 0 ≤ frac < 1
```

**Denominator lattice.** Slot-boundary denominators within one column are `s₁·s₂ ≤ 256`. Derived denominators — anything produced by addition — divide

```
L = 2⁸·3⁴·5²·7²·11²·13² = 519,437,318,400   (≈ 5.19e11)
```

and this lattice is **closed under addition**, so no reachable `Frac` ever escapes it. `L` is itself an exact float, but `L² = 2.7e23` is not — hence the rules below.

- **`add`/`sub` must reduce before multiplying:** `g = gcd(b,d); den = b*(d/g); num = a*(d/g) + c*(b/g)`. Never form `b*d` — that overflows 2⁵³ in ordinary use (five columns of nested tuplets reach `d = 3.07e9`, and `b*d = 9.4e18` on the next addition).
- **`cmp` cross-multiplies after reducing by `gcd(a.d, b.d)`,** bounding the product at `L`. (Naive cross-multiplication happens to order correctly on this lattice — distinct products differ by at least `d₁d₂/L` while the float ulp is `d₁d₂/2⁵²`, a margin of ~8,670× — but the code must not depend on that argument holding.)
- **Canonical forms:** `normalize(0)` returns `{n:0, d:1}`; `gcd` carries sign so `d > 0` always holds after `sub`/`mul` with a negative operand. Without this, `0/5` and `0/1` are distinct and `eq`/dedup/JSON round-trip disagree.
- Durations are also `Frac`, in quarter-note units, and must be `> 0` (enforced). A duration may cross column boundaries.
- Utility module `frac.ts`: `normalize`, `add`, `sub`, `cmp`, `mul`, `lt/lte/eq`, `toNumber` (display/render only, never storage).

**Pos canonicalization.** Every mutation routes through a single `canonicalize(col, frac)` chokepoint that restores `0 ≤ frac < 1`. It must use **floored** div-mod, not `%` — JS `%` truncates (`(-1) % 3 === -1`), so a leftward drag would yield `{col: 0, frac: -1/3}` instead of the canonical `{col: -1, frac: 2/3}`. Those denote the same instant but sort differently and produce different index keys, so the same note becomes findable at two columns.

```ts
q = Math.trunc(n/d); r = n - q*d;
if (r < 0) { q--; r += d; }
while (r >= d) { q++; r -= d; }   // repairs any ±1 float error in the division
```

### 3.2 Grid regions

Per **layer**, a sorted list of change points — the same piecewise-constant shape `tempoMap` (§3.3) uses:

```ts
type GridRegion = { start: Pos; value: Frac };   // value = line spacing, in quarter notes
                                                  // 1/256 <= value <= 4, reduced,
                                                  // denominator dividing the §3.1 lattice
type Layer       = { /* ... */ grid: GridRegion[] };   // sorted by start; replaces the old Subdiv map
```

A region runs until the next region's `start`, or forever if it is last. **Before the first region, and for an empty list, the grid is the implicit default of one quarter** — this also governs negative columns, since the board is boundless leftward, and it is deliberately *not* `tempoMap`'s backward-extrapolation rule (§3.3).

**Phase is anchored at `region.start`, never at a global origin.** A region of value 2/3 starting at col 5+1/4 puts its first intersection exactly there. Consequently, **two adjacent regions of equal value are legal and meaningful** — the second resets phase rather than being a no-op.

**Slots** stay half-open, as before: slot *k* of a region spans `[start + k·v, min(start + (k+1)·v, next.start))`. The last slot before a region boundary may be **clipped** — it is still a real slot: it draws a line, accepts a stone, and lends its (short) duration to a stone placed there. This is normative for hit-testing, the ruler, and the velocity lane, exactly as the old half-open rule was.

**Canonical form**, which autosave's byte-diff depends on: sorted by `start`, no duplicate starts (rejected on import, as duplicate `colVel` columns already are), and a region is dropped only when it is a true no-op — same value as its predecessor *and* a start that already lies on the predecessor's lattice. A same-valued region starting off that lattice changes the phase and must be kept, so **do not compare grid lists by shape** — compare enumerated slots, as `Subdiv` equality once required.

Regions subsume the old depth-2 nesting: a `{split, children}` tree was a finite sequence of uniform runs, and each run becomes a region anchored at its own start (e.g. `{split:4, children:[null,null,{split:3},null]}` becomes regions at `0` (value 1/4), `2/4` (value 1/12), `3/4` (value 1/4)). Arbitrary depth comes free, because a region starts at a `Pos` rather than at a column — there is no depth limit left to hit.

**Persistence.** `.go.json` is format v2. A v1 reader migrates each layer's `Subdiv` map to regions, one region per **uniform run** (not per column — that would flatten a nested column and leave every note inside it off-grid). Losslessness means the enumerated slot starts are identical before and after; tree shape is not preserved and does not need to be.

### 3.3 Tempo map & seconds conversion

```ts
type TempoEvent = { pos: Pos; bpm: number };   // sorted; index 0 at col 0 (default 120)
```

`toSeconds(pos, tempoMap)`: tempo is **piecewise-constant**, so seconds is piecewise-**linear** in quarters (quarters ÷ (bpm/60) per segment). Stating it this way matters: a v2 tempo *ramp* is logarithmic (`t = 60·Δq·ln(b₁/b₀)/(b₁−b₀)`) with an exponential inverse, and must not inherit this formula.

Because every segment slope `60/bpm` is strictly positive, the map is strictly increasing and **invertible in closed form**. Precompute a prefix array of `(quartersᵢ, secondsᵢ)` per event; `secondsToPos(s)` is a binary search plus `q = qᵢ + (s − sᵢ)·bpmᵢ/60` — O(log n), and O(1) amortized during playback since the playhead advances monotonically (cache the segment index). Invalidate on tempo edits only.

Validation: `bpm > 0` (enforce `bpm ∈ [3.576, 999]` — the lower bound is the 24-bit µs/quarter MIDI tempo meta), and de-duplicate coincident positions (last wins) so no zero-length segment exists for the binary search to land inside.

Converting to seconds happens **only** in the scheduler; converting to integer ticks happens **only** at MIDI export.

### 3.4 Meter / barlines

```ts
type Meter   = { pos: Pos; beatUnit: Frac; groups: number[] };
                         // bar length = sum(groups) × beatUnit
                         // 6/8 felt as 3+3  → { beatUnit: 1/2, groups: [3, 3] }
                         // 7/8 felt as 2+2+3 → { beatUnit: 1/2, groups: [2, 2, 3] }
                         // 4/4               → { beatUnit: 1,   groups: [1, 1, 1, 1] }
type Project = { /* ... */ meterMap: Meter[] };
```

`meterMap` is a sorted list of meter changes; it may change any number of times through the piece. A meter change **starts a new bar at its own position**, cutting the previous bar short if the two don't line up — this is what makes every meter's `pos` itself a bar boundary, and what lets a bar be located by arithmetic instead of a walk from the origin. Absent `meterMap` means one 4/4 at the origin, and the map must be anchored at or before column 0 (`buildMeterMap` enforces this before any bar arithmetic runs).

Three line weights render from one map: bar starts draw thick, group starts (a bar's felt beats — the 2+2+3 inside 7/8) draw medium, and grid-region intersections (§3.2) draw thin.

`beatUnit` is restricted so `4/beatUnit` is a power of two — SMF's time-signature denominator is a 2^k field — **and** its denominator must divide the §3.1 lattice. The grid ladder's triplet values (1/3, 2/3, 4/3, 1/6, 1/12) are legal grid spacings but must never leak into a `beatUnit`.

MIDI export writes one time-signature meta event per meter change (numerator `sum(groups)`, denominator `4/beatUnit`). **Grouping does not survive the SMF boundary** — 7/8 felt as 2+2+3 exports as plain 7/8 — and survives only in `.go.json`. Meter positions join note and tempo positions in the PPQ lcm (§10), or time-signature ticks would round while notes do not.

---

## 4. Data Model

```ts
type NoteId = string;  // nanoid
type LayerId = string;

type Note = {
  id: NoteId;
  layerId: LayerId;
  pos: Pos;            // onset
  dur: Frac;           // quarter-note units; defaults to the slot duration it was placed in
  pitch: number;       // MIDI note number; board anchor row = C3 = 48
  vel?: number;        // 0–127 override; undefined = inherit (see §6)
};

type Layer = {
  id: LayerId;
  name: string;
  color: string;                    // ring/glow + velocity lane color
  instrumentId: string;             // references an instrument manifest (§9)
  channel: number;                  // MIDI export channel; drum layers → 10 (0-indexed: 9)
  audible: boolean;                 // mute = !audible
  visible: boolean;                 // hide from board; independent of audible
  defaultVel: number;               // 0–127, layer-wide default (init 96)
  colVel: Map<number, number>;      // per-column velocity override, keyed by col
  grid: GridRegion[];               // rhythmic grid, sorted by start; empty = one quarter (§3.2)
  order: number;                    // z-order in layer panel and draw order
};

type Project = {
  version: 2;                       // §3.2's persistence note: a v1 reader migrates old files
  name: string;
  tempoMap: TempoEvent[];
  layers: Layer[];
  notes: Note[];                    // storage form; runtime keeps indexes (§4.1)
  activeLayerId: LayerId;
  meterMap: Meter[];                // bar lines, bar numbers, MIDI time signatures (§3.4)
  loop?: { start: Pos; end: Pos };
};
```

**Layer state semantics** (all four combinations are legal, as in Photoshop):

| visible | audible | Meaning |
|---|---|---|
| ✓ | ✓ | Normal |
| ✓ | ✗ | Seen, not heard (muted reference voice) |
| ✗ | ✓ | Heard, not seen (declutter the board) |
| ✗ | ✗ | Parked |

Non-active visible layers draw at reduced opacity (~0.45); the active layer draws full-strength on top regardless of `order`.

### 4.1 Runtime indexes (not persisted)

- `notesByLayer: Map<LayerId, Note[]>` sorted by `pos` — playback iteration, viewport queries.
- `notesByCell: Map<string, NoteId[]>` keyed by `` `${layerId}:${col}:${pitch}` ``, each bucket sorted by `frac` — placement and toggle. The key deliberately drops `frac`, so a bucket holds every note at that pitch in that column; the scan is short but **not O(1)**, and §7's "changing a layer's grid re-quantizes nothing" means bucket size has no 256-slot ceiling — it grows with editing history.
- `maxDurQuarters: Map<LayerId, number>` — the longest duration on the layer, maintained incrementally.

**Long notes are indexed at their onset only.** A note at col 5 with `dur = 4` draws as a lozenge across cols 5–8 but has no index entry at 6, 7, 8. Both hit-testing and viewport culling must therefore begin their scan at `col − ceil(maxDurQuarters)`, not `col − 1`. Without this, clicking a lozenge's body or right edge finds nothing (so the app places a new stone on top of the one you clicked, and §7's resize gesture — which by definition lands on a *far* column — cannot work), and long notes vanish from the board when you pan right past their onset.

This is deliberately cheaper than an interval tree, and exact: `maxDurQuarters` stays ~1–8 in practice.

- Viewport query = binary search on the sorted `col` range per visible layer, widened by `maxDurQuarters` as above. Rebuild indexes on load; maintain incrementally on edit.
- **On move/resize, delete the old key before inserting the new one.** This is the classic index-desync bug and it gets an explicit test.

### 4.2 Undo/redo

Command pattern: every mutation is a `{ do, undo }` pair pushed to a stack (cap ~500). Covers note add/remove/move, velocity edits, grid changes, layer property changes. Zustand store mutations happen only through commands.

---

## 5. Board & Rendering

### 5.1 Viewport

```ts
type Viewport = { xQuarters: number; yPitch: number; pxPerQuarter: number; pxPerSemitone: number };
```

`xQuarters` is the absolute quarter-note position at the board's **left edge**. `yPitch` is the MIDI pitch at the board's **top edge**; pitch increases upward, so the row for pitch *p* occupies screen y in `[(yPitch − p)·pxPerSemitone, (yPitch − p + 1)·pxPerSemitone)`. Both are stated here because the axis inversion is off-by-one-prone and three canvases share the transform.

- Boundless pan in all directions (negative `col` and any MIDI pitch 0–127 allowed; clamp vertical pan to the MIDI range).
- Zoom: horizontal `pxPerQuarter` 24–512; vertical `pxPerSemitone` 8–48. Pinch/ctrl-wheel zooms about the cursor point.
- Initial view: C3 (48) vertically centered, col 0 at the left edge, 96 px/quarter, 16 px/semitone.

### 5.2 Draw pass (per dirty frame)

1. Row shading — white-key rows `#f7f5f0`-ish, black-key rows a few % darker; row for C rows gets a faint label (`C3`, `C4`…) in the left gutter.
2. Column gridlines — quarter lines; heavier every 4th; **grid lines for the active layer only** (other layers' grids would be noise).
3. Stones — for each visible layer in `order`, then active layer last: circle of radius `min(pxPerSemitone, slotWidth) * 0.42`, filled white or black by pitch class `{0,2,4,5,7,9,11}` → white; ring stroke in `layer.color` (2px, full alpha for active layer). Duration beyond one slot renders as a rounded lozenge (stone stretched horizontally to `dur` width).
4. Playhead — vertical line, position from `secondsToPos` inverse lookup during playback.
5. Left gutter (pitch labels / drum labels §9.3) and velocity lane (§6.2) are separate canvases stacked in the React layout so they can stay pinned while the board pans.

### 5.3 Performance targets

- 60fps pan/zoom with 5k notes in the viewport, 50k in the project — **conditional on the techniques below**, which are requirements, not optimizations. Naive per-stone `arc`+`fill`+`stroke` costs 12–25 ms for 5k stones, and the render budget is ~10 ms once the scheduler and GC take their share of the main thread.
- Cull to viewport ± `ceil(maxDurQuarters)` columns (§4.1), not ± 1.

**Required techniques**

1. **Stone sprite atlas.** One `drawImage` per stone (≈ 2–4 ms for 5k, a 4–6× win over path construction). Atlas key = (white|black fill, layer color, radius bucket, active|dimmed); quantize radius to ~10 buckets and regenerate on zoom-end.
2. **The §1 glow is atlas-only.** `ctx.shadowBlur` is a software path in Skia — 5k glowing stones is ~200 ms/frame. It must be baked into the sprite, never applied live.
3. **Pan is a self-blit.** Pan is pure translation: blit the previous frame at an offset and repaint only the newly exposed strip (~16×1600 px instead of 8.3 Mpx). Biggest single win, because pan is the dominant gesture. Zoom still does a full redraw.
4. **Playhead and hover ghost live on their own overlay canvas.** Otherwise the playhead sets the dirty flag every frame and the whole board repaints at 60fps for an entire song with zero edits.
5. **All gridlines batch into one `Path2D`, one `stroke()`** — flattens the worst case (33 columns × 256 slots) from ~12 ms to ~0.5 ms.
6. **Two grid-line guards:** skip the pass when `pxPerQuarter < 48`, *and* skip any region whose slot width is under 4 px.
7. **Cap the backing store at `min(devicePixelRatio, 2)`** and snap gridline/rect coordinates to device pixels (`Math.round(x*dpr)/dpr`, +0.5 for 1 px lines). Fractional device positions force antialiasing on every edge — slower *and* blurrier.
8. **Batch by style:** iterate layer-major (as §5.2 already does) so `strokeStyle` and `globalAlpha` are assigned once per layer, not once per stone.

**Level of detail.** 5k visible notes only occurs at minimum zoom: at 24 px/quarter × 8 px/semitone the viewport holds ~7,600 quarter-cells, versus ~970 at the 96×16 default. At that zoom stone radius is 3.4 px and the 2 px layer ring is sub-pixel — invisible. So below radius ~4 px, drop the ring and fill the stone in the layer color instead. Cheaper *and* more legible, which makes the stated worst case the easiest case.

**Canvas coordination.** The board, gutter, velocity lane, and overlay are separate canvases but share **one** rAF owner (three independent loops tear visibly during fast pan), **one** `Viewport` object, and **one** `worldToScreen`. Each canvas bakes `-frac(rect.left*dpr)` / `-frac(rect.top*dpr)` into its own `setTransform`: under browser zoom or a fractional flex width, `rect.left * dpr` is fractional and *differs per canvas*, so lane bars would land up to 1 px off the board's columns. Reassigning `canvas.width/height` clears the surface and resets the transform, so every resize re-applies the transform and forces a full redraw of all four; DPR changes at runtime (window dragged to another monitor) need a `matchMedia('(resolution: Xdppx)')` listener.

**Benchmark, not prose.** M2 records a scripted frame-time number at a fixed viewport and DPR, and it is re-run at every subsequent milestone — the target will otherwise rot quietly as the playhead, lane, and grid lines add per-frame work.

---

## 6. Velocity

### 6.1 Resolution order

Effective velocity for a note:

```
note.vel  →  layer.colVel.get(note.pos.col)  →  layer.defaultVel
```

Column-level velocity is **time-linear per layer**: all notes in a column stack share it unless individually overridden. This satisfies: layer default → column default → per-note override in a chord.

**Storage stays column-keyed** even after §3.2's grid regions made resolution's third input — the lane's unit of display — a slot rather than a column. Since a grid value may now be coarser than a quarter, one slot can span two or four columns, and the lane shows a slot's velocity as the value at the slot's **starting** column; a drag on that slot writes the same value to **every column it covers**, clearing anything stale in the range it now owns. Resolution order above is unchanged for every note, on-grid or off — only the lane's write path changed. A known consequence: under an off-phase coarse grid, consecutive slots can cover overlapping column ranges, so editing one slot's bar can shift a neighbouring slot's displayed value. That follows from column-keyed storage and is deliberate; representing it faithfully would need slot-keyed storage, a model change beyond this work.

### 6.2 Velocity lane

- Fixed strip at the bottom of the viewport (~96 px), horizontally locked to the board's pan/zoom.
- Shows the **active layer only**, in its layer color.
- One vertical bar per **slot** governing that column (enumerated from the layer's grid, §3.2 — a slot may span more than one column), height = effective velocity /127.
- Slots containing notes draw solid; empty slots draw a faint ghost bar at the would-be effective velocity (so you can pre-shape dynamics).
- Drag on a bar → sets `colVel[col]` when the column has one slot, or a **slot-level refinement**: v1 simplification — dragging a bar sets `vel` on all notes in that slot; dragging across bars paints. Alt-drag on a single stone's bar segment sets only that note (chord-internal override). If a column has both overridden and inherited notes, the bar renders split (segments per distinct velocity).
- Numeric entry via inspector for precision (0–127).

---

## 7. Interaction (v1)

### 7.1 The ruler

§5.2's draw pass gains a **ruler strip** pinned above the board, horizontally locked to the board's pan/zoom. It is a single surface — column numbers, the loop region, and the playhead handle — and it owns every gesture in the "ruler" rows below. There is no separate "column header".

### 7.2 Gestures

| Surface | Gesture | Action |
|---|---|---|
| Board | Click empty slot | Place stone: active layer, slot duration, inherited velocity |
| Board | Drag from empty slot | Paint stones along the drag (one per slot entered) |
| Board | Click stone (active layer) | Remove it |
| Board | Drag stone | Move, quantized to slots in both axes |
| Board | **Ctrl/Cmd-drag** stone | Duplicate |
| Board | Drag stone's right edge | Lengthen/shorten duration in slot increments |
| Board | Double-click stone (any layer) | Make that stone's layer active |
| Board | Escape (during any drag) | Cancel the drag, restore the pre-drag state |
| Ruler | Click | Seek playhead |
| Ruler | Drag | Set loop region |
| Ruler | Shift-click | Clear loop region |
| Ruler | Right-click / long-press a column | Grid editor for that range (active layer): pick a line spacing from the eleven presets, or type a custom `n/d` tuplet. Default range is the clicked column to the next |
| Ruler (marker band) | Drag a meter marker | Move that meter change to the nearest bar line of the surrounding meter (one command) |
| Ruler (marker band) | Right-click a meter marker | Remove that meter change |
| Any | Space | Play/stop from playhead |
| Any | Wheel | Pan vertically |
| Any | Shift+wheel | Pan horizontally |
| Any | Middle-drag / two-finger drag | Pan |
| Any | Ctrl+wheel / pinch | Zoom about the cursor |
| Any | Ctrl+Z / Ctrl+Shift+Z | Undo/redo |
| Any | `1`–`9`, `0` | Quick-set the grid to `1/n` quarters (n = 1–10) over the hovered slot's column |
| Any | `Shift+1`–`Shift+6` | Quick-set `1/11`–`1/16` quarters, same target rule |

**Bindings deliberately not used.** `Space+drag` to pan is dropped — play fires on keydown, so arming the pan would start playback. `Alt-drag` is not a board binding: GNOME and KDE consume it for window moves, and §6.2 already uses Alt in the velocity lane.

**The meter marker band.** Markers own a 12 px band at the top of the ruler strip and win there for both gestures above; below the band, click-seek, drag-loop, shift-click-clear and right-click-grid-editor are exactly as documented above. The first meter (§3.4) cannot be moved off the origin or removed — right-clicking or dragging it opens the grid editor instead — because the bar arithmetic requires the map stay anchored at or before the origin.

### 7.3 Rules the gestures depend on

- **Click vs drag.** `pointerdown` captures the pointer. Crossing 4 px (mouse) or 10 px (touch) latches "drag" **permanently** — returning to the origin must never re-arm the delete. Without this, a 2 px twitch during an intended move destroys a note.
- **One command per drag**, emitted on `pointerup` — not one per quantize step, or Ctrl+Z rewinds a drag one slot at a time.
- **Hit testing is geometric, then slot-based.** Test the point against the *drawn* stone/lozenge rectangle. Slot resolution decides only where an empty-space click places a new stone. Slot-based hit testing would make off-grid notes (see below) permanently unclickable — visible but impossible to remove or move.
- **Hit priority is the inverse of draw order:** active layer first, then descending `order`. Otherwise you delete the stone underneath the one you clicked.
- **Non-active layers are pointer-transparent** — clicks fall through to place on the active layer. Double-click is the only gesture that reaches them.
- **Same-cell ties** resolve to the shortest duration, then most-recently-added. The command layer forbids two notes with identical `(layer, pitch, pos)`.
- **Resize hot zone** is `min(6px, stoneWidth * 0.25)`, disabled below **10 px** stone width. A one-slot stone is `pxPerSemitone × 0.84` wide, so the threshold must sit between minimum zoom (8 px/semitone → 6.7 px wide, where a fixed 6 px zone would swallow the whole stone and make click-to-remove unreachable) and the 16 px/semitone default (13.4 px wide, where resize must work). 10 px separates them; 16 px would disable resize at the default zoom.
- **Lozenge geometry.** §5.2's "circle centred in its slot" and "stretched to `dur` width" disagree at the crossover, so: the caps are centred on the **first and last slot the note covers**. A one-slot note is then exactly the specified circle, and lengthening a note never shifts its head — centring on the full span would make the head jump left on the first resize step. The drawn right edge, and so the resize zone, therefore sits half a slot short of the note's mathematical end. Hit testing and the renderer share one `noteRect` function so they cannot drift.
- **Audition on drag** (§8.2) fires only when the quantized pitch changes, and never on a removal click.
- **Kit layers reject placement** on unmapped rows (§9.3) — the click is a silent no-op, not a pan.
- **Canvas event hygiene:** `touch-action: none`, `user-select: none`, native context menu suppressed, middle-mousedown default prevented (Linux paste / Windows autoscroll), `wheel` bound with `{passive: false}` on the element (React's `onWheel` cannot reliably `preventDefault` browser page zoom), `e.repeat` filtered on Space, and Space `preventDefault`ed globally so it doesn't activate a focused layer-panel button.

Notes placed where no region governs land on the implicit quarter slot (§3.2). Changing a layer's grid **re-quantizes nothing** — existing notes keep their exact rational positions; they may sit off the new grid (render slightly desaturated ring to flag "off-grid for this layer's current grid").

---

## 8. Audio Engine

### 8.1 Scheduler

Classic lookahead pattern (Chris Wilson "A Tale of Two Clocks"):

- A 25 ms timer **running in a Web Worker**; each tick, schedule everything with onset in `[now, now + 0.1 s)` against `AudioContext.currentTime`. The worker is not optional: a playing tab escapes Chrome's intensive throttling only because it "made noises in the past 30 seconds", so a silent stretch over 30 s — or starting playback from a background tab — drops a main-thread `setInterval` to 1 s ticks, which a 100 ms lookahead cannot survive.
- **The per-layer cursor is a `Pos` value, not an array index.** Each tick binary-searches `notesByLayer` from the last-scheduled position (O(log n), free at 25 ms). An index breaks the moment the user edits during playback — which §7 makes a first-class gesture: inserting a note before the cursor shifts every later element (double-trigger), and deleting the note it points at skips the next one. Also track the `NoteId`s scheduled within the current window so an edit cannot re-fire a note already committed to the audio graph.
- Effective velocity resolved at schedule time (§6.1) → smplr `velocity`. A `colVel` edit therefore cannot affect the ≤100 ms already committed; that is correct behaviour.
- `instrument.start({ note: pitch, velocity, time, duration: durSeconds, stopId: note.id })` — duration converted through the tempo map (a note spanning a tempo change gets its true elapsed seconds). **`stopId` is mandatory:** it defaults to the note number, so stopping one C4 would stop every sounding C4 — and a repeated pitch on a grid is the common case.
- Play/stop/seek: **keep the `StopFn` returned by every scheduled note** and call them all on stop. Do not rely on `instrument.stop()`: smplr runs its own 200 ms internal lookahead, and notes beyond it sit in a queue that `stop()` does not drain. Our 100 ms lookahead happens to stay inside that window, but nothing should depend on it — alternatively construct instruments with `scheduler: Scheduler(ctx, {lookaheadMs: 0})`. Regression test: stop must kill a note scheduled at `now + 250 ms`. Seek rebuilds cursors by binary search.
- Loop: `while (windowEnd > loopEndSec) { schedule up to loopEndSec; cursor = loop.start; timeOffset += loopLengthSec; }` — a `while`, not an `if`, because a loop shorter than the 100 ms lookahead must emit several passes in one tick. Guard `loopLengthSec > 0` or a degenerate region spins forever. `loop.end` is **exclusive**; a note whose duration crosses it is truncated at the loop point. The constant `loopLengthSec` is valid because tempo is not editable in v1 — revisit when tempo-map editing lands.
- Playhead UI reads `AudioContext.currentTime` in the rAF loop and inverts the tempo map — never trust timer callbacks for visuals. Subtract output latency first: `visualTime = currentTime - (ctx.outputLatency ?? 0) - ctx.baseLatency` (feature-detect; `outputLatency` is absent in Safari). `currentTime` is what the graph has *rendered*, not what is audible, so without this the playhead runs ahead of the sound — by tens of ms on speakers, 100–300 ms over Bluetooth. Expose a user-tunable offset slider; no formula beats letting the user nudge it.

### 8.2 Latency & lifecycle

- Create `AudioContext` on first user gesture. `latencyHint: 'interactive'`. Nothing sounds before that gesture, so the transport shows an explicit "click to enable audio" state rather than failing silently.
- Audition on placement: when a stone is placed/moved, fire the note at effective velocity (nice feedback loop; toggleable). Schedule it at `currentTime + 0.005` with a ~3 ms `ampAttack` on the audition path only — firing at exactly `currentTime` is already in the past relative to the next render quantum, so the sample's attack transient is clipped and reads as a click on percussive material.
- Instruments load lazily per layer behind `await instrument.ready`, with `onLoadProgress` wired to real UI, a shared `SampleLoader`, and `storage: CacheStorage()` so reloads are instant.

---

## 9. Instruments (smplr + curated manifests)

### 9.1 Manifest format

One JSON per instrument, self-hosted (B2 or same-origin `/instruments/`):

```jsonc
{
  "id": "ph-piano-1",
  "name": "PepperHorn Piano",
  "kind": "pitched",              // "pitched" | "kit"
  "gmProgram": 0,                  // MIDI export program
  "samples": { "48": "C3", "60": "C4", "72": "C5" },   // MIDI note → sample name, EXTENSION-LESS
  "baseUrl": "https://…/piano",
  "formats": ["ogg", "m4a"]
}
```

Pitched instruments load into smplr's `Sampler` via its **preset** path (`{ baseUrl, formats, map }`), which builds `` `${baseUrl}/${name}.${format}` `` — hence extension-less sample names, and free format negotiation. Note that smplr's *flat* `buffers` mode has no `baseUrl` at all and needs absolute URLs; using the preset path with `"C3.ogg"` would fetch `C3.ogg.ogg`.

Because every key is a MIDI number, smplr spreads the sampled pitches across key ranges automatically — zone/stretch stays its job, as intended.

### 9.2 Drum kits

```jsonc
{
  "id": "ph-kit-1",
  "name": "PepperHorn Kit",
  "kind": "kit",
  "gmBasis": true,                 // rows follow GM drum map numbering
  "baseUrl": "https://…/kit",
  "formats": ["ogg", "m4a"],
  "pieces": [
    { "midi": 36, "label": "Kick",   "sample": "kick" },
    { "midi": 38, "label": "Snare",  "sample": "snare" },
    { "midi": 42, "label": "HH Cl",  "sample": "hh-closed" },
    { "midi": 46, "label": "HH Op",  "sample": "hh-open" },
    { "midi": 49, "label": "Crash",  "sample": "crash" }
  ]
}
```

Kits load as a `Sampler` keyed by the GM `midi` values, **not** as smplr's `DrumMachine` — `DrumMachine` maps `midi = 36 + indexInSamplesArray`, so GM row 38 would play whatever happens to sit at `samples[2]`. Loading kits as a Sampler is what keeps §9.3's "pitch stays a real GM MIDI number internally" true.

The manifest is the **single source of truth** for both sound and board semantics.

### 9.3 Drum layers on the board

When the active layer's instrument is `kind: "kit"`:

- The left gutter swaps pitch names for **piece labels** at their GM `midi` rows.
- Rows without a mapped piece render dimmed and reject placement.
- Stone color: all black (key-color semantics are meaningless for drums); layer ring as usual.
- Pitch stays a real GM MIDI number internally → export needs no special casing beyond channel 10.
- **Durations are capped, not forced to one slot.** Drum samples are one-shots, so a kit stone's duration is `min(slotDur, 1/4)` quarters (design §3.5) — a whole-note grid does not give a four-quarter kick, but a finer grid still gives its true (shorter) slot length. The right-edge resize gesture (§7) is disabled on kit layers, and MIDI export writes a short fixed note-off. (Resolves open question 1.)

### 9.4 v1 instrument set

Four starter layers — Piano, Guitar, Bass, Drums on channels 1/2/3/10 — each a self-hosted §9.1/§9.2 manifest from day one. `gmProgram` stays in the manifest for MIDI export only.

**No Soundfont/DrumMachine placeholder stage.** It would be more work than the real thing, not less: smplr's `SoundfontConfig.instrument` is a gleitz soundfont *name*, not a GM program number (`{instrument: 0}` throws outright), each soundfont is a ~2.3 MB base64-in-JS blob that must fully load before `ready` resolves, and `DrumMachine`'s array-order mapping contradicts §9.3. Four small manifests skip all of it and delete a code path that would be thrown away at M6 anyway.

A handful of sampled pitches per instrument is enough — smplr stretches between them (§9.1).

---

## 10. Persistence & Export

- **Project file:** JSON of `Project` (Maps serialized as entry arrays). Autosave to IndexedDB (debounced); manual export/import of `.go.json`.
- **MIDI export (SMF type 1):** choose PPQ per file at export. SMF division is a 16-bit field with bit 15 clear, so the real ceiling is **32767**, not 960 — and 960 = 2⁶·3·5 is exact for *none* of the app's headline tuplets (a plain 9-tuplet already isn't). At 32767 a project mixing 16ths, triplets, 11s and 13s (`L = 6864`) exports **exactly**.

  ```
  L = lcm over ALL denominators: onsets, durations, pos+dur ends, tempo positions
  if L <= 32767:  ppq = L * floor(32767 / L)          // exact, at maximum resolution
  else:           ppq = largest divisor of L <= 32767 // enumerate 2^a·3^b·5^c·7^d·11^e·13^f
                  fallback 30240 = 2^5·3^3·5·7        // exact for every split except 11 and 13
  ```

  Tuplets that still don't divide evenly round to nearest tick **at export only** (the sole place quantization error is permitted). Round **absolute** ticks and then difference them for delta-times — never round deltas, or a 0.45-tick error accumulates to roughly half a quarter note over 1000 events. Note that the damage is in duration, not onset: at 960 the smallest legal slot (1/256 quarter) is 3.75 ticks and rounds to 4, a 6.7% error, while onset error is 0.24 ms at 120 BPM.

  One track per layer, program change from `gmProgram`, kit layers to channel 10, tempo map to meta events (24-bit µs/quarter — clamp BPM to ≥ 3.576). Use `@tonejs/midi` for writing (the library is fine even though Tone.js itself isn't used).
- **Future (v2+):** MEI export. Rational durations + grid regions map near-directly onto MEI proportional durations/tuplet elements → straight path into the Verovio pipeline. Design nothing that blocks this; requires no v1 work.

---

## 11. v1 Scope

**In:** boundless board, per-layer grid regions (line spacing 1/256–4 quarters, any lattice fraction, arbitrary depth via region anchors — §3.2), grouped meter map with ruler markers and bar/group/intersection line weights (§3.4), stones/rings visual language, layer panel (add/rename/color/reorder/mute/hide), velocity lane with column + per-note override, lookahead playback with loop, tempo (single BPM in v1 UI; tempo *map* in the model), 4 starter instruments, kit row labels, undo/redo, IndexedDB autosave, JSON + MIDI export.

**Out (v2+):** tempo-map editing UI, note selection marquee & multi-select ops, copy/paste, MEI export, curated sample library authoring, PixiJS renderer, collaboration, mobile touch polish beyond basic pan/place.

**Open questions (decide during build, none blocking):**
1. ~~Duration model for drums~~ — **resolved in v1.1:** kit layers cap duration at `min(slotDur, 1/4)` quarters (§9.3). It affects M3's resize gesture, not M6.
2. Off-grid stone flagging UX after a grid change (§7) — desaturated ring vs. warning dot.
3. Ghost bars in the velocity lane — useful or noise? Ship behind a toggle.

---

## 12. Build Order

**M1 — Time core (no UI).** `frac.ts`, `Pos` ordering and canonicalization, `Subdiv` slot enumeration and validation, tempo map `toSeconds`/`secondsToPos`, the §4.1 runtime indexes, and the command interface. Unit tests: nested 11×13 slot math, cross-column durations, tempo-change conversions, the denominator-lattice bounds of §3.1, floored div-mod across negative columns. Indexes and commands are pure and testable, and they belong here so M2's perf number measures the real data path. *Everything else stands on this.*

**M2 — Board render.** Canvas viewport, pan/zoom, row shading, gridlines, ruler strip, left gutter, sprite atlas, playhead overlay canvas. Stones from a `.go.json` fixture. Records the §5.3 benchmark number, re-run at every later milestone. Golden-image snapshots at fixed viewport and DPR.

**M2.5 — Project I/O.** `.go.json` import/export (~50 lines). Lands here, not M7: it de-risks `Map` serialization and index-rebuild-on-load — the likeliest late-breaking schema bug — and gives every later milestone real fixtures instead of hardcoded ones.

**M3 — Editing.** Two stores + command stack, place/remove/move/resize/paint, click-vs-drag threshold, subdivision editor, layer panel with visible/audible, inspector, `effectiveVelocity()` as a pure function, off-grid flagging, and a one-shot preview sampler for audition (which also forces the AudioContext first-gesture unlock to be designed now rather than discovered at M4). Property test: a random command sequence plus N undos returns to the initial project.

**M4 — Playback.** Worker-timer scheduler, transport UI, playhead with latency compensation, loop, full audition. Tested against an injected fake clock asserting scheduled onset seconds.

**M5 — Velocity.** Lane rendering, drag painting, per-note alt-drag, split bars.

**M6 — Instruments & kits.** Manifest loader, `CacheStorage`, load-progress UI, kit gutter labels, four starter manifests wired.

**M7 — Persistence & export.** IndexedDB autosave, MIDI export with PPQ selection, round-trip test (export → parse → compare within tick tolerance).

Each milestone is independently demoable; M1 ships as a pure library with tests before any pixel is drawn. Playwright covers six smoke flows — everything else above is headless.
