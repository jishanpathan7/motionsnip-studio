---
name: motionsnip-studio
description: Build motion graphics in code and review them in MotionSnip Studio, a local player where the user watches the render, fixes words in place, swaps music, circles problems on the frame and sends one prompt back. Use it whenever the user asks for a motion graphic, launch video, explainer, product video, animated promo or similar video made in code (Remotion or any other renderer), when they want to review or iterate on such a video, or when they paste a line like "Apply the MotionSnip Studio feedback in <path>" or share a "MotionSnip Studio feedback" markdown file.
---

# MotionSnip Studio

You build the video. The user reviews it in a local player. The loop is:

1. Build and render the video.
2. Describe it in `reel.json`.
3. Open the player.
4. The user reviews and clicks **Send to Claude**. You get one line: `Apply the MotionSnip Studio feedback in <abs path>`.
5. Apply the feedback, re-render, bump `version`. The player reloads by itself and helps the user check your changes.

In this file, `<skill dir>` means the folder that holds this `SKILL.md`, usually `~/.claude/skills/motionsnip-studio`.

## 1. Set up the project

Use one folder per video:

```
<project>/
  reel.json        you write this
  video.mp4        the render (any name; reel.json "src" points at it)
  assets/          music, images, logos (user uploads land here too)
  public/          optional; Remotion staticFile() assets
  exports/         made by the player's Export; never edit
  .motionsnip/     player state and history; never edit
```

If the user has no renderer yet, Remotion is a good default (`npx create-video@latest`). Any tool that writes an mp4, webm or mov works.

## 2. Build it so edits are cheap

- Keep copy, colours, fonts and timings in one data object (Remotion `defaultProps` or a `content.ts`), not scattered through components. Then a feedback edit is a one-line change.
- Give every on-screen element a stable id and use the same id in `reel.json`.
- **Ship music as its own file. Render the video with sound effects only.** Put the track in `assets/` and point `audio.music` at it, and set `audio.videoAudio` to `"effects"`. The player plays the music beside the video, so the user can swap tracks, move the start and set levels without a re-render. Their Export mixes it in with ffmpeg.
- Only bake music into the video when the user asks for it. Then set `videoAudio` to `"mix"`.

## 3. Render and look before you show

Render, then check your own work with a contact sheet:

```bash
ffmpeg -v error -y -i video.mp4 -vf "fps=1,scale=480:-1,tile=4x3" -frames:v 1 /tmp/sheet.png
```

Open the image and look at it. Fix clipped text, empty frames, wrong colours and timing gaps before you open the player. For one frame:

```bash
ffmpeg -v error -y -ss 12.4 -i video.mp4 -frames:v 1 /tmp/frame.png
```

**Self-review.** Then look again as a picky reviewer would, and write down what you still see. Check:

- **Safe area.** Anything that matters inside a 10% inset from every edge (title-safe)?
- **Size.** Body text at least about 3% of the frame height, so it reads on a phone.
- **Contrast.** Text and key shapes clearly apart from what is behind them.
- **Typos and overflow.** Every word spelled right, nothing clipped or running out of its box.
- **Cuts and timing.** No flash frames on a cut, no empty frames, nothing gone before it can be read.

Fix what you can. For anything left, or anything that is a matter of taste, add a finding to `review` in `reel.json` (section 4). The player draws each one as a dashed blue ring labelled C1, C2… on that frame, and the user either adds it as their own note or dismisses it. Only write what you actually saw in a frame grab: give the time, and the spot or element, so the ring lands on it. Leave `review` empty when there is nothing to say; don't pad it.

## 4. Write reel.json

`reel.json` is the contract between you and the player. Write plain JSON (no comments).

