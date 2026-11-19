// The docs pages: README.md, docs/SPEC.md and SKILL.md from the repo, and site/install.md, rendered with
// site/md.mjs into one page template. Used by site/build.mjs; no dependencies.
import path from 'node:path';
import { render } from './md.mjs';

const REPO = 'https://github.com/jishanpathan7/motionsnip-studio';

/** The pages, in sidebar order. `file` is the source, relative to the repo root; `url` where it is served. */
export const PAGES = [
  { file: 'site/install.md', url: '/install/', nav: 'Install', title: 'Install MotionSnip Studio', description: 'Install the MotionSnip Studio skill for Claude Code: requirements, one git clone, the demo project, opening a video, updating and removing.' },
  { file: 'README.md', url: '/docs/', nav: 'Guide', title: 'MotionSnip Studio docs', description: 'How MotionSnip Studio works: the review loop with Claude, editing any video, cutdowns, animated scenes, timeline projects and the player controls.' },
  { file: 'SKILL.md', url: '/docs/skill/', nav: 'Claude skill', title: 'The MotionSnip Studio skill', description: 'The instructions Claude Code follows to build a video, describe it in reel.json, open the player and apply your feedback.' },
  { file: 'docs/SPEC.md', url: '/docs/spec/', nav: 'Spec', title: 'MotionSnip Studio spec', description: 'The product spec: the project folder, the reel.json contract, the local server and its API, the player, the feedback file, scenes and timelines.' },
];

const byFile = new Map(PAGES.map((p) => [p.file, p.url]));

/** A link or image path as written in `from` (a repo-relative file) → its address on the site. */
export function siteLink(href, from) {
  if (/^([a-z]+:|#|\/)/i.test(href)) return href;
  const [p, hash = ''] = href.split('#');
  const file = path.posix.normalize(path.posix.join(path.posix.dirname(from), p));
  const anchor = hash ? `#${hash}` : '';
  if (byFile.has(file)) return byFile.get(file) + anchor;
  const shot = /^docs\/(screenshot-[\w-]+\.png)$/.exec(file);
  if (shot) return `/${shot[1]}`;
  if (file.startsWith('docs/brand/') && /\.(svg|png)$/.test(file)) return `/app/brand/${file.slice('docs/brand/'.length)}`;
  return `${REPO}/blob/main/${file}${anchor}`;
}

/** A raw HTML block from the Markdown: the README's logo heading is dropped (the page has its own), and its
 *  src/srcset paths point at the site's copies. */
function htmlBlock(block, from) {
  if (/^<h1>[\s\S]*<picture>/.test(block)) return '';
  return block.replace(/\b(src|srcset|href)="([^"]+)"/g, (_, attr, v) => `${attr}="${siteLink(v, from)}"`).replace(/<img /g, '<img loading="lazy" ');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One page's HTML. */
export function page(pg, md) {
  const doc = render(md, { link: (h) => siteLink(h, pg.file), html: (b) => htmlBlock(b, pg.file) });
  // the README's own heading was the logo; give the page a plain one
  const body = /<h1[\s>]/.test(doc.html) ? doc.html : `<h1>${esc(pg.title)}</h1>\n${doc.html}`;
  const pagesNav = PAGES.map((p) => `<a href="${p.url}"${p.url === pg.url ? ' aria-current="page"' : ''}>${esc(p.nav)}</a>`).join('');
  const toc = doc.toc.length > 2 ? `<nav class="toc" aria-label="On this page"><p>On this page</p>${doc.toc.map((t) => `<a href="#${t.id}">${t.text}</a>`).join('')}</nav>` : '';
  const source = `${REPO}/blob/main/${pg.file}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(pg.title)}</title>
<meta name="description" content="${esc(pg.description)}">
<link rel="canonical" href="https://motionsnip.com${pg.url}">
<meta property="og:title" content="${esc(pg.title)}">
<meta property="og:description" content="${esc(pg.description)}">
<meta property="og:url" content="https://motionsnip.com${pg.url}">
<meta property="og:image" content="https://motionsnip.com/og.png">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/app/brand/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400..800&family=DM+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/docs.css">
</head>
<body>
<div class="wrap">
  <header class="top">
    <a href="/" aria-label="MotionSnip Studio home">
      <img class="logo logo-dark" src="/app/brand/logo-dark.svg" alt="MotionSnip Studio" width="200" height="34">
      <img class="logo logo-light" src="/app/brand/logo-light.svg" alt="" width="200" height="34">
    </a>
    <nav>
      <a href="/docs/"${pg.url.startsWith('/docs/') ? ' aria-current="page"' : ''}>Docs</a>
      <a href="/install/"${pg.url === '/install/' ? ' aria-current="page"' : ''}>Install</a>
      <a href="/demo/">Demo</a>
      <a class="hide-sm" href="${REPO}">GitHub</a>
    </nav>
  </header>
  <div class="docs">
    <aside>
      <nav class="pages" aria-label="Docs">${pagesNav}</nav>
      ${toc}
    </aside>
    <main class="prose">
${body}
      <p class="edit"><a href="${source}">View this page on GitHub</a></p>
    </main>
  </div>
  <footer>
    <span>MotionSnip Studio · <a href="${REPO}/blob/main/LICENSE">MIT licence</a></span>
    <span><a href="/docs/">Docs</a> · <a href="/install/">Install</a> · <a href="/demo/">Live demo</a> · <a href="${REPO}">Source on GitHub</a></span>
  </footer>
</div>
<script>
document.querySelectorAll('.code .copy').forEach((b) => b.addEventListener('click', async () => {
  const text = b.closest('.code').querySelector('pre').innerText.replace(/\\n$/, '');
  try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
  catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1800);
}));
</script>
</body>
</html>
`;
}
