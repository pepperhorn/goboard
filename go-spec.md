# Go — Grid Composition App
## Technical Specification & Build Plan v1.0

**Working name:** Go (as in the board game). Repo name: `go-board` (avoids collision with the Go language in search/tooling).

---

## 1. Concept

A boundless-canvas, grid-based composition environment. Time runs horizontally, pitch runs vertically. Notes are stones placed on a board. Voices live in Photoshop-style layers with independent mute and visibility. Columns subdivide rhythmically per layer, nested up to two levels, with arbitrary tuplet splits (2–16, including 5, 7, 9, 11, 13).

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

---

## 3. Time Model (foundational — build first)

### 3.1 Rational time

Fixed-PPQ integer ticks are ruled out: tuplets of 5/7/9/11/13, nested (e.g. 13 inside 11), require an LCM base around 10¹¹ ticks/quarter. Canonical time is **rational**.

```ts
type Frac = { n: number; d: number };        // always gcd-normalized, d > 0
type Pos  = { col: number; frac: Frac };     // col = quarter-note index (integer, boundless, may be negative)
                                             // frac = offset within the column, 0 ≤ frac < 1
```

- Sorting: by `col`, then cross-multiply fractions (`a.n * b.d` vs `b.n * a.d`). Denominators are ≤ 16 × 16 = 256, so plain number math is exact — no BigInt, no floats in the model.
- Durations are also `Frac`, in quarter-note units. A duration may cross column boundaries.
- Utility module `frac.ts`: `normalize`, `add`, `sub`, `cmp`, `mul`, `lt/lte/eq`, `toNumber` (display/render only, never storage).

### 3.2 Subdivision tree

Per **column, per layer**, depth ≤ 2:

```ts
type Subdiv = {
  split: number;                 // 1–16 (1 = whole column, one slot)
  children?: (Subdiv | null)[];  // length === split; null = leaf slot; depth limit 2
};
```

Default (no entry in the map): `{ split: 1 }` — one slot = quarter note.

Example — 16ths with triplet 32nds on the last 16th:
```ts
{ split: 4, children: [null, null, null, { split: 3 }] }
```

**Slot enumeration** (used by rendering, hit-testing, velocity lane, and note quantization): walk the tree producing ordered slots `{ start: Frac, dur: Frac }` within the column. For slot *i* of a `split: s` node spanning `[a, b)`, slot span is `[a + i·(b−a)/s, a + (i+1)·(b−a)/s)`. Max slots per column = 256.

### 3.3 Tempo map & seconds conversion

```ts
type TempoEvent = { pos: Pos; bpm: number };   // sorted; index 0 at col 0 (default 120)
```

`toSeconds(pos, tempoMap)`: piecewise-linear accumulation across tempo segments (quarters ÷ (bpm/60) per segment). Converting to seconds happens **only** in the scheduler; converting to integer ticks happens **only** at MIDI export.

### 3.4 Meter / barlines (v1)

No time signatures in v1. The board is a stream of quarter columns; a subtle heavier gridline every 4 columns purely as a visual anchor. Meter is a v2 concern.

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
  subdivs: Map<number, Subdiv>;     // per-column subdivision, keyed by col; absent = quarter
  order: number;                    // z-order in layer panel and draw order
};