```jsonc
{
  "id": "acme-launch",              // stable; the user's saved edits are keyed by it
  "title": "Acme launch",
  "version": 1,                     // bump on every render; the player reloads when it changes
  "path": "/abs/path/to/project",   // where you work; shown in the prompt
  "src": "video.mp4",
  "w": 1920, "h": 1080, "fps": 30, "duration": 32.0,
  "reference": "optional: what the video is modelled on",
  "brand": {
    "colors": [{ "id": "accent", "name": "Accent", "v": "#5B5BF7" }],
    "fonts":  [{ "id": "head", "name": "Headlines", "v": "Inter" }],
    "logo": "assets/logo.svg"       // or null
  },
  "audio": {
    "music": "assets/track.mp3",    // played beside the video, or null
    "videoAudio": "effects",        // "effects" = video has sound effects only; "mix" = music is baked in
    "bpm": 120, "drop": 4.0,        // optional beat grid; drop = seconds where the drop lands
    "musicVol": 1, "sfxVol": 1,     // 0..1
    "musicOffset": 0,               // seconds; + starts the music later, - skips into the track
    "musicFade": 0,                 // seconds of fade-out at the end
    "note": "free text"
  },
  "assets": [{ "id": "assets/track.mp3", "name": "track.mp3", "type": "audio", "from": "User" }],
  "scenes": [
    { "id": "S1", "name": "Hook", "t": [0, 4.5], "els": [
      { "id": "headline", "label": "Headline", "t": [0.3, 4.3],
        "box": [20, 38, 60, 24],    // x, y, w, h in % of the frame; null for voiceover, audio, full-frame footage
        "src": "src/Hook.tsx:12",   // the file (or file:line) that draws it
        "props": {
          "text":   { "type": "text",   "label": "Text",   "v": "Meet Acme" },
          "color":  { "type": "color",  "label": "Color",  "v": "brand.accent" },
          "motion": { "type": "motion", "label": "Motion", "v": "Words blur in one by one" }
        } }
    ] }
  ],
  "notes": [],
  "review": [                       // optional: your own self-review findings (section 3)
    { "id": "v1-1", "t": 1.5, "elId": "headline", "kind": "safe area",
      "title": "Headline runs into the right edge",
      "detail": "At 1.5 s the last word ends 2% from the edge, outside title-safe.",
      "fix": "Narrow the box to 56% or drop the size a step." }
  ],
  "live": "live.js",                // optional live renderer (section 7)
  "export": { "cwd": "/abs/build/folder", "props": {}, "cmd": "npx remotion render ... \"$OUT\" --props=\"$PROPS\"" }  // optional (section 8)
}
```

Rules:

- **Prop types:** `text`, `longtext`, `number`, `color` (`brand.<id>` links to the palette), `media` (an asset id), `list` (rows; `cols: [{ k, type, options? }]`), `choice` (`options: [...]`), `motion` (a plain description of the movement; the user can only comment on it).
- Scenes cover `0..duration` with no gaps. Times are seconds.
- Keep scene and element ids stable between versions. Saved edits match by id.
- `box` must match where the element really is on screen, in % of the frame. Measure it from a frame grab if unsure. The user clicks these boxes to select things.
- `src` should point at the code that draws the element, so you can find it later.
- Every prop value must equal what is actually rendered. The player ticks an edit as done when the new `reel.json` value matches what was asked.
- `path` can be left out; the server fills in the project folder.
- **`review` findings:** `id` (unique in this version, e.g. `v2-1`), `t` (seconds), `title` (one line), optional `detail`, `fix` and `kind` (`safe area`, `size`, `contrast`, `typo`, `overflow`, `cut`, `timing` or your own word). Place it with `elId` (an element id, ringed at its box), `box: [x, y, w, h]`, or `x`, `y` in % of the frame. Write a fresh list for every version; don't repeat anything the user dismissed.
- Unknown fields are ignored. Missing optional fields get defaults.

## 5. Open the player

Start the server in the background, then give the user the URL it prints:

```bash
node <skill dir>/player/server.mjs <project> &
# MotionSnip Studio: http://localhost:4321  (project: /abs/path)
```

