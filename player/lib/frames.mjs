// Frame exports: the player draws every frame (scenes, graphics, captions) and streams PNGs to the server;
// ffmpeg reads them from stdin (image2pipe) and encodes the format the user picked. Pure argument builders,
// so the selftest can check them without running ffmpeg.

/** Output formats. `enc` lists encoders in order of preference; the first one this ffmpeg has wins. */
export const FORMATS = {
  mp4: { label: 'MP4 (H.264)', ext: 'mp4', enc: ['libx264', 'h264_videotoolbox', 'mpeg4'], audio: 'aac' },
  hevc: { label: 'MP4 (HEVC)', ext: 'mp4', enc: ['libx265', 'hevc_videotoolbox'], audio: 'aac' },
  prores: { label: 'ProRes 422 (MOV)', ext: 'mov', enc: ['prores_ks', 'prores_videotoolbox', 'prores'], audio: 'pcm' },
  webm: { label: 'WebM (VP9)', ext: 'webm', enc: ['libvpx-vp9'], audio: 'opus' },
  gif: { label: 'GIF', ext: 'gif', enc: ['gif'], audio: null },
};

export const FPS = [24, 25, 30, 60];

/** Encoders this ffmpeg has, from `ffmpeg -encoders`. */
export function encoderSet(encodersText) {
  return new Set([...String(encodersText).matchAll(/^ [A-Z.]{6} (\S+) /gm)].map((m) => m[1]));
}

/** The encoder to use for a format, or null when this ffmpeg can't make it. */
export function pickEncoder(format, have) {
  const f = FORMATS[format];
  return f ? f.enc.find((e) => have.has(e)) || null : null;
}

/** Which formats this ffmpeg can make: { mp4: 'libx264', gif: 'gif', … } (missing ones left out). */
export function availableFormats(have) {
  const out = {};
  for (const id of Object.keys(FORMATS)) {
    const e = pickEncoder(id, have);
    if (e) out[id] = e;
  }
  return out;
}

const n3 = (v) => String(Math.round(Number(v) * 1000) / 1000);

function videoCodecArgs(format, encoder) {
  switch (encoder) {
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-b:v', '12M', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    case 'mpeg4':
      return ['-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p'];
    case 'libx265':
      return ['-c:v', 'libx265', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-movflags', '+faststart'];
    case 'hevc_videotoolbox':
      return ['-c:v', 'hevc_videotoolbox', '-b:v', '10M', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-movflags', '+faststart'];
    case 'prores_ks':
      return ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le'];
    case 'prores_videotoolbox':
    case 'prores':
      return ['-c:v', encoder, '-profile:v', '2', '-pix_fmt', 'yuv422p10le'];
    case 'libvpx-vp9':
      return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-pix_fmt', 'yuv420p'];
    default:
      throw new Error(`No encoder for ${format}`);
  }
}

function audioCodecArgs(kind) {
  if (kind === 'aac') return ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
  if (kind === 'opus') return ['-c:a', 'libopus', '-b:a', '160k', '-ar', '48000', '-ac', '2'];
  if (kind === 'pcm') return ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'];
  return ['-an'];
}

/**
 * Audio clips → one filter chain per clip and an amix. clips: [{ file, at, in?, out?, gain?, fadeIn?, fadeOut? }]
 * (seconds on the output's clock; in/out are seconds in the file). first: the ffmpeg input index of clips[0].
 * Returns { parts: [filter strings], out: '[aout]' } or null when there is no audio.
 */
export function audioMix(clips, first, D) {
  const ok = (clips || []).filter((c) => c && c.file && Number(c.at) < D);
  if (!ok.length) return null;
  const parts = [];
  const labels = [];
  ok.forEach((c, i) => {
    const at = Math.max(0, Number(c.at) || 0);
    const a = Math.max(0, Number(c.in) || 0);
    const len = Math.max(0.01, Math.min(D - at, Number.isFinite(Number(c.out)) && Number(c.out) > a ? Number(c.out) - a : D - at));
    const f = [`atrim=start=${n3(a)}:duration=${n3(len)}`, 'asetpts=PTS-STARTPTS', 'aformat=sample_rates=48000:channel_layouts=stereo'];
    const g = Number.isFinite(Number(c.gain)) ? Math.max(0, Number(c.gain)) : 1;
    if (g !== 1) f.push(`volume=${n3(g)}`);
    if (Number(c.fadeIn) > 0) f.push(`afade=t=in:st=0:d=${n3(Math.min(Number(c.fadeIn), len))}`);
    if (Number(c.fadeOut) > 0) f.push(`afade=t=out:st=${n3(Math.max(0, len - Number(c.fadeOut)))}:d=${n3(Math.min(Number(c.fadeOut), len))}`);
    if (at > 0) f.push(`adelay=${Math.round(at * 1000)}:all=1`);
    const l = `[a${i}]`;
    parts.push(`[${first + i}:a]${f.join(',')}${l}`);
    labels.push(l);
  });
  parts.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad,atrim=duration=${n3(D)}[aout]`);
  return { parts, out: '[aout]' };
}

/**
 * ffmpeg args for a frame export. Frames arrive on stdin as PNGs, `frames` of them at `fps`.
 * opts: { fps, w, h, frames, out, format, encoder, audio: [clips], gifFps? }
 */
export function buildFramesArgs(opts) {
  const { fps, w, h, frames, out, format, encoder } = opts;
  if (!(fps > 0) || !(w > 0) || !(h > 0) || !(frames > 0)) throw new Error('fps, size and frame count are required');
  const D = frames / fps;
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0'];
  if (format === 'gif') {
    const gf = Math.min(fps, opts.gifFps || 15);
    const gw = Math.min(w, opts.gifWidth || 960);
    args.push('-filter_complex', `[0:v]fps=${gf},scale=${gw}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4[v]`, '-map', '[v]', '-loop', '0', '-t', n3(D), out);
    return args;
  }
  const clips = (opts.audio || []).filter((c) => c && c.file);
  for (const c of clips) args.push('-i', c.file);
  const mix = FORMATS[format]?.audio ? audioMix(clips, 1, D) : null;
  const parts = [`[0:v]format=rgba,scale=${w}:${h},setsar=1[v]`];
  if (mix) parts.push(...mix.parts);
  args.push('-filter_complex', parts.join(';'), '-map', '[v]');
  if (mix) args.push('-map', mix.out);
  args.push(...videoCodecArgs(format, encoder), '-r', String(fps));
  args.push(...(mix ? audioCodecArgs(FORMATS[format].audio) : ['-an']), '-t', n3(D), out);
  return args;
}

/** Count complete PNG images in a buffer of concatenated PNGs (each ends with an IEND chunk). */
export function countPngs(buf) {
  let n = 0;
  let i = 0;
  const iend = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  while ((i = buf.indexOf(iend, i)) !== -1) {
    n++;
    i += iend.length;
  }
  return n;
}