type Project = {
  version: 1;
  name: string;
  tempoMap: TempoEvent[];
  layers: Layer[];
  notes: Note[];                    // storage form; runtime keeps indexes (§4.1)
  activeLayerId: LayerId;
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
- `notesByCell: Map<string, NoteId[]>` keyed by `` `${layerId}:${col}:${pitch}` `` — O(1) hit-testing/toggle.
- Viewport query = binary search on sorted `col` range per visible layer. Rebuild indexes on load; maintain incrementally on edit.

### 4.2 Undo/redo

Command pattern: every mutation is a `{ do, undo }` pair pushed to a stack (cap ~500). Covers note add/remove/move, velocity edits, subdivision changes, layer property changes. Zustand store mutations happen only through commands.

---

## 5. Board & Rendering

### 5.1 Viewport

```ts
type Viewport = { xQuarters: number; yPitch: number; pxPerQuarter: number; pxPerSemitone: number };
```

- Boundless pan in all directions (negative `col` and any MIDI pitch 0–127 allowed; clamp vertical pan to the MIDI range).
- Zoom: horizontal `pxPerQuarter` 24–512; vertical `pxPerSemitone` 8–48. Pinch/ctrl-wheel zooms about the cursor point.
- Initial view: C3 (48) vertically centered, col 0 at the left edge, 96 px/quarter, 16 px/semitone.

### 5.2 Draw pass (per dirty frame)

1. Row shading — white-key rows `#f7f5f0`-ish, black-key rows a few % darker; row for C rows gets a faint label (`C3`, `C4`…) in the left gutter.
2. Column gridlines — quarter lines; heavier every 4th; **subdivision lines for the active layer only** (other layers' grids would be noise).
3. Stones — for each visible layer in `order`, then active layer last: circle of radius `min(pxPerSemitone, slotWidth) * 0.42`, filled white or black by pitch class `{0,2,4,5,7,9,11}` → white; ring stroke in `layer.color` (2px, full alpha for active layer). Duration beyond one slot renders as a rounded lozenge (stone stretched horizontally to `dur` width).
4. Playhead — vertical line, position from `secondsToPos` inverse lookup during playback.
5. Left gutter (pitch labels / drum labels §9.3) and velocity lane (§6.2) are separate canvases stacked in the React layout so they can stay pinned while the board pans.

### 5.3 Performance targets

- 60fps pan/zoom with 5k notes in the viewport, 50k in the project.
- Cull to viewport ± 1 column margin. Skip subdivision line pass when `pxPerQuarter < 48`.

---

## 6. Velocity

### 6.1 Resolution order

Effective velocity for a note:

```
note.vel  →  layer.colVel.get(note.pos.col)  →  layer.defaultVel
```

Column-level velocity is **time-linear per layer**: all notes in a column stack share it unless individually overridden. This satisfies: layer default → column default → per-note override in a chord.

### 6.2 Velocity lane

- Fixed strip at the bottom of the viewport (~96 px), horizontally locked to the board's pan/zoom.
- Shows the **active layer only**, in its layer color.
- One vertical bar per **slot** of that column's subdivision (enumerated from the layer's `Subdiv`), height = effective velocity /127.
- Slots containing notes draw solid; empty slots draw a faint ghost bar at the would-be effective velocity (so you can pre-shape dynamics).
- Drag on a bar → sets `colVel[col]` when the column has one slot, or a **slot-level refinement**: v1 simplification — dragging a bar sets `vel` on all notes in that slot; dragging across bars paints. Alt-drag on a single stone's bar segment sets only that note (chord-internal override). If a column has both overridden and inherited notes, the bar renders split (segments per distinct velocity).
- Numeric entry via inspector for precision (0–127).

---

## 7. Interaction (v1)

| Gesture | Action |
|---|---|
| Click empty slot | Place stone: active layer, slot duration, inherited velocity |
| Click stone (active layer) | Remove it |
| Drag stone | Move (quantized to slots vertically/horizontally); Alt-drag duplicates |
| Drag stone's right edge | Lengthen/shorten duration in slot increments |
| Right-click / long-press column header | Subdivision editor for that column (active layer): pick split 1–16; then optionally tap a slot and pick a nested split 2–16 |
| Space | Play/stop from playhead |
| Drag on ruler | Set loop region; click ruler clears |
| Middle-drag / two-finger drag / space+drag | Pan |
| Ctrl+wheel / pinch | Zoom |
| Ctrl+Z / Ctrl+Shift+Z | Undo/redo |
| 1–9 keys | Quick-set active column split under cursor |

Notes placed where no subdivision exists land on the quarter slot. Changing a column's subdivision **re-quantizes nothing** — existing notes keep their exact rational positions; they may sit off the new grid (render slightly desaturated ring to flag "off-grid for this layer's current subdiv").

---

## 8. Audio Engine

### 8.1 Scheduler

Classic lookahead pattern (Chris Wilson "A Tale of Two Clocks"):

- `setInterval` at 25 ms; each tick, schedule everything with onset in `[now, now + 0.1 s)` against `AudioContext.currentTime`.
- Per audible layer, maintain a cursor into `notesByLayer` (sorted); advance as scheduled. Effective velocity resolved at schedule time (§6.1) → smplr `velocity`.
- `sampler.start({ note: pitch, velocity, time, duration: durSeconds })` — duration converted through the tempo map (a note spanning a tempo change gets its true elapsed seconds).
- Play/stop/seek: stop cancels scheduled sources (track handles via smplr's stop or per-note stop tokens); seek rebuilds cursors by binary search.
- Loop: when the schedule window crosses `loop.end`, wrap cursors to `loop.start` and continue scheduling with a time offset.
- Playhead UI reads `AudioContext.currentTime` in the rAF loop and inverts the tempo map — never trust `setInterval` timing for visuals.

### 8.2 Latency & lifecycle

- Create `AudioContext` on first user gesture. `latencyHint: 'interactive'`.
- Audition on placement: when a stone is placed/moved, fire the note immediately at effective velocity (nice feedback loop; toggleable).

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
  "samples": { "48": "C3.ogg", "60": "C4.ogg", "72": "C5.ogg" },  // note → URL (smplr Sampler map)
  "baseUrl": "https://…/piano/"
}
```

Pitched instruments load into smplr `Sampler` (or `Soundfont` for GM placeholders in dev). Zone/stretch between sampled pitches is smplr's job.

### 9.2 Drum kits

```jsonc
{
  "id": "ph-kit-1",
  "name": "PepperHorn Kit",
  "kind": "kit",
  "gmBasis": true,                 // rows follow GM drum map numbering
  "pieces": [
    { "midi": 36, "label": "Kick",   "url": "kick.ogg" },
    { "midi": 38, "label": "Snare",  "url": "snare.ogg" },
    { "midi": 42, "label": "HH Cl",  "url": "hh-closed.ogg" },
    { "midi": 46, "label": "HH Op",  "url": "hh-open.ogg" },
    { "midi": 49, "label": "Crash",  "url": "crash.ogg" }
  ]
}
```

The manifest is the **single source of truth** for both sound and board semantics.

### 9.3 Drum layers on the board

When the active layer's instrument is `kind: "kit"`:

- The left gutter swaps pitch names for **piece labels** at their GM `midi` rows.
- Rows without a mapped piece render dimmed and reject placement.
- Stone color: all black (key-color semantics are meaningless for drums); layer ring as usual.
- Pitch stays a real GM MIDI number internally → export needs no special casing beyond channel 10.

### 9.4 v1 instrument set

Four starter layers: Piano, Guitar, Bass (smplr `Soundfont` GM programs 0 / 25 / 33 as placeholders until curated manifests exist), Drums (smplr `DrumMachine` or a minimal GM kit manifest). Channels 1/2/3/10.

---

## 10. Persistence & Export

- **Project file:** JSON of `Project` (Maps serialized as entry arrays). Autosave to IndexedDB (debounced); manual export/import of `.go.json`.
- **MIDI export (SMF type 1):** choose PPQ per file at export — compute LCM of all denominators present, cap at 960; tuplets that don't divide evenly round to nearest tick **at export only** (the sole place quantization error is permitted). One track per layer, program change from `gmProgram`, kit layers to channel 10, tempo map to meta events. Use `@tonejs/midi` for writing (the library is fine even though Tone.js itself isn't used).
- **Future (v2+):** MEI export. Rational durations + subdivision trees map near-directly onto MEI proportional durations/tuplet elements → straight path into the Verovio pipeline. Design nothing that blocks this; requires no v1 work.

---

## 11. v1 Scope

**In:** boundless board, per-layer nested subdivision (≤2 deep, splits 1–16), stones/rings visual language, layer panel (add/rename/color/reorder/mute/hide), velocity lane with column + per-note override, lookahead playback with loop, tempo (single BPM in v1 UI; tempo *map* in the model), 4 starter instruments, kit row labels, undo/redo, IndexedDB autosave, JSON + MIDI export.

**Out (v2+):** time signatures/meter, tempo-map editing UI, note selection marquee & multi-select ops, copy/paste, MEI export, curated sample library authoring, PixiJS renderer, collaboration, mobile touch polish beyond basic pan/place.

**Open questions (decide during build, none blocking):**
1. Duration model for drums — force one-slot durations on kit layers? (Probably yes.)
2. Off-grid stone flagging UX after subdivision change (§7) — desaturated ring vs. warning dot.
3. Ghost bars in the velocity lane — useful or noise? Ship behind a toggle.

---

## 12. Build Order

**M1 — Time core (no UI).** `frac.ts`, `Pos` ordering, `Subdiv` slot enumeration, tempo map `toSeconds`/inverse. Unit tests: nested 11×13 slot math, cross-column durations, tempo-change conversions. *Everything else stands on this.*

**M2 — Board render.** Canvas viewport, pan/zoom, row shading, gridlines, stones from a hardcoded project. Perf check at 5k visible notes.

**M3 — Editing.** Zustand store + command stack, place/remove/move/resize, subdivision editor, layer panel with visible/audible, indexes.

**M4 — Playback.** Scheduler, smplr GM placeholders, playhead, loop, audition-on-place.

**M5 — Velocity.** Lane rendering, drag painting, per-note alt-drag, split bars.

**M6 — Instruments & kits.** Manifest loader, kit gutter labels, four starter layers wired.

**M7 — Persistence & export.** IndexedDB autosave, `.go.json` import/export, MIDI export with PPQ selection.

Each milestone is independently demoable; M1 ships as a pure library with tests before any pixel is drawn.
