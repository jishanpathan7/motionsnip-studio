# Install MotionSnip Studio

MotionSnip Studio is a skill for [Claude Code](https://claude.com/claude-code). One clone sets it up, and everything runs on your own computer: a small Node server bound to `127.0.0.1` and a page in your browser. No account, no build step, no dependencies to install.

## What you need

- [Claude Code](https://claude.com/claude-code)
- Node 18 or newer (`node --version` to check)
- [ffmpeg](https://ffmpeg.org) for exports, cutdowns and editing a video file. On macOS: `brew install ffmpeg`. Reviewing works without it.

## 1. Install the skill

Clone it into your Claude Code skills folder:

```bash
git clone https://github.com/jishanpathan7/motionsnip-studio.git ~/.claude/skills/motionsnip-studio
```

Or, with the GitHub CLI:

```bash
gh repo clone jishanpathan7/motionsnip-studio ~/.claude/skills/motionsnip-studio
```

The skill's instructions for Claude are always at [motionsnip.com/skill.md](/skill.md), the same file as `SKILL.md` in the folder you cloned. You can read them as a page in [the skill docs](/docs/skill/).

## 2. Restart Claude Code, then ask

Restart Claude Code so it loads the skill, then ask for a video:

> Make a 30 second launch video for Acme. Upbeat, our brand colours, a few big headlines.

Claude builds it, checks its own render and opens the player. When you're done, click **Send to Claude** and paste the line it copies back to Claude.

## 3. Try the demo project

Open the player on the demo that ships with the skill, no Claude needed:

```bash
node ~/.claude/skills/motionsnip-studio/player/server.mjs ~/.claude/skills/motionsnip-studio/examples/demo
```

Your browser opens the player. Press Space to play, click the opening headline to change its words, right-click the frame to pin a note, then open the **Changes** tab. Or try it in your browser first: [the live demo](/demo/).

## 4. Open a video you already have

The player also edits any video file: trim, cut parts out, add text, a logo or a blur box, set the colour, and export.

```bash
node ~/.claude/skills/motionsnip-studio/player/server.mjs clip.mp4
```

Options: `--port 4321` (moves to the next free port if busy), `--no-open`, `--ffmpeg /path/to/ffmpeg`.

## Update or remove

```bash
git -C ~/.claude/skills/motionsnip-studio pull
```

```bash
rm -rf ~/.claude/skills/motionsnip-studio
```

Your projects keep their own `reel.json`, `.motionsnip/` history and `exports/`, so removing the skill doesn't touch them.

## Troubleshooting

**Claude doesn't open the player.**
Restart Claude Code after installing, so it loads the skill. Check that `~/.claude/skills/motionsnip-studio/SKILL.md` exists. You can also ask for it by name: "Use MotionSnip Studio to review this video."

**Export says ffmpeg isn't found.**
Install it (`brew install ffmpeg` on macOS), or start the server with `--ffmpeg /path/to/ffmpeg`. A Remotion project's bundled ffmpeg is also found automatically.

**The video doesn't load.**
`src` in `reel.json` must point at the rendered file, relative to the project folder. Ask Claude to re-render, or fix the path.

**Port 4321 is busy.**
The server moves to the next free port and prints the address. Use `--port` to pick one.

More in [the docs](/docs/#troubleshooting) and the [FAQ](/docs/#faq).
