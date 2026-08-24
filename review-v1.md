# go-spec.md v1.0 — Technical Review

Reviewed §1–§12. Verdict: **the architecture is sound and the stack choices are right.**
Canvas2D will hold the perf target, rational time is the correct call, and rejecting
Tone.js is justified. Nothing here changes the shape of the app.

But there are four blockers, all in the foundation (§3/§4/§9), and they must be
resolved *before* M1 — §12 correctly says everything stands on `frac.ts`, and two of
the four are in it.

Findings verified first-hand where marked ✔ (arithmetic run in node, or read from
`node_modules/smplr@1.0.0/dist/`).

---

## Blockers

### B1 — `notesByCell` cannot hit-test or cull long notes (§4.1, §5.2, §7)

The index key `` `${layerId}:${col}:${pitch}` `` records a note only at its **onset**
column. But §3.1 allows durations crossing column boundaries and §5.2 draws them as
multi-column lozenges. So:

- Clicking the body or right edge of a lozenge finds an empty cell → the app places a
  *new* stone on top of the one you clicked. This breaks "click stone → remove" and
  "drag right edge → resize", which is precisely the gesture that lands on the far column.
- The viewport query ("binary search on sorted `col` range", cull to "viewport ± 1
  column") misses notes whose onset is left of the viewport but whose lozenge extends
  into it. **Long notes vanish when you pan right.**

Two independent reviewers hit this from opposite directions (data model, hit testing).

**Fix:** keep the onset index for placement, and maintain a per-layer
`maxDurQuarters` incrementally on add/resize/remove. Hit-test and cull start the scan
at `col − ceil(maxDurQuarters)` rather than `col − 1`. Exact, no interval tree, and the
value stays ~1–8 in practice. On move/resize, delete the old key *before* inserting the
new one — that is the classic index-desync bug and it should be a test.

Also: the O(1) claim is false regardless. The key drops `frac`, so all notes at that
pitch in that column share one bucket, and §7's "changing a subdivision re-quantizes
nothing" means bucket size has no 256 ceiling — it grows with editing history. Store
buckets sorted by `frac` so the scan early-exits.

### B2 — Hit testing must be geometric, not slot-based (§7)

§7 deliberately leaves notes off-grid after a subdivision change. If hit testing
resolves a click to a slot and looks up that slot, **off-grid stones can be seen but
never removed or moved.** They become permanent litter.

**Fix:** hit test against the drawn geometry (is the point inside the stone/lozenge
rect?). Slot resolution is used *only* to decide where an empty-space click places a
new stone. Hit priority must also walk the inverse of draw order (active layer first,
then descending `order`), or you delete the stone underneath the one you clicked.

### B3 — `Frac.add` overflows; the "≤ 256" invariant is wrong (§3.1)

The claim *"denominators are ≤ 16 × 16 = 256, so plain number math is exact"* holds
only for a slot boundary **within one column**. It does not survive addition, and §3.1
contradicts itself two sentences earlier — the "LCM base around 10¹¹" it cites to
*reject* fixed PPQ is the same quantity.

✔ The true invariant (verified): every reachable denominator divides

```
L = 2⁸·3⁴·5²·7²·11²·13² = 519,437,318,400  ≈ 5.19e11
```

This lattice is closed under addition, which is the property worth writing into the
spec. Consequences:

- **`add` genuinely overflows.** A naive `den = b*d` reaches L² = 2.7e23, far past
  2⁵³ = 9.0e15. Reachable well before the extreme: one note extended by one slot
  through five columns split 16×16, 9×9, 5×5, 7×7, 11×11 gives d = 3,073,593,600, and
  `b*d` = 9.4e18 on the *next* addition. Must compute
  `g = gcd(b,d); den = b*(d/g); num = a*(d/g) + c*(b/g)` — never form `b*d`.
- **`cmp` is actually safe** — the original review flagged silent misordering; ✔ that
  is not reachable. Distinct cross-products differ by a multiple of `gcd(d1,d2) ≥
  d1·d2/L`, while the float ulp is `d1·d2/2⁵²`; the gap exceeds the ulp by a factor of
  2⁵²/L ≈ **8,670**. Cross-multiplication always orders correctly for this lattice.
  Reduce by `gcd(d1,d2)` first anyway — it's free, it bounds the product at L, and it
  means the code doesn't depend on a subtle number-theoretic argument holding forever.

**Also missing from `frac.ts`:** `normalize(0)` must return `{n:0,d:1}` (else `0/5` and
`0/1` are distinct and `eq`/dedup/JSON round-trip disagree); `gcd` must carry sign so
`d > 0` always holds after `sub`/`mul`; `dur > 0` should be an enforced invariant.

### B4 — The v1 instrument plan doesn't work against smplr 1.0.0 (§9.4, §9.3)

The spec is written against smplr 0.x. ✔ Read from the installed package:

- **"Soundfont GM programs 0 / 25 / 33" throws.** `SoundfontConfig.instrument` is
  `string` (a gleitz soundfont *name*), not a program number. `{instrument: 0}` throws
  "instrument or instrumentUrl is required"; `{instrument: 25}` throws
  `config.instrument.startsWith is not a function`.
- **`DrumMachine` is not GM-mapped.** ✔ `drumMachineToPreset` assigns
  `midi = 36 + indexInSamplesArray`. So row 38 (Snare) plays `samples[2]`, whatever
  that is. §9.3's "pitch stays a real GM MIDI number internally → export needs no
  special casing" is refuted for `DrumMachine` specifically.
- **`Sampler` has no `baseUrl`.** Flat `buffers` needs absolute URLs. `baseUrl` exists
  only on the preset path, and there the loader *appends* the extension — so §9.1's
  `"48": "C3.ogg"` + baseUrl fetches `C3.ogg.ogg` → 404. Use extension-less map values
  (`"48": "C3"`) with `formats: ["ogg","m4a"]` and you get format negotiation free.
  ✔ Numeric MIDI keys and automatic zone-stretching between sampled pitches are
  confirmed working, so §9.1's core premise stands.
- **Weight:** each gleitz soundfont is a base64-in-JS blob — `acoustic_grand_piano-ogg.js`
  is 2.34 MB. Three pitched placeholders ≈ 7 MB, and `SampleLoader.load` awaits *all*
  samples before `ready` resolves. CORS is open, so no proxy needed.

**Recommendation:** skip the placeholders. §9.2's manifest format is already GM-keyed
and is the single source of truth the spec wants — building 4 small self-hosted
manifests is *less* work than making the placeholders behave, and it deletes a
throwaway code path. This merges part of M6 into M4.

---

## Major

### Audio (§8)

- **M1 — Edits during playback corrupt the scheduler cursor.** An index into a sorted
  array breaks when a note is inserted before it (double-trigger) or the note it points
  at is deleted (skips the next). §7 makes editing-during-playback a first-class
  gesture, so this fires constantly. Fix: make the cursor a **value** (last-scheduled
  `Pos`), binary-search each 25 ms tick — free at this rate. Track scheduled `NoteId`s
  within the window so an edit can't re-fire a committed note.
- **M2 — Loop wrap handles exactly one wrap.** If the loop is shorter than the 100 ms
  lookahead, one tick must emit several passes. Needs a `while`, not an `if`, guarded on
  `loopLengthSec > 0`. Treat `loop.end` as exclusive, and decide whether a note whose
  *duration* crosses `loop.end` is truncated — easy to create in this UI.
- **M3 — `stopId` defaults to the note number.** ✔ `stopId: event.stopId ?? event.note`
  (and `DrumMachine` forces it). So stopping one C4 stops *every* sounding C4 — and a
  repeated pitch on a grid is the common case, not the edge case. Always pass your
  `NoteId` as an explicit `stopId`.
- **M4 — stop-cancellation works only by coincidence.** ✔ smplr has its own internal
  lookahead (`LOOKAHEAD_MS_DEFAULT = 200`). Notes inside it become live Voices that
  `stop()` cancels; notes beyond it sit in an internal queue that `stop()` does **not**
  drain. Your 100 ms lookahead is under 200 ms, so it happens to work. Raise it and
  notes leak. Fix: keep the returned `StopFn` per note, or construct with
  `scheduler: Scheduler(ctx, {lookaheadMs: 0})`. Worth a regression test.
- **M5 — Run the 25 ms timer in a Web Worker.** A playing tab escapes Chrome's
  intensive throttling ("made noises in the past 30 seconds"), but a *silent* stretch
  >30 s or starting playback from a background tab drops to 1 s ticks, which a 100 ms
  lookahead cannot survive. ~20 lines of insurance.
- **M6 — The playhead will lead the sound.** `currentTime` is what the graph has
  rendered, not what's audible. Subtract `baseLatency + outputLatency` (feature-detect:
  `outputLatency` is absent in Safari) and expose a user nudge slider — no formula beats
  that for Bluetooth.

