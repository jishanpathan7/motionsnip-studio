# MotionSnip Studio: notes for agents working on this repo

## Verification loop (required for every code change)

Every change follows the `verification-loop` skill in `.claude/skills/verification-loop/`: Understand →
Test → Run → Analyze → Fix → Retest → Final validation → Report. No skipped, weakened or unexecuted tests count
as passing; a check that can't run is a blocker to report, not a pass. Re-run everything below after the final
change and put the results in the reply and in any PR description.

Passing verification is not permission. Don't push, open a PR, or merge without the maintainer's explicit
go-ahead for that action. **Merging to `main` deploys motionsnip.com** (Vercel runs `node site/build.mjs`).

## How this repo verifies itself

There is no CI and no `package.json`: the core is plain Node 18+ with built-in modules only. Keep it
dependency-free. The checks are:

| Check | Command | Passes when |
|---|---|---|
| Server, player logic, add-ons, Pro licence | `node player/server.mjs --selftest` | it prints `selftest ok` and exits 0 (with a full ffmpeg it also runs real renders) |
| Site build (what Vercel deploys) | `node site/build.mjs` | it builds into `dist/` with no error |
| Export cost (only when the change touches rendering) | `node player/bench/render.mjs --size 1080 --runs 2` | it completes; compare with the base branch |

Add new checks to `--selftest` (in `player/server.mjs` or the `player/lib` module it exercises) rather than adding
a test framework.

## Real user behaviour

For any change a user can see, run the player and use it:

```bash
node player/server.mjs examples/timeline-demo --port 4350 --no-open
```

- Open it in a browser and drive the changed flow. Watch the console and the network for errors.
- Existing projects must behave as before. Check each kind that the change could touch: `examples/demo` (a
  reel), `examples/scene-demo`, `examples/timeline-demo`, and a plain video file.
- Check light and dark themes and a narrow (phone) width.
- For export changes, export an MP4 and check it with `ffprobe`: duration, size and streams. Then look at
  frames from it.
- A missing engine or add-on means the feature is hidden, never faked.
- Use a free port. Don't stop or reuse servers someone else is running.

## Pro and the licence

- The Pro add-on and the licence Worker live in a separate **private** repo. Nothing from it is copied here.
- Never commit a private signing key, a licence key, or a real licence file. The selftest uses throwaway keys
  that it generates.
- Licence and package signature changes must keep the selftest's tamper cases (a bad signature, another install,
  an edited `addon.json` date, a missing or tampered `.package.json`) failing closed.
