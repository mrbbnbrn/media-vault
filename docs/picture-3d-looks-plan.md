# Plan: five new 3D looks for pictures (2026-11-23)

Status: **plan, waiting for the user's "go".** Nothing built yet.

Picks from `3d methods - checked.md`: **22** Focus (bokeh), **23** Depth light, **24** Border fill, **25** Wiggle
(+ save as GIF), **6** More layers. All of them are **pictures only** and **off by default**, each with its own switch.
No red/cyan, side-by-side or VR features, and no other exports (the user has no glasses or headset).
GIFs and videos show them greyed out with the hint "pictures", like Lift-off today.

---

## 0. Shared groundwork (needed before the looks)

| # | Piece | Why | Size |
|---|---|---|---|
| G1 | **Second drawing pass** in `Depth3D.tsx`: draw the 3D picture into an off-screen texture (colour + the depth of what was hit), then a final pass on top | Focus blur needs the finished 3D picture to blur; the exports read it back | M |
| G2 | **Ease in / ease out for looks** | The 3D layer lies exactly over the plain picture and must start and end looking exactly like it (no jump). Blur, light and stereo colours must ease in after the 3D starts and ease out before it ends, before a slideshow transition and before zooming | S |
| G3 | **Still render** of one camera pose to pixels | "Save wiggle as GIF"; also the tests | S |
| G4 | **Saving the new layers** in the vault | Border fills and extra layers are saved like Layered 3D's plate: `derived` kind `plate`, in the same MVL1 format, with new tags (`…_b8` border, `…_L3k2` layer 2 of 3). **No schema change, no vault format change** | S |
| G5 | **Delete 3D data / idle preparing / "Work them all out again"** know the new tags | Each one listed and named; prepared while idle like the plate | S |
| G6 | **3D ▾ menu in groups**, because it grows from 8 to ~13 entries: *Motion* (incl. Wiggle) · *Subject* · *Looks* (Focus, Depth light) · *Edges* (Border fill, Layered 3D, More layers) · *Save* | Stays readable | S |
| G7 | **3D photo settings window**: new sections *Looks*, *Edges and layers*, *Wiggle*, every setting with its short explanation | Your rule | S |
| G8 | **Multi-screen guard**: a setting "Heavy 3D looks in multi-screen" (off by default). With it off, panels use cheaper focus (fewer samples) and 2 layers at most | Many WebGL panels at once could stutter | S |
| G9 | Browser demo mocks for the fill models, so everything can be checked in Chromium | Testing | S |

Settings live where the 3D settings live now (`ViewerSettings` in `apitypes.ts` + `config.rs` serde defaults +
`normalize`), global, not per folder (same as the other 3D switches).

---

## 22. Focus (depth of field, "bokeh")

**What you see:** parts of the picture far from the focus go softly out of focus, like a real camera lens.
The sharp part can move: a **focus pull** in slideshows, or focus that follows the mouse.

**Switch:** 3D ▾ → *Focus*.