### Rendering (§5)

The 60 fps / 5k-visible target is reachable, but **not by the draw pass §5.2
describes** — naive per-stone `arc`+`fill`+`stroke` is 12–25 ms for 5k, before the
scheduler and GC take their share of the same thread. Realistic render budget is ~10 ms,
not 16.7. These stop being optimizations and become requirements:

- **Bake the glow into a sprite atlas.** `ctx.shadowBlur` is a software path — 5k
  glowing stones is ~200 ms/frame. If §1's glow is literal, it is atlas-only.
- **Sprite atlas for stones** (one `drawImage` each ≈ 2–4 ms for 5k, a 4–6× win),
  keyed on (fill, layer color, radius bucket, active/dimmed). Quantize radius to ~10
  buckets and regenerate on zoom-end.
- **Pan = self-blit.** Pan is pure translation: blit the previous frame offset and
  repaint only the newly exposed strip (~16×1600 px instead of 8.3 Mpx). Biggest single
  win, because pan is the dominant gesture.
- **Playhead on its own overlay canvas.** As written it moves every frame, so the dirty
  flag is set every frame and the whole board repaints at 60 fps for the entire song
  with zero edits.
- **Batch all gridlines into one `Path2D`, one `stroke()`** — flattens the worst case
  (33 cols × 256 slots) from ~12 ms to ~0.5 ms. Add the guard §5.3 lacks: skip subdiv
  lines when slot width < 4 px, not just when `pxPerQuarter < 48`.