Options: `--port 4321` (moves up if busy), `--no-open` (don't open a browser), `--ffmpeg /path/to/ffmpeg` (for Export). Node 18 or newer, no install step. If a server for this project is already running, don't start another; the player picks up new versions by itself.

Tell the user what to do in one or two lines: watch it, click anything to fix it, right-click to circle a problem, then **Send to Claude**.

**A plain video.** If the user wants to review or edit a video file that has no `reel.json` (a screen recording, a phone clip), pass the file itself: `node <skill dir>/player/server.mjs path/to/clip.mp4 &`. Don't write a `reel.json` for it. The player lets them trim, cut, add text, a logo or a blur, and set the colour, and its Export applies those edits itself. Their feedback file then only carries notes pinned on the frame; follow those, and if a note asks for a new cut, export over the same file name so the player counts it as the next version.

## 6. Apply a feedback file

The user pastes `Apply the MotionSnip Studio feedback in <project>/.motionsnip/feedback-vN.md`. Read that file. It has these parts:

- **Exact changes.** Lines like `[00:01.2 · S1 · Headline] Text (src/Hook.tsx:12): "Meet Acme" -> "Say hi to Acme"`. Make exactly that change in the code and in `reel.json`. Don't reword it. A colour edit to `brand.<id>` changes the palette entry, so everything linked to it changes.
- **Size and position edits.** `[x, y, w, h] -> [x, y, w, h] (scale 1.12)` in % of the frame. Convert to pixels with the frame size (`x% * w / 100`), move or resize the element in code, and update its `box`.
- **Sound settings.** New track (already saved in `assets/`), start offset, fade, volumes. Update `audio` in `reel.json`. If the video carries effects only, you usually don't need to re-render for these. If music is baked in (`videoAudio: "mix"`), re-render with the new settings.
- **Comments on the frame.** Free comments pinned to a time and a spot (`x 23.9% y 81.8%`), often on a named element. Grab that frame and look at it before you decide what to do. Notes are requests, not exact values; use judgement and keep the rest of the scene intact.
- **Not quite from vN-1.** Things you changed last round that the user says aren't right yet, with their reason. Fix these first.
- **From your self-review.** A comment ending `(from your self-review, v1-2; the reviewer agrees)` is one of your own findings that the user accepted. Treat it like any other note.
- **Dismissed from your self-review.** Findings the user looked at and is happy with. Leave those things as they are, and don't flag them again in the next `review`.
- **Scenes.** Each scene's status. **Leave approved scenes alone** unless an edit or note names them.

Then:

1. Make the changes. Keep ids stable.
2. Re-render to the same `src` file (or a new file and update `src`).
3. Check the contact sheet and the frames you touched.
4. Update every changed value in `reel.json` and set `version` to N+1 (the file says which number). Bump the version last, after the render has finished.
5. Tell the user in one line what changed, for example "v4 is in · 5 changes applied, the outro note needs your eye".

Never edit `.motionsnip/` or `exports/`; they belong to the player.

## 7. Optional: live renderer

If the video can run in a browser (canvas, DOM, Remotion Player bundle), you can ship `live.js` and set `"live": "live.js"`. The player loads it as a classic script and calls:

```js
window.MotionSnipLive = (container) => ({
  seek(timeSeconds) {}, play() {}, pause() {}, setRate(rate) {},
  // boxes[id] = [x, y, w, h, nx, ny, nw, nh]: original then edited, % of the frame
  setBoxes(boxes) {},
});
```

The player then hides the video and drives your renderer, so moved or resized elements show for real.

## 8. Optional: export hook

Add `export` to `reel.json` to let the user render a final from the player:

```json
"export": {
  "cwd": "/abs/path/to/remotion/project",
  "props": { "musicSrc": null },
  "cmd": "npx remotion render src/index.ts Main \"$RAW\" --props=\"$PROPS\""
}
```

The server runs `cmd` with `sh -c` in `cwd` and sets:

- `PROPS`: path to a JSON file with `export.props` merged with the user's edits. The edits arrive as
  `{ "edits": { "<elId>": { "<prop>": value } }, "boxes": { "<elId>": [x, y, w, h] }, "colors": { "<id>": "#hex" }, "fonts": { "<id>": "Name" } }`
  (boxes in % of the frame). Have your composition read these so the render includes them.
- `OUT`: the final file in `exports/`. Write here if your render already includes everything.
- `RAW`: a temp path. Write here instead and the server mixes the user's chosen music and levels into it to make `OUT`.
- `PROJECT`: the project folder.

Progress comes from the last `n/m` pair the command prints (Remotion prints frame counts like this).

Without an export hook, Export still works: it copies the video and mixes in the music with ffmpeg.
