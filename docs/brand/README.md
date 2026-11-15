# MotionSnip Studio brand

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo-dark.svg">
  <img alt="MotionSnip Studio" src="logo-light.svg" height="56">
</picture>

## The idea: the cue mark

In cinemas, a small dot flashed in the top-right corner of the frame told the projectionist the next reel was ready. MotionSnip uses the same dot. It means "something here needs you" or "the next version is ready". The project file is even called `reel.json`.

The dot appears in the logo, the favicon, notes on the frame, the Changes list and the moment a new version loads. Learn it once and the whole player reads the same way.

Notes are pinned with a **drawn ring**, like a director circling a problem on the frame in dailies.

## Assets

| File | Use |
|---|---|
| `logo-dark.svg`, `logo-light.svg` | Symbol + wordmark, for dark and light grounds |
| `wordmark-dark.svg`, `wordmark-light.svg` | Wordmark alone |
| `symbol.svg` | Symbol; switches ink/paper with the viewer's theme |
| `app-icon.svg`, `app-icon-1024.png` | App icon |
| `favicon.svg` | Default favicon (bay tile, readable on any tab strip) |
| `favicon-idle/-notes/-rendering/-ready.svg` | Favicon states (the player draws these live) |
| `banner.svg` | 1280×640 social card |

All text in the SVGs is outlined, so the files look right without the fonts installed.

**Symbol rules.** The frame is a 3:2 rounded rectangle. The dot sits inside its top-right corner, with the frame's padding around it. Don't move the dot to another corner or outside the frame. Don't add a play triangle.

## Colour

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| Bay | `#15121D` | — | Page background, dark |
| Bench | `#211C2B` | `#FFFFFF` | Panels |
| Paper | `#F6F4EF` | `#F6F4EF` | Text on dark; page background, light |
| Ink | — | `#15121D` | Text on light |
| Grain / Lead | `#A49DB3` | `#6A6378` | Secondary text |
| **Cue** | `#FF4FA8` | `#C2185B` | Notes, drawn rings, "new version ready", attention |
| **Tape** | `#E8FF47` | `#E8FF47` | Fill only: Send, edited elements, the change count |

Rules:
- **Cue is for attention, tape is for your changes.** That split is the whole colour system.
- Tape yellow is never text and never sits on Paper without an ink border. Text on tape is always Bay (16.6:1).
- Cue pink as text: `#FF4FA8` on Bay (6.1:1), `#C2185B` on Paper (5.3:1).
- Status colours (approved green, error red) stay separate from Cue and Tape.

## Type

- **Bricolage Grotesque** for headings and the wordmark. Use 800 at display sizes and 500–600 for UI text.
- **DM Mono** for timecode, frame numbers, versions and keyboard keys.

## Motion

| Moment | What happens | Reduced motion |
|---|---|---|
| Pin a note | The ring draws itself around the spot (about 420 ms), then the number drops in | Ring appears complete |
| Edit an element | A tape tab lands on the element's corner and on the timeline | Tab appears |
| Send | The button becomes a countdown sweep, and so does the favicon | Static "Waiting for v2" |
| New version | The cue dot flashes twice in the frame's corner, like a reel changeover, and the version rolls over | One steady dot for a second |

## Icons

1.6–2 px strokes, rounded joins, frames drawn as 3:2 rounded rectangles. Colour appears only when it means something: a cue dot or a tape fill.

## Voice

Plain and short, from the reviewer's side. "v2 is in · 3 changes applied." "Nothing circled yet." Say "notes" and "changes", not "feedback items".
