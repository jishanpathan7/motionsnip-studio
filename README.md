<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.svg">
    <img alt="MotionSnip Studio" src="docs/brand/logo-light.svg" height="56">
  </picture>
</h1>

**Review the videos Claude builds in code, fix them in place, and send one prompt back.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img alt="The MotionSnip Studio player: a video frame with a circled note, the timeline below and the Changes panel on the right" src="docs/screenshot-light.png">
</picture>

## How it works

1. You ask Claude for a motion graphic: a launch video, an explainer, a product promo.
2. Claude builds it in code (for example with Remotion), renders it, and describes it in `reel.json`.
3. Claude opens the player. You watch it on your own machine.
4. You fix words in place, swap the music, set levels, move things, and circle problems on the frame.
5. You mark each scene **Approved** or **Needs changes**. Claude leaves approved scenes alone.
6. You click **Send to Claude**. The player writes your changes to a file and copies one line to your clipboard.
7. You paste that line to Claude. Claude applies the changes, re-renders and bumps the version.
8. The player reloads by itself and helps you check each change. Repeat until every scene is approved.
9. You click **Export** to get the final mp4, with the music you picked mixed in.

Everything runs locally. The player is a small Node server bound to `127.0.0.1` and a web page. No accounts, no cloud, no build step, no dependencies.

## Install

