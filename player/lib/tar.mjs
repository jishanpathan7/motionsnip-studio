// A minimal tar (ustar) reader and writer, enough for add-on packages: regular files and folders only.
// Reading refuses anything that could land outside the folder it is unpacked into: absolute paths, '..',
// backslashes, and links of any kind.

const BLOCK = 512;

const str = (b, at, len) => {
  const s = b.subarray(at, at + len);
  const end = s.indexOf(0);
  return s.subarray(0, end < 0 ? len : end).toString('utf8');
};
const octal = (b, at, len) => {
  const s = str(b, at, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new Error('Bad number in the package');
  return s ? parseInt(s, 8) : 0;
};

/** Is p a safe relative path ('a/b.js'), with no '.', '..', empty or hidden-from-Windows parts? */
export function safeEntryPath(p) {
  if (typeof p !== 'string' || !p || p.length > 255 || p.includes('\\') || p.includes('\0')) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p
    .replace(/\/$/, '')
    .split('/')
    .every((part) => part && part !== '.' && part !== '..');
}

/** A tar Buffer → [{ path, dir, data }] (data: a Buffer for a file). Throws on anything it won't unpack. */
export function readTar(buf) {
  const out = [];
  let at = 0;
  while (at + BLOCK <= buf.length) {
    const head = buf.subarray(at, at + BLOCK);
    if (head.every((x) => x === 0)) break; // the end
    // the checksum: the header's bytes with the checksum field read as spaces
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : head[i];
    if (sum !== octal(head, 148, 8)) throw new Error('The package is damaged (bad checksum)');
    const type = String.fromCharCode(head[156] || 48);
    const size = octal(head, 124, 12);
    const prefix = str(head, 257, 6).startsWith('ustar') ? str(head, 345, 155) : '';
    const name = (prefix ? `${prefix}/` : '') + str(head, 0, 100);
    at += BLOCK;
    if (type !== '0' && type !== '5') throw new Error(`The package has an entry tar type "${type}" (only files and folders are allowed): ${name}`);
    if (!safeEntryPath(name)) throw new Error(`The package has an unsafe path: ${name}`);
    if (at + size > buf.length) throw new Error('The package is cut short');
    const path = name.replace(/\/$/, '');
    if (type === '5') out.push({ path, dir: true, data: null });
    else out.push({ path, dir: false, data: Buffer.from(buf.subarray(at, at + size)) });
    at += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

function header(name, size, type) {
  const b = Buffer.alloc(BLOCK);
  let pre = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`Path too long for tar: ${name}`);
    pre = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  b.write(base, 0, 100, 'utf8');
  b.write((type === '5' ? '0000755' : '0000644') + '\0', 100);
  b.write('0000000\0', 108);
  b.write('0000000\0', 116);
  b.write(size.toString(8).padStart(11, '0') + '\0', 124);
  b.write('00000000000\0', 136); // mtime 0: the same files give the same bytes
  b.fill(32, 148, 156);
  b.write(type, 156);
  b.write('ustar\0' + '00', 257);
  b.write(pre, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}

/** [{ path, data }] (a folder: data null, or a path ending in '/') → a tar Buffer. */
export function writeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const dir = e.data == null || e.path.endsWith('/');
    const p = e.path.replace(/\/$/, '');
    if (!safeEntryPath(p)) throw new Error(`Unsafe path: ${e.path}`);
    if (dir) {
      parts.push(header(p + '/', 0, '5'));
      continue;
    }
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    parts.push(header(p, data.length, '0'), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