- **Cap backing store at `min(devicePixelRatio, 2)`**; snap line coords to device pixels.

✔ Also: 5k visible notes only occurs at minimum zoom (24 px/quarter × 8 px/semitone →
7,571 cells; at the default 96×16 the viewport holds 969). At that zoom stone radius is
**3.4 px and the 2 px layer ring is sub-pixel** — invisible. Define an explicit LOD:
below radius ~4 px drop the ring and fill the stone in the layer color. Cheaper *and*
more legible, which makes the stated worst case the easiest case.

Three stacked canvases need: one rAF owner (not three, or they tear during pan), one
shared `Viewport` + `worldToScreen`, and per-canvas fractional-device-pixel correction
(under browser zoom, `rect.left * dpr` is fractional and *differs per canvas*, so lane
bars land up to 1 px off the board's columns).

### State (§2)

"A note edit must never trigger a React render" is achievable only if the boundary is
**structural, not disciplinary**: a `zustand/vanilla` store for notes + indexes +
viewport that exports **no React hook at all**, and a separate React store for layer
metadata, transport, and inspector. With one store, a single stray
`useStore(s => s.notes.length)` silently breaks the invariant and nothing fails loudly.

Two counters, not one: `renderVersion` (every mutation, incl. intermediate drag frames
— the canvas dirty flag) and `commitVersion` (command commit / drag end — what React
watches). One counter forces a choice between 60 Hz React renders during drags and a
stale inspector after them.

Viewport must live in the vanilla store — pan/zoom writes 60×/sec.

### Export (§10)

The PPQ rule `min(LCM, 960)` is wrong in both directions:

- **960 is exact for none of the headline tuplets.** `960 = 2⁶·3·5`, so splits 7, 9,
  11, 13 are all inexact — a plain 9-tuplet, not even nested, already is.
- **The cap discards available exactness.** 13-in-11 → denominator 143; `960/143` is
  inexact but `143 × 6 = 858 ≤ 960` is exact. The rule picks the worse number.
- **960 is not the format limit.** SMF division is 16-bit with bit 15 clear → **32767**
  (the spec's own parenthetical is right; the cap contradicts it). At 32767, 16ths +
  triplets + 11 + 13 (`L = 6864`) is **fully exact**.
- **The real damage is duration, not onset.** The smallest legal slot, 1/256 quarter, is
  3.75 ticks at 960 → rounds to 4, a **6.7 % duration error** on the shortest notes.
  Onset error is 0.24 ms @ 120 BPM — inaudible.

```
L = lcm over ALL denominators (onsets, durations, pos+dur ends, tempo positions)
if L <= 32767:  ppq = L * floor(32767 / L)          // exact, max resolution
else:           ppq = largest divisor of L <= 32767 // enumerate 2^a3^b5^c7^d11^e13^f
                fallback 30240 = 2^5·3^3·5·7        // exact for every split but 11 and 13
```

Round **absolute** ticks then difference for deltas — never round deltas, or the
0.45-tick error accumulates to ~half a quarter note over 1000 events. Tempo meta is
24-bit µs/quarter → clamp BPM to ≥ 3.576.

---

## Undefined behaviour to nail down before coding

§7's table has gaps whose failure modes are destructive:

1. **Click vs drag is undefined** — a 2 px twitch during an intended move *deletes* a
   note. Need a 4 px (mouse) / 10 px (touch) threshold that latches permanently, plus
   Escape to cancel an in-flight drag.
2. **There is no seek gesture.** Space plays "from playhead"; §8.1 implements seek;
   nothing ever *moves* the playhead. Click-on-ruler is already bound to clearing the loop.
3. **No trackpad pan.** Plain wheel appears nowhere, and "two-finger drag" emits `wheel`,
   not pointer events — so laptops currently have no pan gesture. Need wheel = vertical,
   shift+wheel = horizontal, ctrl+wheel = zoom, with `{passive:false}`.
4. **Space play/stop vs space+drag pan** — play fires on keydown, so arming pan starts
   playback. Recommend dropping space+drag. Also filter `e.repeat` (autorepeat toggles
   transport dozens of times).
5. **1–9 reaches 9 of 16 splits.** No path to 10–16, and no stated depth. Suggest
   `0` = 10, `Shift+1..6` = 11..16.
6. **Alt-drag is bound twice** (duplicate on board, per-note velocity in the lane) and
   GNOME/KDE consume Alt+drag for window moves. Move duplicate to Ctrl/Cmd-drag.
7. **"Column header" is never drawn.** §5.2's draw pass has no ruler or header band,
   but §7 binds subdivision to a "column header" and loop to "the ruler". Same strip or two?
8. **Clicking a non-active layer's stone** is undefined. Recommend pointer-transparent,
   with double-click promoting that layer to active.
9. **Drag from an empty slot** is undefined — recommend paint (big win on drum layers).
10. **One command per drag**, not one per quantize step — §4.2 as written makes Ctrl+Z
    rewind a drag one slot at a time.
11. **Right-edge resize zone overlaps the whole stone** at min zoom (6 px zone vs 3.4 px
    radius) — click-to-remove becomes unreachable. `edgeZone = min(6, width*0.25)`.
12. `Subdiv` is unboundedly recursive — nothing in the type encodes "depth ≤ 2", so an
    imported file can nest deeper and blow the 256-slot bound. Split into two nominal
    levels and validate `children.length === split` on import.
13. **Pos canonicalization needs floored div-mod, not `%`.** JS `%` truncates:
    `(-1) % 3 === -1`, so a leftward drag yields `{col:0, frac:-1/3}` instead of the
    canonical `{col:-1, frac:2/3}`. Same instant, different `notesByCell` key, and `cmp`
    orders them wrongly against every neighbour. Route every mutation through one
    `Pos.canonical()` chokepoint.

---

## Build order

§12 is broadly right. Adjustments:

- **Pull the §4.1 indexes and the command interface into M1/M2.** Both are pure and
  unit-testable, and M2's "perf check at 5k notes" against a hardcoded project measures
  a fake data path — the real frame cost includes per-layer viewport queries.
- **Move `.go.json` import/export to right after M3** (~50 lines). It de-risks `Map`
  serialization and index-rebuild-on-load — the likeliest late-breaking schema bug — and
  gives every later milestone real fixtures. IndexedDB autosave and MIDI stay at M7.
- **Missing milestones entirely:** the ruler/column-header band (M3 and M4 both need it,
  nothing draws it), the left gutter canvas (belongs in M2, currently surfaces
  implicitly at M6), the inspector (§2 and §6.2 both depend on it), the transport UI,
  off-grid stone flagging, and the AudioContext gesture-unlock UX.
- **`effectiveVelocity()` (§6.1) is needed by M4's scheduler**, one milestone before M5.
  Make it a pure function in M3/M4; M5 becomes only the lane UI.
- **No test strategy past M1**, though most of what follows is testable headless:
  `pointToSlot()` as a pure module (M2/M3); a property test on the command stack (random
  sequence + N undos returns to the initial project — catches nearly every undo bug);
  scheduler tests against an injected fake clock (M4); MIDI export round-trip (M7);
  golden-image canvas snapshots at fixed viewport/DPR (M2).
- **Record M2's benchmark number and re-run it every milestone** — the 5k target will
  quietly rot as the playhead, lane, and subdiv lines add per-frame work.
- **Open question #1 (one-slot durations on kit layers?) affects M3's resize gesture**,
  not M6. Decide before M3.

---

## Spec text to correct

- §3.1 — delete "denominators are ≤ 16 × 16 = 256". Replace with: *slot-boundary
  denominators ≤ 256; derived denominators divide L = 2⁸·3⁴·5²·7²·11²·13² ≈ 5.19e11, a
  lattice closed under addition. `add` must reduce by gcd before multiplying.*
- §3.3 — say "piecewise-**constant** tempo ⇒ piecewise-linear seconds". As written,
  "piecewise-linear" invites a v2 ramp implementation to inherit the wrong formula (a
  true ramp is `t = 60·Δq·ln(b₁/b₀)/(b₁−b₀)`, with an exponential inverse).
- §4.1 — drop "O(1)"; document the maxDur scan window.
- §5.3 — restate the perf target as conditional on atlas + line batching + pan blit +
  playhead overlay, with a scripted frame-time number rather than a prose target.
- §9.4 — replace the Soundfont/DrumMachine placeholders with four §9.2 manifests.
- §10 — replace the 960 cap with the PPQ rule above.