You need [Claude Code](https://claude.com/claude-code) and Node 18 or newer. Export also needs [ffmpeg](https://ffmpeg.org).

```bash
git clone https://github.com/jishanpathan7/motionsnip-studio.git ~/.claude/skills/motionsnip-studio
```

Or, with the GitHub CLI: `gh repo clone jishanpathan7/motionsnip-studio ~/.claude/skills/motionsnip-studio`.

That's it. Restart Claude Code and it finds the skill.

## Try it in a minute

Open the player on the demo project that ships with it:

```bash
node ~/.claude/skills/motionsnip-studio/player/server.mjs ~/.claude/skills/motionsnip-studio/examples/demo
```

Your browser opens the player. Press Space to play, pause on the opening headline and click it to change its words, right-click the frame to pin a note, then open the **Changes** tab to see everything Send to Claude will pass on.

## Update or remove

```bash
git -C ~/.claude/skills/motionsnip-studio pull    # update
rm -rf ~/.claude/skills/motionsnip-studio         # remove
```

Your projects keep their own `reel.json`, `.motionsnip/` history and `exports/`, so removing the skill doesn't touch them.

## Use

Ask Claude for a video:

> Make a 30 second launch video for Acme. Upbeat, our brand colours, a few big headlines.

Claude builds it and opens the player. When you're done reviewing, click **Send to Claude** and paste the line it copies:

> Apply the MotionSnip Studio feedback in /path/to/project/.motionsnip/feedback-v1.md

You can also start the player yourself on any project folder with a `reel.json`:

```bash
node ~/.claude/skills/motionsnip-studio/player/server.mjs path/to/project
```

Options: `--port 4321` (moves to the next free port if busy), `--no-open`, `--ffmpeg /path/to/ffmpeg`.

## Edit any video

The player also opens a plain video file, with no `reel.json`: a screen recording, a phone clip, a render from any tool.

```bash
node ~/.claude/skills/motionsnip-studio/player/server.mjs path/to/clip.mp4
```

Pointing it at a folder without a `reel.json` opens the newest video in it. In the **Edit** tab you can:

- **Trim** the start and end (`I` and `O` at the playhead) and **cut parts out** (`X` at the start of a part, `X` again at its end). The preview plays the edited cut.
- Put **text**, a **logo** (drop a png, jpg or webp on the page) or a **blur box** on the frame, each for as long as you choose.
- Set the **colour**: brightness, contrast, saturation, warmth. Hold `\` to compare with the original.

**Export with your edits** re-encodes the video with all of it, plus any music you picked on the **Sound** tab. The original file stays as it is. Notes you pin on the frame still go to Claude with **Send to Claude**. Exporting edits needs an ffmpeg build with the `overlay`, `gblur`, `colorchannelmixer` and `lutrgb` filters; the standard builds have them.

## Player controls

| Key or action | What it does |
|---|---|
| Space | Play or pause |
| ← → or `,` `.` | Step one frame |
| Shift + ← → | Jump one second |
| Home / End | Go to the start or end |
| `[` `]` | Previous or next scene |
| `L` | Loop the current scene |
| `<` `>` | Slower or faster (0.25× to 2×) |
| `F` or double-click an empty spot | Fullscreen |
| `M` | Mute |
| `A` | Approve the current scene |
| Hold `V` | Show the previous version at the same frame |
| `?` | Show all shortcuts |
| Esc | Cancel, deselect or leave fullscreen |
| Click an element | Select it and open its settings |
| Double-click an element, or Enter | Edit its text in place |
| Drag an element or its corner | Move or resize it |
| Right-click, or `C` | Pin a note at that spot and time |
| Drag the music lane | Change when the music starts |
| Drag the end of the music lane | Set the fade-out |
| Drop an audio file on the page | Use it as the music |
| `I` `O` (plain video) | Trim the start or end at the playhead |
| `X` … `X` (plain video) | Cut out the part between the two presses |
| `T` (plain video) | Add text on the frame |
| Hold `\` (plain video) | See the original, without your edits |

Side panel tabs: **Edit** (the selected element), **Script** (every line of text in time order), **Look** (brand colours, fonts, logo), **Sound** (music, start, fade, levels) and **Changes** (everything you changed, with undo, and the Send button).

Deep links: `#t=12.5&el=headline`, `#tab=sound`, `?theme=dark`.

## What Claude receives

When you send, the player writes `.motionsnip/feedback-v<N>.md` in the project and copies one line to your clipboard. The file looks like this:

```
MotionSnip Studio feedback for "Acme launch" v3
Project: /path/to/acme · 1920x1080 · 30 fps · 32s

## Exact changes
- [00:01.2 · S1 · Headline] Text (src/Hook.tsx:12): "Meet Acme" -> "Say hi to Acme"
- [00:06.0 · S2 · Card] Size and position (src/Cards.tsx:20): [10, 30, 35, 40] -> [8, 28, 39, 44] (scale 1.12)

## Sound settings
- Audio · Music track: "track.mp3" -> "upbeat.mp3" (uploaded in MotionSnip Studio, already in assets/)
- Audio · Music start offset (s): 0 -> 2
- Audio · Music volume (0-1): 1 -> 0.6
The video carries sound effects only; music is a separate file.

## Comments on the frame
1. [00:23.9 · S4 Outro · x 23.9% y 81.8% · on Logo (src/Outro.tsx:9)] Logo feels too small here

## Scenes
S1 Hook (00:00.0-00:04.5): approved
S2 Cards (00:04.5-00:12.0): needs changes

Next version: set "version" to 4 in reel.json.
```

Edits are exact values. Notes are requests, tied to a time and a spot on the frame, so Claude can grab that frame and look.

## reel.json

`reel.json` describes the video for the player: its file, size and length, the scenes, and the elements in each scene with their position on the frame and their editable values. Claude writes it. The full schema is in [`SKILL.md`](SKILL.md) and [`docs/SPEC.md`](docs/SPEC.md). A working example is in [`examples/demo/reel.json`](examples/demo/reel.json).

The key ideas:

- Each element has a `box` (x, y, w, h in % of the frame), so you can click it.
- Each element has `props` with types (`text`, `color`, `number`, `list`, `motion`…), so the player knows how to edit them.
- `version` goes up on every render, and the player reloads when it changes.
- Music is its own file (`audio.music`), and the video carries only sound effects. So you can swap the track and set levels without a re-render.

## Security

- The server listens on `127.0.0.1` only.
- It rejects requests whose `Host` header isn't `localhost:<port>` or `127.0.0.1:<port>`. This blocks DNS rebinding.
- Every POST must come from the player page itself (checked with the `Origin` header).
- Project files are served only from inside the project folder. Hidden files such as `.env` are never served.
- Uploads accept only mp3, wav and m4a, up to 100 MB. The first bytes must match the file type. Names are cleaned and files are never overwritten.
- "Show in Finder" works only for files inside the project.
- If `reel.json` has an `export.cmd`, the render export runs that command on your machine, like an npm script. Only open projects you trust.

## Tests

```bash
node player/server.mjs --selftest
```

It checks byte ranges, upload name cleaning, file type sniffing, the host and origin checks, the ffmpeg mix arguments, and runs a real upload against a temporary project. It prints `selftest ok`.

## Troubleshooting

**Claude doesn't open the player.**
Restart Claude Code after installing, so it loads the skill. Check that `~/.claude/skills/motionsnip-studio/SKILL.md` exists. You can also ask for it by name: "Use MotionSnip Studio to review this video."

**The video doesn't load.**
`src` in `reel.json` must point at the rendered file, relative to the project folder. Ask Claude to re-render, or fix the path.

**The player didn't reload after a new render.**
It reloads when `version` in `reel.json` goes up. Ask Claude to bump it, or reload the page.

**Port 4321 is busy.**
The server moves to the next free port and prints the address. Use `--port` to pick one.

## FAQ

**Does anything leave my machine?**
Only one request: the player page loads its fonts from Google Fonts. Your video, music, edits and notes stay on your machine.

**Where are my edits saved?**
In your browser's storage and in `.motionsnip/state.json` in the project folder. Closing the tab doesn't lose them. Each round you send is kept as `.motionsnip/feedback-v<N>.md`. Exports go to `exports/` and are never overwritten.

**Do I need Remotion?**
No. Any tool that renders an mp4, webm or mov works. Claude only needs to write `reel.json` next to it. Remotion is a good default because everything is code.

**What about Remotion's licence?**
Remotion is free for individuals and for companies of up to 3 people. Bigger companies need a company licence from [remotion.dev](https://www.remotion.dev/license). MotionSnip Studio doesn't include Remotion.

**Why is the music a separate file?**
So you can try another track, move its start or change the levels without waiting for a render. Export mixes it into the final mp4 with ffmpeg.

**Export says ffmpeg isn't found.**
Install it (`brew install ffmpeg` on macOS), or start the server with `--ffmpeg /path/to/ffmpeg`. A Remotion project's bundled ffmpeg is also found automatically.

## Files

```
SKILL.md              the Claude Code skill
player/server.mjs     the local server (Node 18+, no dependencies)
player/index.html     the player page
player/app/           the player's scripts and styles
docs/SPEC.md          the full product spec
docs/brand/           logo, favicons and the brand guide
examples/demo/        a small example project (synthetic video and music)
```

## Licence

[MIT](LICENSE). Copyright (c) 2026 Jishan Pathan.
