// The docs pages: README.md, docs/SPEC.md and SKILL.md from the repo, site/install.md, the legal pages in
// site/legal/ and, when site/pro.json has checkout links, the Pro page (site/pro.md), rendered with site/md.mjs
// into one page template. Used by site/build.mjs; no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { render } from './md.mjs';

const REPO = 'https://github.com/jishanpathan7/motionsnip-studio';

/** The pages, in sidebar order. `file` is the source, relative to the repo root; `url` where it is served;
 *  `group` which sidebar list it's in ('docs' or 'legal'). */
export const PAGES = [
  { file: 'site/install.md', group: 'docs', url: '/install/', nav: 'Install', title: 'Install MotionSnip Studio', description: 'Install the MotionSnip Studio skill for Claude Code: requirements, one git clone, the demo project, opening a video, updating and removing.' },
  { file: 'README.md', group: 'docs', url: '/docs/', nav: 'Guide', title: 'MotionSnip Studio docs', description: 'How MotionSnip Studio works: the review loop with Claude, editing any video, cutdowns, animated scenes, timeline projects and the player controls.' },
  { file: 'SKILL.md', group: 'docs', url: '/docs/skill/', nav: 'Claude skill', title: 'The MotionSnip Studio skill', description: 'The instructions Claude Code follows to build a video, describe it in reel.json, open the player and apply your feedback.' },
  { file: 'docs/SPEC.md', group: 'docs', url: '/docs/spec/', nav: 'Spec', title: 'MotionSnip Studio spec', description: 'The product spec: the project folder, the reel.json contract, the local server and its API, the player, the feedback file, scenes and timelines.' },
  { file: 'site/legal/pro-licence.md', group: 'legal', url: '/legal/pro-licence/', nav: 'Pro licence', title: 'MotionSnip Pro licence', description: 'The licence for MotionSnip Pro: one seat per person, personal or commercial use, 3 devices, the perpetual fallback, and the core staying MIT.' },
  { file: 'site/legal/refunds.md', group: 'legal', url: '/legal/refunds/', nav: 'Refunds', title: 'MotionSnip Pro refund policy', description: 'Refunds for MotionSnip Pro: any charge within 14 days, in full, through Polar as merchant of record.' },
  { file: 'site/legal/privacy.md', group: 'legal', url: '/legal/privacy/', nav: 'Privacy', title: 'MotionSnip privacy', description: 'What the MotionSnip website and app send: the app sends nothing unless you use Pro, and Pro sends only your licence key and a hashed install ID. No telemetry.' },
];

/** The Pro pricing page. Built only when site/pro.json has both checkout links (readPro). */
export const PRO_PAGE = { file: 'site/pro.md', group: 'legal', url: '/pro/', nav: 'Pro', title: 'MotionSnip Pro', description: 'MotionSnip Pro: a UI-demo kit and more packs on top of the free, open-source MotionSnip Studio. Works offline, 3 devices, and you keep the versions released while you paid.' };

/** site/pro.json → { checkout: { monthly, yearly } }, or null when the file is missing or a link is empty (then
 *  there's no Pro page and no Buy button). A file that's there but malformed, or a link that isn't https, throws. */
export function readPro(file) {
  if (!fs.existsSync(file)) return null;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${path.basename(file)} isn't valid JSON: ${e.message}`);
  }
  const checkout = {};
  for (const plan of ['monthly', 'yearly']) {
    const url = typeof cfg?.checkout?.[plan] === 'string' ? cfg.checkout[plan].trim() : '';
    if (!url) return null;
    if (!/^https:\/\/[^\s"'<>]+$/.test(url)) throw new Error(`${path.basename(file)}: checkout.${plan} must be an https:// link`);
    checkout[plan] = url;
  }
  return { checkout };
}

/** The Pro page's Markdown with its {{checkout.monthly}} and {{checkout.yearly}} links filled in. */
export function fillPro(md, pro) {
  const out = md.replace(/\{\{checkout\.(monthly|yearly)\}\}/g, (_, plan) => esc(pro.checkout[plan]));
  if (/\{\{/.test(out)) throw new Error('site/pro.md has a placeholder readPro does not fill');
  return out;
}

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
  // notes for whoever edits the page stay in the Markdown
  if (/^<!--[\s\S]*-->$/.test(block.trim())) return '';
  return block.replace(/\b(src|srcset|href)="([^"]+)"/g, (_, attr, v) => `${attr}="${siteLink(v, from)}"`).replace(/<img /g, '<img loading="lazy" ');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One page's HTML. `pro`: the Pro page is built too, so link to it. */
export function page(pg, md, { pro = false } = {}) {
  const doc = render(md, { link: (h) => siteLink(h, pg.file), html: (b) => htmlBlock(b, pg.file) });
  // the README's own heading was the logo; give the page a plain one
  const body = /<h1[\s>]/.test(doc.html) ? doc.html : `<h1>${esc(pg.title)}</h1>\n${doc.html}`;
  // the sidebar lists the pages in this page's group: the docs, or Pro and the legal pages
  const link = (p) => `<a href="${p.url}"${p.url === pg.url ? ' aria-current="page"' : ''}>${esc(p.nav)}</a>`;
  const group = (pro ? [...PAGES, PRO_PAGE] : PAGES).filter((p) => p.group === pg.group);
  if (pro && pg.group === 'legal') group.unshift(group.pop());
  const pagesNav = group.map(link).join('');
  const proNav = pro ? `\n      <a href="/pro/"${pg.url === '/pro/' ? ' aria-current="page"' : ''}>Pro</a>` : '';
  const proFoot = pro ? ' · <a href="/pro/">Pro</a>' : '';
  const legalFoot = PAGES.filter((p) => p.group === 'legal').map((p) => `<a href="${p.url}">${esc(p.nav)}</a>`).join(' · ');
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
      <a href="/demo/">Demo</a>${proNav}
      <a class="hide-sm" href="${REPO}">GitHub</a>
    </nav>
  </header>
  <div class="docs">
    <aside>
      <nav class="pages" aria-label="${pg.group === 'legal' ? 'Pro and legal' : 'Docs'}">${pagesNav}</nav>
      ${toc}
    </aside>
    <main class="prose">
${body}
      <p class="edit"><a href="${source}">View this page on GitHub</a></p>
    </main>
  </div>
  <footer>
    <span>MotionSnip Studio · <a href="${REPO}/blob/main/LICENSE">MIT licence</a></span>
    <span><a href="/docs/">Docs</a> · <a href="/install/">Install</a> · <a href="/demo/">Live demo</a>${proFoot} · <a href="${REPO}">Source on GitHub</a></span>
    <span class="legal">${legalFoot}</span>
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
