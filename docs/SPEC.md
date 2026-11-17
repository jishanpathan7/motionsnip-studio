# MotionSnip Studio — product spec

MotionSnip Studio is a local review player and editor for motion graphics that Claude builds in code.
Claude renders a video, describes it in `reel.json`, and opens the player. The reviewer watches, fixes
words in place, swaps music, sets levels, circles problems on the frame, exports an mp4, and sends one
prompt back to Claude. When Claude re-renders and bumps the version, the player reloads and helps the
reviewer check the new version.

Everything runs on the user's machine: a dependency-free Node server bound to 127.0.0.1 plus a
browser page. No accounts, no cloud, no build step.

Licence: MIT, `Copyright (c) 2026 Jishan Pathan`. Written from scratch from this spec.

---

## 1. Project folder

```
<project>/
  reel.json            the project description (below), written by Claude
  scene.json           instead of reel.json, for a scene project (section 6a)
  <video>              the render that reel.json "src" points at (mp4/webm/mov)
  assets/              user files: music uploads, images
  public/              optional; files Remotion's staticFile() points at (served at the site root as a fallback)
  exports/             files made by Export (never overwritten)
  .motionsnip/         player state and history (created by the server)
    state.json         the reviewer's unsent edits, notes and settings (mirrors browser storage)
    feedback-vN.md     what was sent to Claude for version N
    takes/vN.<ext>     copies of the last 6 versions' videos, for compare
```

## 2. reel.json (the contract with Claude)

```jsonc
{
  "id": "acme-launch",              // stable; keys the reviewer's saved edits
  "title": "Acme launch",
  "version": 3,                     // Claude bumps it on every render; the player reloads when it changes
  "path": "/abs/path/to/project",   // shown in the prompt so Claude knows where to work
  "src": "video.mp4",
  "w": 1920, "h": 1080, "fps": 30, "duration": 32.0,
  "reference": "optional: what the video is modelled on",
  "brand": {
    "colors": [{ "id": "accent", "name": "Accent", "v": "#5B5BF7" }],
    "fonts":  [{ "id": "head", "name": "Headlines", "v": "Inter" }],
    "logo": "assets/logo.svg"       // or null
  },
  "audio": {
    "music": "assets/track.mp3",    // music file played beside the video, or null
    "videoAudio": "effects",        // "effects" = the video carries sound effects only; "mix" = music is baked in
    "bpm": 120, "drop": 4.0,        // optional beat grid; drop = seconds where the beat drop lands
    "musicVol": 1, "sfxVol": 1,     // 0..1
    "musicOffset": 0,               // seconds; + starts the music later, - skips into the track
    "musicFade": 0,                 // seconds of fade-out at the end
    "note": "free text"
  },
  "assets": [{ "id": "assets/track.mp3", "name": "track.mp3", "type": "audio", "from": "User" }],  // type: image | audio | video
  "scenes": [
    { "id": "S1", "name": "Hook", "t": [0, 4.5], "els": [
      { "id": "headline", "label": "Headline", "t": [0.3, 4.3],
        "box": [20, 38, 60, 24],    // x, y, w, h in % of the frame, or null (voiceover, audio, full-frame footage)
        "src": "src/Hook.tsx:12",   // file or file:line that draws it
        "props": {
          "text":   { "type": "text",   "label": "Text",   "v": "Meet Acme" },
          "color":  { "type": "color",  "label": "Color",  "v": "brand.accent" },
          "motion": { "type": "motion", "label": "Motion", "v": "Words blur in one by one" }
        } }
    ] }
  ],
  "notes": [],
  "review": [                       // optional: Claude's self-review of this render
    { "id": "v1-1", "t": 1.5, "elId": "headline", "kind": "safe area", "title": "…", "detail": "…", "fix": "…" }
  ],
  "outputs": [                      // optional: versions made from this master (see below)
    { "id": "vertical", "label": "9:16", "kind": "reframe", "src": "out/vertical.mp4", "w": 1080, "h": 1920, "version": 1, "review": [] }
  ],
  "live": "live.js",                // optional live renderer (section 6)
  "export": { "cwd": "/abs/build/folder", "props": {}, "cmd": "npx remotion render ... \"$OUT\" --props=\"$PROPS\"" }  // optional
}
```

