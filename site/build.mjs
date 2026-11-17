// Builds the public website into dist/: the landing page at /, and the real player
// running the bundled demo at /demo/, with /api/* answered in the browser (demo-shim.js).
// No dependencies. Run: node site/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, page } from './docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const rel = (...p) => path.join(ROOT, ...p);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const copy = (from, to) => fs.cpSync(rel(from), path.join(OUT, to), { recursive: true });

// landing page and its images
copy('site/index.html', 'index.html');
// the opening keyframe world
copy('site/world.js', 'world.js');
copy('site/world.css', 'world.css');
copy('site/og.png', 'og.png');
copy('docs/screenshot-dark.png', 'screenshot-dark.png');
copy('docs/screenshot-light.png', 'screenshot-light.png');
// the animated hero, prebuilt by site/hero/build.mjs
copy('site/hero/dist', 'hero');

// player app; the local server serves /app/brand/* from docs/brand
copy('player/app', 'app');
copy('docs/brand', 'app/brand');
copy('site/demo-shim.js', 'demo-shim.js');

// demo page: the player's own index.html with the shim loaded before the app
const player = fs.readFileSync(rel('player/index.html'), 'utf8');
const marker = '<script type="module" src="/app/main.js"></script>';
if (!player.includes(marker)) throw new Error('player/index.html no longer loads /app/main.js the expected way');
const demo = player
  .replace('<title>MotionSnip Studio</title>', '<title>MotionSnip Studio demo</title>')
  .replace(marker, `<script src="/demo-shim.js"></script>\n    ${marker}`);
fs.mkdirSync(path.join(OUT, 'demo'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'demo', 'index.html'), demo);

// demo project files, served where the player expects them (/p/*)
for (const f of ['reel.json', 'video.mp4', 'music.mp3', 'outputs']) copy(`examples/demo/${f}`, `p/${f}`);

// docs and install pages, rendered from the repo's Markdown (site/docs.mjs), and the skill itself as a
// stable link (/skill.md)
copy('site/docs.css', 'docs.css');
for (const pg of PAGES) {
  const dir = path.join(OUT, pg.url);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), page(pg, fs.readFileSync(rel(pg.file), 'utf8')));
}
copy('SKILL.md', 'skill.md');

const count = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
console.log(`Built ${count(OUT)} files into dist/`);
