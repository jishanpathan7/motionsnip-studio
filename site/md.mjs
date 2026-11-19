// A small Markdown renderer for the docs pages: the subset README.md, SKILL.md and docs/SPEC.md use (headings,
// paragraphs, nested lists, fenced code, tables, quotes, rules, raw HTML blocks, inline code, bold, italics, links,
// images). No dependencies. render(md, { link(href) → href }) → { html, title, toc: [{ id, text }] }.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function slug(text) {
  return (
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z]+;/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  );
}

/** Inline Markdown → HTML. Code spans first, so nothing inside them is touched. */
function inline(text, opts) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${esc(opts.link(src.replace(/&amp;/g, '&')))}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const h = opts.link(href.replace(/&amp;/g, '&'));
    const ext = /^https?:/.test(h) && !h.startsWith('https://motionsnip.com');
    return `<a href="${esc(h)}"${ext ? ' rel="noopener"' : ''}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

const isFence = (l) => /^\s*```/.test(l);
const listMark = (l) => /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);
const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
// table cells; a pipe inside a code span or escaped as \| stays in its cell
const cells = (l) => {
  const out = [''];
  let code = false;
  const s = l.trim().replace(/^\||\|$/g, '');
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') {
      out[out.length - 1] += '|';
      k++;
    } else if (ch === '`') {
      code = !code;
      out[out.length - 1] += ch;
    } else if (ch === '|' && !code) out.push('');
    else out[out.length - 1] += ch;
  }
  return out.map((c) => c.trim());
};
const ordered = (m) => /\d/.test(m[2]);

export function render(md, opts = {}) {
  const o = { link: (h) => h, ...opts };
  const lines = md.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let title = '';
  let i = 0;

  const heading = (level, text) => {
    const htmlText = inline(text, o);
    let id = slug(htmlText);
    for (let n = 2; ids.has(id); n++) id = `${slug(htmlText)}-${n}`;
    ids.add(id);
    if (level === 1 && !title) title = text.replace(/[`*_]/g, '');
    if (level === 2) toc.push({ id, text: htmlText.replace(/<(?!\/?code)[^>]+>/g, '') });
    out.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${htmlText}</h${level}>`);
  };

  // a list starting at line i with the given indent; returns html
  const list = (indent) => {
    const isOl = ordered(listMark(lines[i]));
    const items = [];
    while (i < lines.length) {
      const m = listMark(lines[i]);
      if (!m || m[1].length !== indent || ordered(m) !== isOl) break;
      let body = [m[3]];
      let sub = '';
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        const n = listMark(lines[i]);
        if (n && n[1].length > indent) {
          sub += list(n[1].length);
          continue;
        }
        if (n || !/^\s+/.test(lines[i])) break;
        body.push(lines[i].trim());
        i++;
      }
      items.push(`<li>${inline(body.join(' '), o)}${sub}</li>`);
      // a blank line between items of the same list keeps the list going
      const next = listMark(lines[i + 1] || '');
      if (i < lines.length && lines[i].trim() === '' && next?.[1].length === indent && ordered(next) === isOl) i++;
    }
    return isOl ?`<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (isFence(line)) {
      const lang = line.trim().slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) body.push(lines[i++]);
      i++;
      const code = body.join('\n');
      const shell = /^(bash|sh|shell|zsh)$/.test(lang);
      out.push(`<div class="code${shell ? ' is-shell' : ''}"><div class="code-bar"><span>${esc(lang || 'text')}</span><button class="copy" type="button">Copy</button></div><pre><code>${esc(code)}</code></pre></div>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      heading(h[1].length, h[2].trim());
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^<[a-zA-Z!/]/.test(line)) {
      const block = [];
      while (i < lines.length && lines[i].trim() !== '') block.push(lines[i++]);
      out.push(o.html ? o.html(block.join('\n')) : block.join('\n'));
      continue;
    }
    if (/^>/.test(line)) {
      const body = [];
      while (i < lines.length && /^>/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${render(body.join('\n'), o).html}</blockquote>`);
      continue;
    }
    if (isTableRow(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c, o)}</${tag}>`;
      out.push(`<div class="table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, k) => td('td', c, k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (listMark(line)) {
      out.push(list(listMark(line)[1].length));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !isFence(lines[i]) && !/^(#{1,4})\s/.test(lines[i]) && !(para.length && listMark(lines[i])) && !/^>/.test(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '), o)}</p>`);
  }
  return { html: out.join('\n'), title, toc };
}
