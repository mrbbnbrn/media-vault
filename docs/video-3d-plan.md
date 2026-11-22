# Prepared 3D for videos and GIFs: plan

Status: **built 2026-11-22** (approved with "go" the same day; §8 "As built" says where it differs from the plan).
Answers: unprepared = flat + Prepare button (live video depth removed); prepare **only when asked** (no idle or
automatic preparing, GIFs included). Media Vault only; no phone protocol change.

## 1. What you get

- Every 3D feature works on videos and GIFs, the same as on pictures: **depth (any model, Best included), sharper
  edges, Lift-off, 3D only on the subject, Layered 3D (Simple / MI-GAN / LaMa fill)**.
- A video or GIF is **prepared once in the background**, then plays with 3D smoothly: every frame has its own data,
  matched to the exact frame on screen. No live model work while playing, no lag, no sound delay.
- Prepared data is saved encrypted in the vault, so it's ready the next time too.
- **Settings → AI & 3D → Saved 3D data:** pictures and videos/GIFs shown apart (count + size), with a separate
  **"Delete all 3D data for videos and GIFs"** button.
- The old live video depth and its "Delay videos slightly" option are removed.

## 2. How it looks to you

| Where | What |
|---|---|
| Viewer, on a video or GIF | **Prepare 3D** button. Before it starts: estimated time and size. While it runs: progress in the jobs ring, with Stop. |
| Right-click a video, GIF, selection, folder or person folder | **Prepare 3D**, **Delete 3D data…** (in the one shared action list) |
| Settings → AI & 3D → Saved 3D data | Pictures: count + size (as today). **Videos and GIFs: count + size, "Delete all 3D data for videos and GIFs"** (asks first, says it can't be undone and how much space comes back). |
| Settings → AI & 3D → Videos and GIFs (new, each with its explanation) | Frames: every frame / every 2nd frame (half the time, slightly less exact on fast motion) · 3D detail size (smaller = faster, smaller files) · Calmer camera on videos |
| A video or GIF with 3D on but not prepared | Plays flat, with a "Prepare 3D" hint. Nothing starts by itself. |

Prepared data follows the models chosen in the 3D settings. Change a model and the video plays with its older
data (a small note says which models), until you prepare it again.

## 3. How it works

**Preparing (once per video):**
1. The app decodes the video with its bundled ffmpeg (piped, never to disk) and records each frame's exact time.
2. For each frame, the same code as for pictures: depth model → sharper edges → subject outline → Layered 3D
   background fill.
3. **Calming over time** (possible now because all frames are known): depth and outline are smoothed with the frames
   before and after, **only where nothing moved** (no ghost trails); the depth range is kept steady between scene
   cuts (no "breathing"); the background fill borrows real pixels from nearby frames where the camera is still.
4. All of a frame's data is packed into one picture (depth, outline, fill depth as grey tiles; fill colour as a
   colour tile) and the frames are encoded as a small video (VP9; H.264 if VP9 is missing), encrypted straight into
   the vault in chunks, plus the frame-time list.

**Playing:**
- The 3D data video is decoded a second ahead in the window (WebCodecs, on the graphics card).
- For each frame the real video shows, the matching 3D frame is picked by its exact time and drawn with it.
- After a seek: the first moment is flat for a fraction of a second while it catches up, then 3D fades in.
- GIFs: the same, picked by frame number. Prepared only when asked, like videos (today they work out depth by
  themselves on opening; that goes).

## 4. Time and size (rough; measured on your PC in the first test)

| | Estimate |
|---|---|
| Time, Fast depth + outline + Simple fill | ~0.1–0.2 s a frame → 1 min of 30 fps video ≈ 3–6 min |
| Time, Best depth + outline + LaMa | ~0.4–1 s a frame → 1 min of 30 fps ≈ 12–30 min |
| "Every 2nd frame" | about half |
| Size | ~10–30 MB per minute of video (a 2-hour film: 1–4 GB). Shown before you start. |

Long videos are fine but slow. A prepare can be stopped and **resumes where it stopped**.

## 5. Honest limits

- Lift-off and Layered 3D on video can **flicker slightly at the subject's edges** on fast motion. The calming step
  reduces it; it won't be as perfect as a still picture.
- Layered 3D's filled-in background can "boil" a little on moving cameras (filled again each frame). It shows only at
  the edges while the 3D camera moves.
- A video converted to a playable copy (MOV, MKV…) is prepared from the copy that actually plays.
- Needs the depth pack (and the outline / fill packs for those features), as for pictures.

## 6. Builds (one batch, all phases)

1. Prepare pipeline + depth on videos and GIFs + frame-exact playback + Settings size and delete button.
2. Sharper edges, Lift-off, 3D only on the subject.
3. Layered 3D (fill per frame, borrowing from nearby frames).
4. Polish: calmer camera on videos, less 3D on very fast / flat scenes.

