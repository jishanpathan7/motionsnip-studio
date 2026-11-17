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
  "outputs": [                      // optional: other shapes and lengths you made from it (section 9)
    { "id": "vertical", "label": "9:16", "kind": "reframe", "src": "out/vertical.mp4", "w": 1080, "h": 1920, "platform": "reels" }
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
- **`outputs`**: see section 9.
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
- **Comments on the {label} version.** The same kind of comment, left on a cutdown (9:16, 1:1, a bumper) instead of the master. Times and spots are on that version's own frame and clock; a bumper's section says which parts of the master it is cut from. Fix the cause in the master when you can (keep the important things where the crops see them). If you made that version yourself (it is in your `outputs`), render it again too and bump its own `version`.
- **Cutdowns made in MotionSnip Studio.** Versions the player renders itself from the master, with their crop keys or ranges. Leave their files alone; the reviewer re-renders them after your next version.
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

Never edit `.motionsnip/`, `exports/` or the player's cutdowns in `outputs/` (listed in `.motionsnip/outputs.json`); they belong to the player.

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

## 9. Optional: other shapes and lengths (outputs)

The player makes cutdowns itself: **+ Cutdown** renders a 9:16, 1:1 (or 16:9 from a vertical master) or a 6-second bumper from the master with ffmpeg, into `outputs/<id>.mp4`. A reframe follows crop keys the reviewer drags on the master (or a first guess from your element boxes, so keep `box` accurate), or fits the whole frame on a blurred fill. Each output gets its own tab, safe-area guides for Reels, TikTok and Shorts, and its own notes. You don't need to do anything for these.

When a code-built video looks better laid out again than cropped, render that version yourself and list it in `reel.json`:

```jsonc
"outputs": [
  { "id": "vertical", "label": "9:16", "kind": "reframe", "platform": "reels",
    "src": "out/vertical.mp4", "w": 1080, "h": 1920, "duration": 12,
    "audio": { "music": null, "videoAudio": "mix" },   // if the music is mixed into this file
    "version": 1,                                       // bump it when you render this output again
    "review": [ /* findings on this version, placed on its own frame and clock */ ] },
  { "id": "bumper", "label": "6 s", "kind": "bumper", "src": "out/bumper.mp4", "duration": 6,
    "ranges": [[0, 3.3], [9.3, 12]] }                   // which master seconds it is cut from
]
```

- `id` is unique and stable; `kind` is `reframe`, `bumper`, `render` or `lang`. `w`, `h` and `duration` default to the master's.
- Scenes and elements are the master's. A bumper's scenes follow its `ranges`; any other output keeps the master's clock.
- An output you list replaces a player cutdown with the same id. The player won't re-render yours.
- Self-review per output: look at each output's frames too (captions under the platform UI, a logo cut off by the crop) and put findings in that output's `review`.


## 10. Scenes: describe an idea, get an animation

When the user describes a scene in words ("a dev stuck on a slow render, a robot hands her an idea", "explain our pipeline", "an abstract intro for the launch") and doesn't need a code renderer, make a **scene project**: a folder with `scene.json` and no `reel.json`. You write data, not animation code. MotionSnip Studio draws it live in a hand-drawn style, builds the reel from it (shots become scenes, the cast and props become elements, every line of dialogue is editable) and runs its own checks, which show as self-review rings.

**The loop:**

1. Pin down the idea in one line: who, what changes, what the viewer should feel.
2. Pitch 2 or 3 visual metaphors in a sentence each (for example "the render bar as a mountain she climbs" or "a robot that hands over a lit bulb"). Let the user pick unless they asked you to just make it.
3. Write `scene.json` in a new folder and open the player on it: `node "<skill dir>/player/server.mjs" "<folder>"`.
4. Look at it before you show it: scrub each shot, read the rings (lines too fast to read, a line cut off by the next shot, things off the frame, names that point at nothing) and fix them.
5. Feedback works as for any project, except you edit `scene.json` and bump its `version`. Lines name exact paths, like `scene.json › shots[0].beats[1].text`; a moved box says how many pixels to move that thing in that shot. Keep ids stable so notes and rings stay attached.

**The format:**

```jsonc
{
  "title": "Idea to animation", "version": 1,
  "size": [1920, 1080], "fps": 30,                       // the stage; positions are in these pixels
  "style": { "preset": "ink" },                          // ink | marker | flat; override "palette", "wobble", "stroke", "font"
  "cast": {
    "ana":  { "kind": "person", "name": "Ana", "look": { "hair": "bun", "shirt": "accent" } },
    "bolt": { "kind": "robot",  "name": "Bolt", "look": { "body": "soft" } }
  },
  "props": {
    "laptop": { "kit": "laptop", "text": "render 12%" },
    "chart":  { "kit": "chart", "data": [2, 3, 5, 9] },
    "rocket": { "draw": "M0 40 L20 0 L40 40 Z", "fill": "accent" },   // any SVG path, scaled to fit
    "logo":   { "image": "assets/logo.svg" }                           // a file in the project
  },
  "shots": [
    { "id": "stuck", "name": "Stuck", "dur": 4.5,
      "place": { "ana": [770, 885], "laptop": [930, 715] },           // bottom centre of each thing
      "beats": [
        { "at": 0.3, "who": "ana", "do": "type", "dur": 1.4 },
        { "at": 1.5, "who": "ana", "do": "say", "text": "Another forty-minute render?" },
        { "at": 3.1, "who": "ana", "do": "emote", "as": "frustrated" } ] },
    { "id": "help", "name": "Help arrives", "dur": 5, "in": "fade",
      "place": { "laptop": null, "bulb": [1180, 520] },               // null takes a thing off stage
      "beats": [ { "at": 0.2, "who": "bolt", "do": "enter", "from": "right", "to": [1240, 885] } ] }
  ]
}
```

- Things keep their place from shot to shot unless `place` moves them. The floor is at 82% of the height (y 885 on a 1080 stage); people stand on it.
- Palette names (`ink`, `paper`, `accent`, `soft`, `second`) or any colour work wherever a colour goes. The player shows them as `brand.<name>`.
- `in` is how a shot starts: `cut` (default), `fade`, `wipe`, `push` or `match:<id>` (the camera pushes into that thing and comes out of it in the next shot). `camera: { "on": "ana", "zoom": 1.2 }` frames a shot; `tempo` above 1 makes everything in it quicker.
- Kit props: laptop, phone, screen, doc, box, cloud, database, sign, chart, desk, plant, star, check, bulb, text (`size`, `bold`), arrow (`from` and `to`: ids or points, `bend`). Anything else is `draw` (an SVG path) or `image`. `text` with `{n}` shows a `count` beat's number.
- Every beat has `at` (seconds into the shot) and optional `dur` and `ease` (`linear`, `in`, `out`, `inOut`, `back`, `spring`).

| Verb | Fields | What happens |
|---|---|---|
| `walk`, `run` | `who`, `to` (point or id) | Walks with planted feet; time comes from the distance |
| `enter`, `exit` | `who`, `from`/`to` (`left`, `right` or a point) | Walks in from off stage, or out |
| `say`, `think` | `who`, `text` | Speech or thought bubble, typed on; reading time comes from the words |
| `emote` | `who`, `as` (`happy`, `sad`, `surprised`, `frustrated`, `thinking`, `neutral`) | Face and body |
| `point`, `look` | `who`, `at` (id or point) | Points or turns toward it |
| `wave`, `cheer`, `type`, `nod`, `jump` | `who` | Gestures |
| `pick`, `hand`, `put` | `who`, `what`, `to` (`hand`: a person; `put`: a point) | Picks up, hands over, puts down, along an arc |
| `move` | `what`, `to`, `arc` | Moves a thing |
| `pop`, `fade-in`, `draw-on` | `what` | Appears: springs in, fades in, or draws itself on (charts grow) |
| `fade` | `what`, `to` (0 hides it) | Fades |
| `grow`, `shake` | `what`, `to` (scale) | Emphasis |
| `count` | `what`, `from`, `to` | Rolls a number in its `text` |
| `camera` | `on` (id or point), `zoom` | Moves the camera |

**Plain words to fields:** "slower" is a higher `dur` or a shot `tempo` below 1; "more bounce" is `"ease": "back"` or `"spring"`; "brand colours" is `style.palette`; "make it chalky / cleaner" is `style.preset` or `wobble`; "add a dog" is a new prop (`draw` path) placed in a shot; "she should notice the chart" is a `look` or `point` beat before the line.

Don't draw real people, logos or characters you don't have rights to.

The user can export a scene to MP4, HEVC, ProRes, WebM or GIF from the player's **Export** button (it draws every frame; no render step for you). When they change words or colours in the player they can **Apply** them into `scene.json` themselves as the next version, without you; only notes and moved things come to you.

## 11. Timeline projects: footage, scenes, titles, music and captions together

When the video mixes things (the user's footage, a scene or two, titles and lower thirds, music, captions) or the user asks for a whole video from a brief or a script, make a **timeline project**: a folder with `timeline.json` (and the `scene.json` files its scene clips use) and no `reel.json`. MotionSnip Studio composes it live, gives the user a multi-track editor (move, trim, split, keyframes, transitions, their own media) and exports it with sound. The user's hand edits are saved straight into `timeline.json`, so **read the file fresh before every change and keep what they did**.

**Idea to video:**

1. Turn the brief into beats: a hook (first 2 to 3 s), the story, a payoff, an end card. Pick a length (15 to 30 s for social, 45 to 90 s for an explainer).
2. One marker per beat. Under the markers: footage on video tracks, illustrated parts as scene clips (write their `scene.json` as in section 10), titles on a graphics track, music on an audio track, captions on a captions track.
3. Open the player on the folder: `node "<skill dir>/player/server.mjs" "<folder>"`. Scrub every beat and read the rings (gaps, overlapping clips, missing files, captions too fast to read, text too small or off the frame) and fix them before you show it.
4. A feedback file with a `## New request` section is the user describing something new in the Changes tab: build it into the same `timeline.json`.

**The format:**

```jsonc
{
  "title": "Launch teaser", "version": 1,
  "size": [1920, 1080], "fps": 30, "bg": "#0c0c10",
  "tracks": [                                              // later tracks draw on top
    { "id": "v1", "kind": "video", "name": "Footage", "clips": [
      { "id": "intro", "src": "assets/demo.mp4", "at": 0, "in": 2, "out": 8,     // timeline seconds; source seconds
        "gain": 0.6, "fit": "cover", "look": { "contrast": 0.1, "saturation": 0.2, "warmth": 0, "brightness": 0 },
        "keys": { "scale": [[0, 1], [6, 1.08, "inOut"]] },                      // a slow push-in
        "exit": { "kind": "fade", "dur": 0.5 } } ] },
    { "id": "s1", "kind": "scene", "name": "Story", "clips": [
      { "id": "story", "scene": "scene.json", "shots": ["stuck", "help"], "at": 5.5, "enter": { "kind": "wipe", "dur": 0.4 } } ] },
    { "id": "g1", "kind": "graphics", "name": "Titles", "clips": [
      { "id": "title", "type": "text", "text": "Ship it today", "at": 0.6, "dur": 3, "preset": "pop",
        "box": [10, 38, 80, 24], "style": { "size": 8, "color": "#ffffff", "weight": 800, "bg": null, "align": "center" } },
      { "id": "bar", "type": "shape", "shape": "rect", "at": 2.4, "dur": 3, "box": [6, 76, 30, 9], "fill": "#ff4fa3", "radius": 20 },
      { "id": "logo", "type": "image", "src": "assets/logo.png", "at": 12, "dur": 3, "box": [40, 40, 20, 20], "fit": "contain" },
      { "id": "hide", "type": "blur", "at": 1, "dur": 4, "box": [70, 5, 25, 10], "amount": 12 } ] },
    { "id": "a1", "kind": "audio", "name": "Music", "role": "music", "clips": [
      { "id": "music", "src": "assets/track.mp3", "at": 0, "in": 0, "out": 15, "gain": 0.8, "fadeIn": 1, "fadeOut": 2 } ] },
    { "id": "cc1", "kind": "captions", "name": "Captions", "clips": [
      { "id": "cap1", "at": 6.2, "dur": 2.2, "text": "Tell Claude the idea." } ] }
  ],
  "markers": [ { "id": "hook", "name": "Hook", "t": [0, 5.5] }, { "id": "story", "name": "Story", "t": [5.5, 15] } ]
}
```

- `at` is where a clip starts on the timeline. Video, audio and scene clips play their source from `in` to `out` (a scene clip's length comes from its shots); graphics and captions have `dur`.
- `box` is `[x, y, w, h]` in % of the frame. Text `style.size` is % of the frame height (4 is a lower third, 8 a title); leave room for the text to wrap.
- `keys` animate `x`, `y` (a shift in % of the frame), `scale`, `rotate` (degrees) and `opacity`: `[[t, value, ease?], ...]` with `t` in seconds from the clip's start and ease `linear`, `in`, `out`, `inOut` or `hold`.
- `enter` and `exit` transitions: `fade`, `wipe`, `slide`, `zoom`, each with `dur`. Text `preset`: `none`, `fade`, `pop`, `slide-up`, `type-on`, `word-stagger`. Fonts: `Bricolage Grotesque`, `DM Mono`, `Patrick Hand`, `system-ui`.
- Tracks take `mute`, `solo`, `hide`, `lock` and `gain`. The user locks a track to keep it as it is: don't change clips on a locked track.
- Ids: tracks `v1`, `s1`, `g1`, `a1`, `cc1`; clips any short unique id. Keep them stable: notes, rings and the user's selection follow them. Notes and feedback name paths like `timeline.json › tracks[2].clips[0].text`.
- Media files live in the project (`assets/`). Use only footage, music and images the user gave you or has rights to.

**Plain words to fields:** "tighter" is shorter clips and less space between them; "punchier titles" is `pop` or `word-stagger`, a heavier `weight`, a bigger `size`; "a slow zoom" is `scale` keys from 1 to 1.05–1.1; "softer cut" is an `enter`/`exit` fade of 0.3–0.6 s; "music too loud under the voice" is a lower music `gain`; "subtitles" are a captions track, one short line per clip, at least about 1 s per 3 words.

The user exports from the player (MP4, HEVC, ProRes, WebM, GIF; 720p to 4K; captions drawn in or saved as `.srt` and `.vtt`), and makes 9:16, 1:1 and bumper versions from the export with **Cutdown**. Bump `version` in `timeline.json` when you finish a round, as with any project.
