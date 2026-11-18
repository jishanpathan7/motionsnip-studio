# Render benchmark

This benchmark measures how much CPU a minute of exported video costs, for each way MotionSnip exports. It's the
number every hosted-rendering cost estimate depends on.

```bash
node player/bench/render.mjs                       # scene, timeline and plain cases at 1080p30, MP4
node player/bench/render.mjs --size 2160 --runs 2  # 4K, two runs each
node player/bench/render.mjs --no-gpu --json out.json
```

**What you need:**
- Node 22 or later, for its built-in WebSocket;
- `ffmpeg` and `ffprobe` on your PATH;
- `/usr/bin/time`;
- Chrome, Chromium or Brave. Pass `--chrome <path>` or set `CHROME_PATH` if it isn't found.

**Cases:**
- **scene** draws `examples/scene-demo` frame by frame in headless Chrome, turning SVG into pixels, and encodes it
  with ffmpeg.
- **timeline** composites `examples/timeline-demo` in headless Chrome: footage, a scene clip, graphics and music.
  The server mixes the sound.
- **plain** generates a busy 1080p30 video with sound, `--seconds` long, then exports it with one cut and a colour
  look. ffmpeg does all the work.

**How it's measured:**
- Each case gets its own server and its own Chrome, both run under `/usr/bin/time`. That way the ffmpeg runs the
  server waits for are counted too.
- Chrome's CPU is its whole process tree, read before and after the export, so page load isn't counted.
- Wall time is the export alone.

## Results

All runs below: 2026-11-18, MacBook Pro M1 Pro (10 cores), Node 22.15, ffmpeg 9.0.2, Chrome headless, MP4 (H.264),
30 fps, two runs each. CPU figures are CPU-minutes per output minute.

| Case | Size | GPU | Realtime | Chrome CPU | Server + ffmpeg CPU | CPU-min per output min |
|---|---|---|---|---|---|---|
| scene | 1080p | on | 1.2–1.3× | 12.6–12.7 s | 15.6–15.7 s | 2.0 |
| scene | 1080p | off | 0.9–1.3× | 13.0–14.2 s | 15.7–17.4 s | 2.1–2.3 |
| timeline | 1080p | on | 0.8–0.9× | 23.2–23.4 s | 18.1–18.3 s | 2.8 |
| timeline | 1080p | off | 0.8× | 23.0–23.3 s | 18.2–19.1 s | 2.7–2.8 |
| scene | 720p | off | 2.2–2.5× | 7.0–7.1 s | 7.3–7.4 s | 1.0 |
| timeline | 720p | off | 1.5× | 12.4–13.0 s | 8.8–9.2 s | 1.4–1.5 |
| scene | 4K | off | 0.3–0.4× | 41.5–43.9 s | 63.3–67.5 s | 7.5–8.0 |
| timeline | 4K | off | 0.3× | 68.7–68.9 s | 68.2–68.7 s | 9.1–9.2 |
| plain (54 s output) | 1080p | n/a | 4.3–4.7× | none | 84.8–86.4 s | 1.6 |

**What the numbers say:**
- **The GPU makes no measurable difference,** so CPU-only machines are fine for frame exports.
- **Cost grows with pixel count.** Going from 1080p to 4K costs about 3.5× as much.
- **ffmpeg takes about half the CPU in frame exports.** It reads raw RGBA frames and encodes them. Chrome takes the
  other half: drawing the frames and, for timelines, seeking `<video>` for every frame.
- **Timelines cost about 35% more than scenes,** because each frame decodes its footage in the browser. A server-side
  `compose.mjs` that decodes footage in ffmpeg and has the browser draw only the overlay would cut this.

**Converting to cloud vCPUs is an estimate.** A cloud vCPU is a hyperthread on a server core, usually slower than an
M1 Pro performance core. The table converts at 1 M1 core to roughly 1.5–2 vCPUs; that ratio is an assumption, not a
measurement.

| Export | vCPU-min per output min (est.) |
|---|---|
| 1080p | about 3–6 |
| 720p | about 1.5–3 |
| 4K | about 11–18 |

Run the benchmark on the target machine type before pricing render minutes.