Prop types: `text`, `longtext`, `number`, `color` (a value like `brand.accent` links to the palette),
`media` (an asset id), `list` (rows; `cols: [{k, type, options?}]`), `choice` (`options: [...]`), `motion`
(free text describing movement; the reviewer can't edit it directly, only comment).

`review` findings are placed by `elId` (ringed at that element's box), `box: [x, y, w, h]` or `x`, `y` in %. The player
draws each as a dashed sky-blue ring with a "C<n>" badge (a rounded rectangle for a box, a hand-drawn ring for a point),
visible from 0.75 s before `t` to 2.5 s after. Clicking one opens a card with the title, detail and suggested fix, and two
actions: **Add as my note** (it becomes a normal pink note carrying the finding id) and **Dismiss**. Changes lists open
and dismissed findings under "Claude spotted", with Show me, accept, dismiss and bring back. The decision is saved per
version (`review: { "v<N>:<id>": "accepted" | "dismissed" }` in the saved state), so a new version starts fresh.

`outputs` are other videos made from the master: a reframe (another shape), a bumper (a few seconds cut from it,
`ranges: [[a, b], …]` in master time), a separate render, or a language version (`kind`: `reframe` | `bumper` | `render` |
`lang`). Each has its own `id`, `label`, `src`, `w`, `h`, `duration` (defaults: the master's), `version` (default 1),
`audio` (laid over the master's; `{ "music": null, "videoAudio": "mix" }` when the music is in the file) and `review`
(findings on its own frame and clock). Scenes and elements are the master's; a bumper's scenes follow its ranges.
The player's own cutdowns live in `.motionsnip/outputs.json` (`{ outputs: [...] }`, same fields plus `mode: crop |
blurpad`, `zoom`, `keys: [{ t, cx, cy }]` crop centres in % of the master, and `from`: the master version it was made
from); the server merges them after reel.json's, which win an id clash. Shared code for all of this is
`player/app/reel.mjs` (no DOM; the server imports it too).

Scenes cover 0..duration without gaps. Ids stay stable between versions; saved edits match by id.
Unknown fields are ignored; missing optional fields get defaults.

## 3. Server (`player/server.mjs`, Node 18+, no dependencies)

```
node player/server.mjs <project-dir> [--port 4321] [--no-open] [--ffmpeg /path/to/ffmpeg]
node player/server.mjs --selftest
```

- Binds 127.0.0.1. If the port is busy, tries the next one. Prints `MotionSnip Studio: http://localhost:<port>  (project: <dir>)`.
  Opens the browser unless `--no-open`.
- Rejects requests whose `Host` header isn't `localhost:<port>` or `127.0.0.1:<port>` (DNS rebinding).
- Every POST must carry an `Origin` of the player itself (`http://localhost:<port>` / `http://127.0.0.1:<port>`); otherwise 403.
- `GET /` → the player page. `GET /app/*` → the player's own static files (js/css/brand svg).
- `GET /p/<path>` → a file inside the project folder (resolved, must stay inside; 403 otherwise). If missing and
  `public/<path>` exists, serve that. Byte-range support (206, 416) for video/audio seeking. `Cache-Control: no-store`.
  Content types for html/js/css/json/mp4/webm/mov/mp3/wav/m4a/aac/ogg/png/jpg/webp/gif/svg.
- `GET /api/reel` → reel.json (parsed and re-serialised; 500 with a short message if invalid).
- `GET /api/state` / `POST /api/state` (JSON body ≤ 2 MB) → read/write `.motionsnip/state.json`.
- `POST /api/upload?name=<file name>` (raw body) → audio uploads only: mp3/wav/m4a; first bytes must match the type
  (ID3 or MPEG frame sync for mp3, `RIFF....WAVE` for wav, `....ftyp` for m4a); ≤ 100 MB; the name is reduced to
  letters, digits, `-`, `_`, `.` (no leading dot, no path parts, max 80 chars, keep the extension); never overwrite
  (append `-2`, `-3`…). Saves to `assets/`. Responds `{ id: "assets/<name>", name, type: "audio" }`.
- `POST /api/feedback` `{ version, markdown }` → writes `.motionsnip/feedback-v<version>.md`, responds `{ path }` (absolute).
- `POST /api/export` `{ music, musicVol, sfxVol, musicOffset, musicFade, mode: "mix" | "render", props }` → starts one job
  at a time; `GET /api/export` → `{ state: idle|running|done|error, pct, line, out }`.
  - `mode: "mix"`: ffmpeg copies the video stream and mixes audio: the video's own audio at `sfxVol` (if it has audio) plus
    `music` (a project path) at `musicVol`, delayed by `musicOffset` (or trimmed if negative), faded out over the last
    `musicFade` seconds, cut to the video duration; AAC 192k. Output `exports/<id>-<YYYYMMDD-HHMMSS>.mp4`, never overwritten.
  - `mode: "render"`: runs reel.json `export.cmd` with `sh -c` in `export.cwd`, env `PROPS` (temp JSON file with
    `export.props` merged with the request's `props`), `OUT`, `RAW` (temp path), `PROJECT`. Progress from the last
    `n/m` pair in its output.
  - ffmpeg lookup: `--ffmpeg`, then `ffmpeg` on PATH, then a Remotion-bundled binary under the project's
    `node_modules/@remotion/compositor-*/ffmpeg`. If none: `{ state: "error", line: "ffmpeg not found…" }`.
- `POST /api/reveal` `{ path }` → reveal a file inside the project in Finder/Explorer (`open -R`, `explorer /select,`, `xdg-open` dir).
- `GET /api/takes` → `[{ version, src }]`; when a new `version` is first served, copy its video to `.motionsnip/takes/v<N>.<ext>`
  (on macOS use `cp -c` clone when possible), keep the newest 6.
- `GET /api/ffmpeg` → `{ ok, path }` so the player can warn before export.
- `POST /api/cutdown` `{ id, keys?, mode?, zoom?, ranges?, music, musicVol, sfxVol, musicOffset, musicFade }` → makes a
  cutdown (one at a time; `GET /api/cutdown` → `{ state, pct, line, id, label }`). `id` is a preset (`vertical` 1080×1920,
  `square` 1080×1080, `landscape` 1920×1080, `bumper6`) or an existing player cutdown to render again (its keys, mode,
  zoom and ranges are kept unless the request changes them). Without keys a reframe starts from a guess: per scene, centre
  the elements' boxes, jump at the cuts; whole frame on a blurred fill when most scenes don't fit. A bumper without ranges
  takes the opening of the first scene and the end of the last. The ffmpeg graph is the edit export's (`buildEditArgs`)
  with a reframe step: `crop` whose x/y are expressions of `t` (straight lines between keys), `scale`, `setsar=1`; or a
  blurred, dimmed fill under the frame scaled to fit. The music is mixed in. Renders to a temp file, then
  `outputs/<id>.mp4`, then bumps that entry's `version` in `.motionsnip/outputs.json`. 400 for an output reel.json lists.
- `POST /api/cutdown-remove` `{ id }` → deletes a player cutdown and its file.
- `--selftest`: covers byte-range parsing, upload name cleaning (traversal, dotfiles, unicode, wrong extension, long names),
  magic-byte sniffing, host and origin checks, the ffmpeg mix argument builder (offset +/-, fade, no video audio), and an
  end-to-end upload against a temp project; outputs (key expressions, crop sizes, the reframe graph, merging, bumper
  clocks, first guesses) and, with a full ffmpeg, real 9:16, 1:1 and bumper renders checked for size and length. Prints `selftest ok` and exits 0, or the failure and exits 1.

## 4. Player (browser; plain ES modules + CSS, no framework, no build)

Files under `player/app/`. Loads `/api/reel`, polls it every 2 s for a new `version`.

### Layout
Header: logo (cue-mark symbol + "MotionSnip Studio"), project title and version, approval counter ("6 of 9 approved",
click = next scene to review), state pill ("Waiting for v4" after sending), theme switch (System/Light/Dark), Export,
Send to Claude (tape yellow). Main: the frame (video or live renderer) with an overlay layer for boxes, rings, tape tabs.
Under it: transport (play, frame step, timecode `00:12.4 f372`, speed pill, loop, mute, fullscreen, compare), the
timeline (scene strip, music lane with waveform, effects lane with waveform, beat grid with the drop marked), and a hint
line that always says what you can do next. Side panel tabs: **Edit**, **Script**, **Look**, **Sound**, **Changes**.
Responsive: panel moves under the frame below ~1100 px wide.

### Watching
- Space play/pause; ←/→ or `,`/`.` one frame; Shift+←/→ one second; Home/End; `[` `]` previous/next scene; `L` loop the
  current scene; `<` `>` speed −/+ 0.25 (0.25–2×; the speed pill has a slider and ½ 1 1.5 2 presets); `F` fullscreen
  (or double-click an empty spot); `M` mute; `A` approve the current scene; hold `V` (or the compare button) to show the
  previous version's take at the same frame; `?` shortcuts sheet; Esc cancels/deselects/leaves fullscreen.
- Frame-accurate: seek to `(frame + 0.5) / fps`. Timecode shows seconds and frame number.
- Music plays in an `<audio>` beside the video, kept in sync (re-seek if drift > 60 ms), with offset, fade and volumes
  applied live (Web Audio gain). Video volume = sfxVol. If `videoAudio` is "mix", the video slider is labelled
  "Video sound" and an added track plays on top.
- Timeline: click/drag to scrub; hover shows a thumbnail (a second hidden `<video>` seeked to that time, drawn to a
  canvas) and the scene name. Waveforms are decoded with Web Audio (music file, and the video's audio track) and drawn as
  bars. Drag the music lane to change the offset (snaps to scene starts and beats, Shift = no snap); drag the handle at
  its end to set the fade.
- Deep links: `#t=12.5&el=headline`, `#tab=sound`, `?theme=dark`.

### Fixing (no modes)
- Pause, click an element on the frame (its `box`) to select it: a pink outline with its label; its props open in Edit.
- Double-click the element (or Enter) to edit its main text in place: an input over the frame, Enter saves, Esc cancels.
- Drag to move, drag a corner to resize (boxes in % of the frame). With a live renderer the change shows for real;
  otherwise as a translucent preview box. Changes are recorded as `[x,y,w,h]` plus scale.
- Right-click (or `C`) on the frame: pin a note at that spot and time. The ring draws itself (~420 ms), then the number
  drops in; type the comment. Notes stay circled in pink while their time is on screen.
- Edited elements get a "Waiting for Claude" slip with a yellow tape tab on the frame and a tape mark on the timeline.
- Edit tab: every prop of the selected element by type (text/longtext inputs, number, colour swatch + hex, media picker
  from assets, list rows editor with add/remove, choice select, motion as read-only text + "comment on this").
  Scene status: Review / Needs changes / Approved.
- Script tab: every text prop in the video in time order, editable inline; click a row's time to jump there.
- Look tab: brand colours (edit = changes everywhere that links to it), fonts, logo, image assets.
- Sound tab: music track (name, Swap from audio assets, Upload — also drag-and-drop anywhere on the page, Remove),
  "Start the music at" scene picker, offset and fade fields, Music and Effects (or Video sound) sliders, the beat drop info.
- Changes tab: every edit, note, upload and level change, each with jump-to and undo; the Send area.
- Undo per change; edits persist to browser storage and `POST /api/state` (debounced); on load, server state wins if newer.

### Sending and checking
- Send to Claude opens Changes; "Send" builds the markdown (section 5), `POST /api/feedback`, copies one line to the
  clipboard: `Apply the MotionSnip Studio feedback in <abs path>`, and shows "Waiting for v<N+1>" (the favicon sweeps).
- When a new version arrives: the cue dot flashes twice in the frame's top-right corner, the video reloads at the same
  time, the version number rolls over, and Changes opens on **Check v<N>**: edits whose new reel.json values match what
  was asked are ticked automatically; for the rest, "Show me" jumps there, then "Looks right" / "Not quite" (+ optional
  reason). "Not quite" items carry into the next round. Sent edits clear; unsent ones stay.
- Export button label says what you'll get ("Export with new music", "Export final" when all scenes are approved), warns
  about changes that still need Claude, shows progress, and offers "Show in Finder" when done.
- Favicon states drawn live on a canvas: idle, notes waiting (pink dot), Claude working (sweep), new version (big pink dot
  until the tab is focused).

## 5. Feedback markdown

```
MotionSnip Studio feedback for "<title>" v<version>
Project: <path> · <w>x<h> · <fps> fps · <duration>s

## Exact changes
- [<mm:ss.s> · <scene id> · <element label>] <prop label> (<src>): "<before>" -> "<after>"
- [<mm:ss.s> · <scene id> · <element label>] Size and position (<src>): [x, y, w, h] -> [x, y, w, h] (scale 1.12)

## Sound settings
- Audio · Music track: "<before>" -> "<after>" (uploaded in MotionSnip Studio, already in assets/)
- Audio · Music start offset (s): 0 -> 2
- Audio · Music fade-out (s): 0 -> 4
- Audio · Music volume (0-1): 1 -> 0.6
<one line saying whether video sound is effects only or a mix>

## Comments on the frame
1. [<mm:ss.s> · <scene id> <scene name> · x 23.9% y 81.8% · on <element label> (<src>)] <comment>
2. [<mm:ss.s> · …] <comment> (from your self-review, <finding id>; the reviewer agrees)

## Comments on the <label> version (<id>: <src>, <w>x<h>, <duration>s)
<for a bumper: one line saying times are on its own clock and which master ranges it is cut from>
1. [<mm:ss.s> · <scene id> <scene name> · x 50.0% y 80.0%] <comment>

## Cutdowns made in MotionSnip Studio
<one line: the player renders these from the master; fix framing in the master>
- <id> (<label>, <w>x<h>): cropped, crop centre <mm:ss.s> at <cx>%,<cy>% … | the whole frame on a blurred fill | <ranges> of the master

## Dismissed from your self-review
The reviewer looked at these and is happy as it is. Leave them, and don't flag them again.
- <finding id> [<mm:ss.s>] <title>

## Not quite from v<N-1>
- <item> — <reason>

## Scenes
S1 <name> (<mm:ss.s>-<mm:ss.s>): approved | in review | needs changes

Next version: set "version" to <N+1> in reel.json.
```

## 6. Live renderer (optional)

If reel.json has `"live": "<file.js>"`, the player loads it as a classic script from the project, then calls
`window.MotionSnipLive(container)` which must return `{ seek(timeSeconds), play(), pause(), setRate(r), setBoxes(boxes) }`.
`boxes[id] = [x, y, w, h, nx, ny, nw, nh]` (original then edited, % of frame). The player then hides the `<video>` and
drives the live renderer instead; Export offers `mode: "render"`.

## 6a. Scene projects

A folder with `scene.json` and no `reel.json` is a scene project (the format is in SKILL.md section 10). The server
builds the reel with `toReel()` from `player/app/scene/compile.mjs`, the same module the browser uses:

- shots become `scenes`; each cast member, prop and line in a shot becomes an element `<id>@<shot>` (lines are
  `line<beat>@<shot>`), with a box measured from the scene, and props that carry `path`, the exact place in
  scene.json (`cast.ana.look.shirt`, `shots[0].beats[1].text`, `props.chart.data`);
- the palette becomes `brand.colors`, so the Look tab recolours the scene;
- `review` is the scene's own checks (too fast to read, cut off by the next shot, off the frame, unknown names);
- `live` is `{ "type": "scene", "spec": "scene.json" }`, `scene: true`, and `src` is the last export, if any.

The player imports `player/app/scene/runtime.js` instead of loading a script. Besides the live-renderer calls it
takes `setProps(edits, patches)`: edits are `{ elId: { prop: value } }`, patches `[{ path, value }]` in scene.json.
The player sends both on every change, so Script and Look edits show at once. A moved box becomes an offset of that
thing in that shot. Drawing is pure: `frameSVG(spec, t)` (`draw.mjs`) returns the same SVG for the same `t`.
Feedback lines for a scene name scene.json paths and pixel moves, and "Next version" points at scene.json.

## 7. Brand (see docs/brand/README.md)

Dark default. Bay `#15121D` (page), Bench `#211C2B` (panels), Paper `#F6F4EF` (text on dark / page on light), Ink
`#15121D` (text on light), Grain `#A49DB3` / Lead `#6A6378` (secondary), **Cue** pink `#FF4FA8` (on dark) / `#C2185B` (on
light) for attention, notes, rings, new version; **Tape** yellow `#E8FF47`, fill only, for Send, edited elements, change
counts (text on tape is always Bay). Status green/red separate. Type: Bricolage Grotesque (headings 800, UI 500–600),
DM Mono (timecode, frames, versions, keys) from Google Fonts. Icons: 1.6–2 px strokes, rounded, frames as 3:2 rounded
rectangles; colour only when it means something. Motion: ring draw ~420 ms; tape tab lands; send = countdown sweep; new
version = cue dot flashes twice; all respect `prefers-reduced-motion`. Voice: plain and short, from the reviewer's side
("v2 is in · 3 changes applied", "Nothing circled yet").

## 8. Claude skill (`SKILL.md`)

A Claude Code skill file (frontmatter `name: motionsnip-studio`, `description: …`) telling Claude how to: set up a
project, build in Remotion (keep copy, colours and timings in reel.json where possible; ship music as its own file and
the video with effects only), render and check a contact sheet, write reel.json (section 2), open the player
(`node <skill dir>/player/server.mjs <project>` in the background), apply a feedback file (edits exactly; size/position
edits; notes — grab the frame and look before deciding; leave approved scenes alone; re-render; bump version), and
optionally ship a live renderer (section 6) and an export hook.