Checks before each commit as in CLAUDE.md §4. Window parts testable in the browser demo; the real models, ffmpeg and
WebCodecs only in the app (CI's Windows self-test + you).

## 7. Files that change

- **Backend (Rust):** new `src/video3d.rs` (prepare job: ffmpeg decode → window → ffmpeg encode → encrypted object,
  resume, stop on lock); `derived.rs` (videos/GIFs allowed, a new kind for the 3D data video, stats split by
  pictures / moving, clear moving only); `videotool.rs` (decode/encode helpers); `protocol.rs` (stream the 3D data
  with Range); `lib.rs` (commands).
- **Window:** new `video3d.ts` (per-frame work + calming, reusing `depth.ts`, `subject.ts`, `plate.ts`, `layers.ts`);
  new `track3d.ts` (read, decode ahead, pick by frame time); `components/Depth3D.tsx` (draw videos/GIFs from the
  prepared data with all effects); `components/Player.tsx` (Prepare 3D button, states); `screens/Library.tsx`
  (`mediaActions`); `components/SavedMaps.tsx`, `components/Delete3DData.tsx`, `components/DepthSettings.tsx`;
  `api.ts`, `apimock.ts`, `apitypes.ts`, `presets.ts`/`config.rs` (new settings, old saves read safely).
- **Removed:** live video depth (`videoFrameDepth`, `blendDepth`, the delay option and its sound route) and GIF
  depth on opening (`depthOfFrames` in the viewer).
- **Tests:** frame lookup, calming, tile packing, derived stats/clear for moving items, settings defaults.
- **Vault format:** no change expected (3D data is encrypted objects in the library's `derived` table, like pictures');
  confirmed in the code before building.

## 8. As built (2026-11-22)

Where it differs from the plan above:

- **Encoding is in the window, not ffmpeg:** WebCodecs encodes each frame's tiles (VP9, else AV1, else H.264; WebP
  pictures if no video encoder works) in a worker (`video3dworker.ts`). ffmpeg only decodes the video's frames
  (`video3d.rs`, `videotool.rs spawn_frames`): raw RGBA at the tile size plus each frame's time (showinfo
  `pts_time`, `-copyts -start_at_zero`, so a resumed run keeps the video's own times).
- **Saved in pieces, not one stream:** an index `<tag>.i` ("MV3I" + JSON) and pieces `<tag>.s<n>` ("MV3S", 48 frames
  each, every piece starts with a key frame) in the `derived` table, kind `track` (`trackformat.ts`). No vault
  format change, no `protocol.rs` change. Stop keeps every finished piece; the next run carries on after the last one.
- **Tiles:** one packed picture of 3 × 2 tiles per frame: plate colour, subject-layer colour, outline / depth, plate
  depth, subject-layer depth (`video3dmath.ts`). Per-frame numbers (pivot, subject and background depth, subject
  box, how much moved) are in each piece's header.
- **Calming uses earlier frames only** (not frames after): depth lined up with the last frame's where nothing moved
  (steady range), then blended there; the outline blended the same way; nothing carried over across a scene cut.
  The background fill takes real background seen in earlier frames (while the camera stands still) before the
  fill model's guess.
- **Playing** (`track3d.ts TrackPlayer`): pieces read from the vault and decoded a few frames ahead with
  WebCodecs; each video frame (requestVideoFrameCallback `mediaTime`) or GIF frame number gets only its own
  prepared frame; none ready → the 3D eases out to flat for that moment. The shader (`Depth3D.tsx`) reads every
  map from the one track texture, so Lift-off, 3D only on the subject, Layered 3D and sharper edges work as on
  pictures. "Calmer 3D camera on videos" (on by default): slower, 75 % movement, and less 3D where a lot moves.
- **Where things are:** viewer 3D ▾ menu → "Prepare 3D for this video/GIF…" (asks with time, size and models;
  shows progress / Stop; "3D prepared → prepare again"; "Prepare 3D again with the models in use…" when it was made
  with other settings). Right-click a folder, selection or person folder → 3D data → "Prepare 3D for videos and
  GIFs…". Settings → AI & 3D → Videos and GIFs: 3D detail (512 / 768 / 1024 px), every frame or every 2nd, calmer
  camera, what's saved and its size, "Delete all 3D data for videos and GIFs". "Delete 3D data…" also lists
  videos' and GIFs' prepared 3D. The pictures' "Clear them" / "Work them all out again" no longer touch it.
- A video plays its own file; a playable copy (MOV → MP4) is its own item and is prepared on its own.

**Tested:** 597 window tests (new: `video3d.test.ts`: motion, calming, tiles, background memory, numbers, saved
format, tags, labels); in the browser (Chromium, this PC): the worker made VP9 pieces from 60 test frames, the
player gave every one of the 60 frames back at its own time (none missing or wrong, jumps fine), and the 3D shader
compiled and drew a real WebM with its prepared 3D (Lift-off shadow on). ffmpeg's frame command checked by hand
(50 frames from 0, 25 frames from 1 s with the right times). **Not tested:** Rust (not compiled on this PC; CI
compiles and tests it), a whole prepare in the real app with real models, real videos, speed and size.

## 9. After the first test (2026-11-23)

The user saw dark specks with Lift-off / the subject layer, and preparing was very slow.
- Specks: the outline goes through a video codec, whose faint noise Lift-off's shadow and the subject layer turned
  dark. Now the stored outline is snapped clean, the encoder gets more bits (0.09 bits/pixel), and the shader reads
  the outline without faint values. The last frame stays a few frames while the next decodes.
- Smoothing now also uses the 2 frames after each frame (where nothing moved).
- Speed: preparing ran depth → outline → fill on each frame, and the card keeps one model loaded at a time when they
  don't all fit, so models could reload every frame. Now blocks of 24 frames, one model over the block at a time.
- Tags end `_v2`: videos prepared before still play; the 3D menu offers to prepare them again.