**Settings (3D photo settings → Looks):**
| Setting | Choices | Explanation shown |
|---|---|---|
| Focus on | **Subject** (outline's depth, else the middle of the picture) · Under the mouse · Nearest face (if face data exists) | What stays sharp |
| Focus pull | Off · **Background → subject at the start** · Back and forth during the stay | Moves the sharp part, like a film camera |
| Pull speed | 0.5–3 s | How long one pull takes |
| Blur strength | 0–100 % (default 40 %) | How soft the out-of-focus parts get |
| Sharp depth range | narrow – wide | How deep the sharp zone is |
| Bokeh look | **Soft** · Round lights (bright spots bloom into discs) | Round lights is the "lens" look; costs a little more |
| Miniature (tilt-shift) | on/off | Sharp band in the middle, both ends blurred: things look like toys |

**How:** G1 second pass. A variable-size blur that reads each pixel's own depth (about 24–32 samples, half size on big screens).

**Edge cases:**
- **Halos:** a sharp subject must not smear onto the blurred background, and the background must not leak into the
  subject's edge. Samples nearer than the centre are handled by the near-over-far rule. With an outline, its clean
  edge decides at the rim.
- **Focus on a near thing with a blurred foreground before it:** the foreground blur may spread over the sharp part
  (that's what real lenses do). Kept, but limited.
- **No depth map yet:** no blur. It eases in when the depth arrives, never pops.
- **Flat pictures** (documents, screenshots, depth almost flat): blur would look like a mistake. If the depth range is
  tiny, Focus stays off for that picture.
- **Picture edges:** samples are clamped inside the picture (no dark rim).
- **4K / high-DPI screens:** blur runs at half size and is scaled up. The blur size follows the picture's drawn size, not screen pixels.
- **Under the mouse:** focus eases to the new depth (~0.3 s) and doesn't flicker on hair or edges (uses the depth averaged over a small spot).
- **Slideshow transitions:** blur eases out before the transition (G2).
- **Viewer zoom:** as today, the 3D layer steps aside when you zoom. Focus goes with it.

**Size:** M.

---

## 23. Depth light

**What you see:** a soft light that shapes the picture from its depth: gentle highlights on surfaces facing the light,
slight shade in creases. When the camera moves, the light shifts across the picture a little, which adds depth.

**Switch:** 3D ▾ → *Depth light*.

**Settings (3D photo settings → Looks):**
| Setting | Choices | Explanation shown |
|---|---|---|
| Light follows | **The camera** (default) · The mouse · Slow sweep · Fixed side (+ which side) | Where the light comes from |
| Strength | 0–100 % (default 30 %) | How strong the highlights and shade are |
| Crease shade | 0–100 % (default 30 %) | Darkens corners and gaps a little |
| Warmth | cool – neutral – warm | Light colour |
| Softer on the subject | on/off (default on, needs the outline) | Keeps faces from getting shiny or hollow-eyed |

**How:** shader only. Surface directions are worked out from the depth map (smoothed first, once per picture, in the window).

**Edge cases:**
- **Noisy depth** gives blotches or stripes: the depth is smoothed before the directions are worked out, and the light
  is limited where the depth is unsure (fine noise).
- **Depth jumps** (subject/background edge) would make a bright line: steep jumps count as "no surface", no light there.
- **Overall brightness stays the same** (light adds and shade takes away in balance), so the picture never just gets darker.
- **Very dark or night pictures:** highlights are capped so they don't look painted on.
- **Faces:** crease shade makes eye sockets look hollow → *Softer on the subject*.
- **Start/end:** eases in from no light (G2).
- **Sky and flat areas:** face the camera, so no change.

**Size:** S.

---

## 24. Border fill (wider moves without zooming in)

**What you see:** today the picture is **enlarged** while it moves in 3D, so its edges never show. You lose a strip
around the picture, and big moves need a lot of zoom. Border fill paints a thin border around the picture (with the
same fill model as Layered 3D), so the picture can move with **less zoom**, or **move further** at the same zoom.

**Switch:** 3D ▾ → *Border fill*.

**Settings (3D photo settings → Edges and layers):**
| Setting | Choices | Explanation shown |
|---|---|---|
| Border size | 4–15 % (default 8 %) | How much is painted around the picture |
| Use it for | **Less zoom (keep the framing)** · Bigger moves (switchable any time; also in 3D ▾ next to the switch) | What the extra room is spent on |
| Fill | shared with Layered 3D (Simple / MI-GAN / LaMa) | Who paints the border |

**How:** the picture is placed in the middle of a larger canvas, the ring around it is filled (one fill call). Depth
is extended outwards from the edge. With Layered 3D on too, the **hole behind the subject and the border are filled
in the same call** (cheaper, matching). `framePose` learns how much spare room there is, so it zooms less.

**Edge cases:**
- **Pictures with their own border** (black bars, letterbox, white frame, screenshots with a plain edge): painting
  past a frame looks wrong. Plain one-colour edges are detected, and the border is then simply that colour (no model).
- **Screenshots, text, documents:** the fill model invents garbage text. Detected as "flat depth + hard edges" → no
  border for that picture (the zoom works as today).
- **Faces cut by the picture edge:** a fill model paints half-faces badly. The border is kept thin (it's only seen
  while the camera swings), and with an outline, a subject touching the edge gets a thinner border on that side.
- **Very wide or tall pictures** (panoramas): border size is measured on the short side, so the long sides don't get a huge strip.
- **"Fill the screen" layouts** (multi-screen cover modes) already crop the picture: no border needed there, so none is made.
- **Rotated pictures** (`?r=` in the address): saved and found under the item, not the address.
- **The fill is a little softer than the photo:** only the outer few percent, and only while the camera swings out.
- **Fill model not installed:** Simple is used, with the usual hint.

**Size:** M.

---

## 6. More layers (Layered 3D, extended)

**What you see:** today Layered 3D cuts the picture into two: the subject + a filled background. With more layers,
the picture is cut at **every big depth jump** (for example, a person, a table behind them and a wall), and each
layer behind is filled where the nearer one covered it. Moving the camera then shows clean background behind
*every* near thing, not just the subject. Less stretching.

**Switch:** its own: 3D ▾ → *More layers* (user's choice). It works with or without Layered 3D: with More layers
on, the picture is drawn in layers either way (Layered 3D's entry then shows "included in More layers"). It doesn't
need the outline model; when the outline is there, the subject is always one of the cuts.

**Settings (3D photo settings → Edges and layers):**
| Setting | Choices | Explanation shown |
|---|---|---|
| Layers | Up to 3 · **Up to 4** | The most depth layers the picture is cut into |
| Cut at | small – big depth jumps (default medium) | Smaller = more cuts, slower to prepare |
| Fill | shared | Who paints behind each layer |

**How:** the depth map is searched for real jumps (where depth changes suddenly, not slopes), giving up to 3–4 layers.
The subject outline, when there, is always one of the cuts. Each farther layer gets its hidden part filled (one fill
call per extra layer). The shader marches through the layers front to back and shows the nearest one hit.
Layers are packed into one texture (WebGL 1 has few texture slots).

**Edge cases:**
- **Slopes** (a floor or a road going into the distance) have no jump. They must **not** be cut, or a seam appears.
  Only sudden jumps count.
- **Hair, branches, fences** make hundreds of tiny jumps: tiny bits are ignored (minimum area), cuts are grown and
  feathered a little, as the outline is today.
- **No clear jumps:** falls back to two layers (today's Layered 3D: subject + filled background; without an outline,
  the nearest clear part).
- **Fill quality behind big near things:** a fill model guesses. Bigger guesses look smeary, so the camera reach is
  not increased because of layers.
- **Lift-off and 3D only on the subject:** the subject stays its own layer, as today.
- **With Border fill:** the farthest layer gets the border.
- **Preparing time:** 1 extra fill per layer (LaMa on the card: well under a second each; on the processor: a few
  seconds). Prepared while idle and saved, so it's paid once.
- **Memory:** up to 4 layers at 1600 px is ~40 MB on the card per picture shown → layers capped at 1200 px; multi-screen
  guard (G8) limits panels to 2.
- **Drawing cost:** 14 steps × layers per pixel. Measured in Chromium; if a 4K screen drops frames, the step count
  goes down for far layers.

**Size:** B.

---

## 25. Wiggle (+ save it as a GIF)

**What you see:** in the viewer (and slideshows), the camera **jumps** between 2–4 viewpoints instead of gliding:
the "wigglegram" look of old 3D film cameras. Then **Save wiggle as GIF** puts exactly that motion, as you see it,
into a GIF in the same folder.

**Where:**
- 3D ▾ → *Wiggle* (a switch in the Motion group; turning it on picks the Wiggle shape for the gentle motion, turning
  it off goes back to the shape you had). Also offered in 3D photo settings → Shape.
- 3D ▾ → *Save wiggle as GIF* (shown while Wiggle is on, pictures in the vault only). Saved next to the original,
  encrypted like everything else, Ctrl+Z undoes it, named like other copies (`… wiggle.gif`).

**Settings (3D photo settings → Wiggle):**
| Setting | Choices | Explanation shown |
|---|---|---|
| Views | 2 · **3** · 4 | How many viewpoints it jumps between |
| Speed | 3–8 per second (default 5) | How fast it jumps; above 8 is capped (flashing) |
| Order | **Back and forth** (1-2-3-2-1) · Round (1-2-3-1-2-3) | The order of the views |
| Direction | **Sideways** · Up and down · Diagonal | Which way the viewpoint moves |
| Smooth step | off · a little | A short glide between views instead of a hard jump |
| GIF width | 480 · **640** · 800 px | Size of the saved GIF (bigger = larger file) |

How strong the wiggle is follows the 3D amount you already set.

**How:** the still render (G3) draws each view with every look that's on (Layered 3D, More layers, Border fill,
Focus, Depth light), then the GIF maker's encoder (`gifenc`, same as Make a GIF) writes one loop with the same
order and speed as in the viewer.

**Edge cases:**
- **Flashing:** speed capped at 8 per second, with a short note next to the setting.
- **What you see = what's saved:** same views, order, speed and looks. Lift-off's breathing/sway is frozen in the GIF
  (the views must differ only by viewpoint), and the focus pull is held at its end point.
- **Mouse 3D on at the same time:** the wiggle wins while it's on (the mouse lean pauses), else they'd fight.
- **3D to the beat:** a beat pushes on top, as with the other shapes; never in the GIF.
- **Depth not ready yet:** the views would be identical; Save waits for the depth (and the layers) and says so.
- **Pictures outside the vault** (`local://`): Save is greyed with the hint "only for pictures in the vault".
- **Vault without encryption:** saved as a normal file there, like other copies.
- **Colours:** a GIF has 256 colours; the palette is made from all views together so it doesn't flicker between frames.
- **Size:** a 640 px, 3-view GIF is roughly 0.5–1.5 MB; an estimate shows before saving.

**Size:** S–M.

---

## The user's decisions (2026-11-23)

1. Depth light: **follows the camera** (default); the other choices (mouse, slow sweep, fixed side) stay as options.
2. **No red/cyan, side-by-side or VR.** Wiggle shows in the viewer; the only save is **Save wiggle as GIF** to the same folder.
3. More layers: **its own switch**.
4. Border fill: **both**, switchable (less zoom / bigger moves).

## Order and size

G1–G9 groundwork (M) → 23 Depth light (S) → 22 Focus (M) → 24 Border fill (M) → 6 More layers (B) →
25 Wiggle + Save as GIF (S–M, last, so the GIF includes all the other looks).

Total: about a big day's work of building, then one push → one release.

## Files (expected)

- Window: `components/Depth3D.tsx` (passes, shader), `depth.ts` (framePose spare room, Wiggle shape),
  `plate.ts`, `platemath.ts`, `layers.ts` (border, layer cuts), new `depthlook.ts` (focus/light maths),
  new `ldi.ts` (layers), new `wiggle.ts` (views, order, GIF), `prepare.ts`, `components/Player.tsx` (menu),
  `components/DepthSettings.tsx` (settings), `components/Delete3DData.tsx`, `apitypes.ts`, `presets.ts`,
  `apimock.ts`, tests for each new maths file.
- Backend: `config.rs` (new setting fields with defaults). No new commands expected (the GIF save reuses `addFileBytes`;
  fills reuse the inpaint call). No schema change, no vault format change, no wire change.

## How it will be checked

tsc, vitest (new unit tests: layer cuts on synthetic depth, border geometry + framePose, focus/light maths, wiggle
order/timing), the shaders and exports in Chromium via the browser demo, then CI (Rust + Windows). The real app and
the look on your photos: only you can judge; I'll say exactly what was and wasn't tried.

---

## As built (2026-11-23, Claude Code on the user's PC)

**Status: built.** Files: `depthlook.ts` (light/focus/wiggle/border maths), `layersmath.ts` (layer cuts, layers,
coverage, border canvas), `lookworker.ts` + `looklayers.ts` (made off the window's thread, kept, saved),
`wiggle.ts` (the GIF), `components/Depth3D.tsx` (shader, blur pass, capture), `components/Player.tsx` (3D ▾,
Save wiggle as GIF), `components/DepthSettings.tsx` (Looks / Edges and layers / Wiggle), `depth.ts` (framePose
border room), `prepare.ts` (Prepare 3D data also makes Border fill and More layers), `derived.ts` (labels),
`Delete3DData.tsx`, `apitypes.ts`, `config.rs` (settings + clean-up + test).

Changes from the plan:
- **No multi-screen guard (G8):** 3D never runs in multi-screen panels (they are "compact"), so the setting would
  have done nothing. Dropped.
- **Wiggle** is a switch in 3D ▾ (Motion group), not a motion shape; it wins over the gentle motion and the 3D mouse.
- **Save wiggle as GIF**: no dialog; the 3D ▾ entry shows about how big the GIF will be, the message after saving
  says the real size.
- **More layers + Layered 3D both on:** More layers draws the background; Layered 3D's clean subject layer is drawn on top.
- **No clear jumps and no subject:** drawn as usual (no layers), instead of "two layers".
- **Border fill and Layered 3D** are filled in separate calls (not one shared call): simpler, each saved on its own.
- **Focus on a face** is "The biggest face" (from the picture's face data; else the subject).
- Found while testing on a generated scene and fixed: the depth light drew a bright rim and a dark halo along depth
  jumps (now no light or crease shade near jumps); More layers still stretched near things' edges (each layer is now
  marched with its own depth carried out past its edge, the nearest layer included).
- Saved data: Border fill and More layers go into `derived` kind `plate` with their own tags (`…_b8_lama`,
  `…_m4m_simple_l<n><key>_<j>`); no schema or vault format change. Saved only when made with the fill named in the tag.
- Needs 10 texture units (most cards have 16); with fewer, Border fill, More layers and Focus stay off.

Checked: `tsc`; 630 window tests (27 new: light texture, focus pull, light direction, wiggle order/timing, border
room/framePose, layer cuts incl. slopes/slivers/subject, layer bands, coverage, border canvas, saved labels);
`config.rs` test added (Rust not compiled on this PC: CI). In Chromium (the app's browser demo can't show pictures
without its media server, so a throwaway test page drew the 3D on a generated scene): Focus blur, Depth light,
More layers (stretching gone at the edges), Border fill (bigger moves, less zoom, painted edge), Wiggle capture;
the 3D photo settings window. **Not tried in the real app or on real photos yet**, nor with LaMa / MI-GAN fills.

### Fix after the user's first try (2026-11-23, later)

The user saw More layers leave the background behind near things unfilled. Found on depth maps with soft edges
(as real depth models make them; the generated test scene had hard ones):
- **A soft jump became thin extra layers** (a rim round a person: 3–4 layers instead of 2), and their filled band,
  pulled from the rim, covered the revealed background with smeared edge colours. Each jump's two sides are now read
  across its whole ramp (the farthest and nearest depth within ~2 % of the picture), so the ramp votes for one cut.
- **The cut sat off-centre on soft edges** (one level shared by every jump it splits), leaving a rim of the near thing
  on the far layer. Each pixel on a ramp is now split at that jump's own middle.
- **The fill only reached the 7 % band** behind near things; a big camera move (Bigger moves, strong 3D) could see past
  it to a copy of the near thing. The colour is now filled everywhere behind nearer things (right along a jump-free
  meeting the picture's own pixels stay, so no seams). Small bits are merged until none are left.
- Saved layers get a new tag part (`…_l<n><key>r2_<j>`): ones saved before this fix are not read (made again).
Checked: 2 new tests (fail on the old code), 631 window tests, tsc. Not tried in the real app yet.

### Second fix: smudge trails (2026-11-23, evening)

The user's photo (Layered 3D + More layers) showed horizontal smudge trails beside the shoulder and hand; plain
Layered 3D was clean. Cause: each layer took its depth straight from the depth map right up to the cut, so the far
layer kept the lower half of the soft jump's ramp and the near layer the upper half. A tilted edge stretches into
streaks when the camera moves, and the far layer's filled band, pulled from the top of its half-ramp, floated
halfway to the near thing (measured on a soft test edge: far layer 62 → ~95 at the edge, fill at ~85; near layer
170 → ~112).
- `planLayers` now marks the ramps (`plan.edge`: a big depth change within R and another layer within 3R).
- `composeLayer` never reads depth there: the layer's own flat depth is carried over its ramp, and the band behind
  nearer things is pulled from flat ground only. Now far 62 and near 170 all the way across.
- Saved layers' tag part `r2` → `r3` (made again).
Checked: 1 new test (fails on the old code), 635 window tests, tsc. Not tried in the real app yet.

### 2026-11-27: More layers and Depth light removed at the user's request

The user didn't like them. Removed completely: their switches in 3D ▾, their settings in 3D photo settings, the
config fields (`depthLight*`, `depthMulti*`; old config files still load, the keys are ignored), the shader code
(the layers' march, the light block, texture units 7–8; the depth texture is plain luminance again), the depth
texture's facing/crease channels (`depthlook.ts` `depthTexture`, `lightDir`, `leanOfShift`, `lightTint`), More
layers' maths and worker jobs (`layersmath.ts` `planLayers` … `planKey`, `looklayers.ts` `layersFor`, `lookworker.ts`
`plan/layerHole/layer/coverage/pack/unpack`) and its preparing in Prepare 3D data, plus their tests. Focus, Border
fill, Wiggle (+ Save wiggle as GIF), Layered 3D and Lift-off stay as they were.
**Saved More layers deleted:** once per library, after unlock, in the background (`derived.rs`
`clear_more_layers_once`, marked done by the library setting `cleanup:morelayers-2026-11`, logged in
diagnostics.log). It matches only More layers' tag shape
`<depth>@<side>~<soft>_<outline|nomask>_e<edges>_m<3|4><s|m|b>_<fill>_l<n><key>[r2|r3]_<j>` (all three generations);
Layered 3D / Lift-off and Border fill plates are kept (unit tests with real-looking tags of each). Delete 3D data no
longer lists More layers groups (`derived.ts` `isMoreLayersTag`).
