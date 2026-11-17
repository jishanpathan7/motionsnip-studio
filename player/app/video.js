// Playback: the video (or the live renderer), the music beside it, Web Audio gains, takes and compare.
//
// A plain video's trim and cuts plug in through `hooks` (vedit.js): playback skips the cut parts, and the
// music follows the edited clock, the way the export will sound.
//
// The video element is the clock. Music plays in its own <audio> element and is kept within 60 ms of
// `videoTime - musicOffset`. Gains are applied through Web Audio once the reviewer has interacted with the
// page (browsers only allow audio after a gesture); until then element volumes are used.

import { store, bus, effectiveAudio, sceneAt } from './state.js';
import { api, clamp, projectUrl, toast } from './util.js';

const DRIFT = 0.06;

export const player = {
  video: null,
  music: null,
  cmp: null,
  live: null,
  liveHost: null,
  rate: 1,
  loopScene: false,
  muted: false,
  takes: [],
  prevTake: null,
  videoOk: false,
  musicOk: false,
  musicDuration: 0,
  _virtual: { t: 0, playing: false, last: 0 },
  _ctx: null,
  _gVideo: null,
  _gMusic: null,
  _gMaster: null,
  _lastReseek: 0,
  _lastT: -1,
  _lastLiveT: -1,
  _musicSrc: null,
  _playing: false,
};

/** Set by vedit.js for a plain video with trim/cuts. Defaults: nothing is cut. */
export const hooks = {
  /** Source time -> time in the edited video. */
  outT: (t) => t,
  /** Length of the edited video, or null to use duration(). */
  outDur: () => null,
  /** While playing: skip cuts, stop at the end. Returns true when it stopped playback. */
  frame: () => false,
  /** Before play starts: move into the kept part. */
  beforePlay: () => {},
};

export function duration() {
  const d = store.reel?.duration || 0;
  if (d > 0) return d;
  const vd = player.video?.duration;
  return Number.isFinite(vd) ? vd : 0;
}

export const fps = () => store.reel?.fps || 30;
export const frameOf = (t) => Math.floor(t * fps() + 1e-6);
export const frameCount = () => Math.max(1, Math.round(duration() * fps()));

export function currentTime() {
  if (player.videoOk) return player.video.currentTime || 0;
  const v = player._virtual;
  if (v.playing) {
    const now = performance.now();
    v.t += ((now - v.last) / 1000) * player.rate;
    v.last = now;
  }
  return v.t;
}

export function isPlaying() {
  return player._playing;
}

// ---------------------------------------------------------------- setup

export function initPlayback({ video, music, cmp, liveHost, frameMsg }) {
  player.video = video;
  player.music = music;
  player.cmp = cmp;
  player.liveHost = liveHost;
  player.frameMsg = frameMsg;

  video.addEventListener('loadedmetadata', () => {
    player.videoOk = true;
    frameMsg.hidden = true;
    // a plain video's real picture size (the browser applies rotation), so the frame has its shape
    if (store.reel?.plain && !store.reel.derived && video.videoWidth && video.videoHeight) {
      store.reel.w = video.videoWidth;
      store.reel.h = video.videoHeight;
    }
    bus.emit('duration', {});
  });
  // rAF stops in background tabs; timeupdate (about 4 a second) still skips cuts there
  video.addEventListener('timeupdate', () => {
    if (player._playing && hooks.frame()) bus.emit('time', { t: currentTime() });
  });
  video.addEventListener('error', () => {
    player.videoOk = false;
    if (!player.live) {
      frameMsg.hidden = false;
      frameMsg.textContent = store.reel?.plain
        ? `Can't play ${store.reel.src}. The browser may not support this video's format; an mp4 (H.264) always works.`
        : store.reel?.src
          ? `Can't play ${store.reel.src}. Check that the file exists and "src" in reel.json points at it.`
          : 'reel.json has no "src" video yet.';
    }
  });
  video.addEventListener('ended', () => {
    if (player.loopScene) return;
    setPlaying(false);
  });
  video.addEventListener('pause', () => {
    if (player._playing && !video.ended && !player._seekingResume) {
      // paused by the browser (e.g. media keys)
      setPlaying(false);
    }
  });
  video.addEventListener('play', () => {
    if (!player._playing) setPlaying(true);
  });

  music.addEventListener('loadedmetadata', () => {
    player.musicOk = true;
    player.musicDuration = music.duration || 0;
    bus.emit('music', {});
  });
  music.addEventListener('error', () => {
    if (!player._musicSrc) return;
    player.musicOk = false;
    player.musicDuration = 0;
    bus.emit('music', { error: true });
  });

  // Audio can only start after a gesture. Hook the first one.
  const unlock = () => {
    ensureAudio();
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  bus.on('changes', (d) => {
    if (d.audio || d.undone || d.upload) syncMusicSrc();
    if (d.box && player.live) pushLiveBoxes();
    if (player.live && typeof player.live.setProps === 'function') pushLiveProps();
  });

  requestAnimationFrame(tick);
}

export function loadReel({ keepTime = false, startAt = null } = {}) {
  const reel = store.reel;
  const t = Number.isFinite(startAt) ? startAt : keepTime ? currentTime() : 0;
  const wasPlaying = keepTime && player._playing;
  if (wasPlaying) pause();
  player.videoOk = false;
  const v = player.video;
  if (reel.src) {
    v.src = projectUrl(reel.src) + `?v=${reel.version}`;
    v.load();
    const onMeta = () => {
      v.removeEventListener('loadedmetadata', onMeta);
      seek(t);
      if (wasPlaying) play();
    };
    v.addEventListener('loadedmetadata', onMeta);
  } else {
    v.removeAttribute('src');
    v.load();
    // a scene draws itself; it has a video only once it's been exported
    player.frameMsg.hidden = !!reel.scene;
    player.frameMsg.textContent = 'reel.json has no "src" video yet.';
  }
  player._virtual.t = t;
  player._musicSrc = undefined;
  syncMusicSrc(true);
  if (reel.live) loadLive(reel.live, reel.version);
  else if (player.live || document.body.classList.contains('has-live')) {
    // a cutdown is a plain video file: leave the master's live scene
    player.live = null;
    player.liveHost.innerHTML = '';
    document.body.classList.remove('has-live');
  }
  loadTakes();
}

function syncMusicSrc(force = false) {
  const a = effectiveAudio();
  const src = a.music || null;
  if (!force && src === player._musicSrc) return;
  player._musicSrc = src;
  const m = player.music;
  player.musicOk = false;
  player.musicDuration = 0;
  if (src) {
    m.src = projectUrl(src) + `?v=${store.reel.version}`;
    m.load();
  } else {
    m.pause();
    m.removeAttribute('src');
    m.load();
  }
  bus.emit('music', {});
}

// ---------------------------------------------------------------- Web Audio

export function ensureAudio() {
  if (player._ctx) {
    if (player._ctx.state === 'suspended') player._ctx.resume().catch(() => {});
    return player._ctx;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    const ctx = new AC();
    const master = ctx.createGain();
    master.connect(ctx.destination);
    const gv = ctx.createGain();
    const gm = ctx.createGain();
    ctx.createMediaElementSource(player.video).connect(gv);
    ctx.createMediaElementSource(player.music).connect(gm);
    gv.connect(master);
    gm.connect(master);
    player._ctx = ctx;
    player._gVideo = gv;
    player._gMusic = gm;
    player._gMaster = master;
    applyGains(true);
    return ctx;
  } catch (e) {
    console.warn('[motionsnip] Web Audio unavailable, using element volume:', e.message);
    player._ctx = null;
    return null;
  }
}

function fadeFactor(t, a) {
  const d = hooks.outDur() ?? duration();
  if (!(a.musicFade > 0) || !d) return 1;
  return clamp((d - hooks.outT(t)) / a.musicFade, 0, 1);
}

function applyGains(immediate = false) {
  const a = effectiveAudio();
  const t = currentTime();
  const vVol = clamp(a.sfxVol, 0, 1);
  const mVol = clamp(a.musicVol, 0, 1) * fadeFactor(t, a);
  const master = player.muted ? 0 : 1;
  if (player._ctx) {
    const now = player._ctx.currentTime;
    const set = (g, v) => {
      if (immediate) g.gain.value = v;
      else g.gain.setTargetAtTime(v, now, 0.03);
    };
    set(player._gVideo, vVol);
    set(player._gMusic, mVol);
    set(player._gMaster, master);
    player.video.volume = 1;
    player.music.volume = 1;
  } else {
    player.video.volume = vVol * master;
    player.music.volume = mVol * master;
  }
}

// ---------------------------------------------------------------- transport

function setPlaying(on) {
  if (player._playing === on) return;
  player._playing = on;
  store.ui.playing = on;
  bus.emit('play', { playing: on });
}

export function play() {
  ensureAudio();
  const d = duration();
  if (d && currentTime() >= d - 1 / fps()) seek(0);
  hooks.beforePlay();
  setPlaying(true);
  if (player.videoOk) {
    player.video.playbackRate = player.rate;
    const p = player.video.play();
    if (p && p.catch) p.catch((e) => {
      if (e.name !== 'AbortError') {
        setPlaying(false);
        toast("The browser didn't let the video play. Click play again.");
      }
    });
  } else {
    player._virtual.playing = true;
    player._virtual.last = performance.now();
  }
  if (player.live) safeLive('play');
}

export function pause() {
  setPlaying(false);
  player.video.pause();
  player.music.pause();
  player._virtual.playing = false;
  if (player.live) safeLive('pause');
}

export function toggle() {
  if (player._playing) pause();
  else play();
}

/** Seek to a time; snaps to the middle of its frame so the shown frame is exact. */
export function seek(t, { exact = false } = {}) {
  const d = duration();
  const f = fps();
  t = clamp(t, 0, Math.max(0, d - 0.5 / f));
  const target = exact ? t : (Math.floor(t * f + 1e-6) + 0.5) / f;
  const tt = clamp(target, 0, Math.max(0, d - 0.25 / f));
  if (player.videoOk) player.video.currentTime = tt;
  player._virtual.t = tt;
  player._virtual.last = performance.now();
  syncMusic(true);
  if (player.live) safeLive('seek', tt);
  if (store.ui.compare) syncCompare();
  if (player.loopScene) player.loopSceneId = sceneAt(tt)?.id || null;
  store.ui.t = tt;
  bus.emit('time', { t: tt, seek: true });
}

export function stepFrames(n) {
  if (player._playing) pause();
  const f = frameOf(currentTime()) + n;
  seek(clamp(f, 0, frameCount() - 1) / fps());
}

export function stepSeconds(s) {
  seek(currentTime() + s);
}

export function setRate(r) {
  player.rate = clamp(Math.round(r * 100) / 100, 0.25, 2);
  player.video.playbackRate = player.rate;
  player.music.playbackRate = player.rate;
  if (player.live) safeLive('setRate', player.rate);
  bus.emit('rate', { rate: player.rate });
}

export function setLoop(on) {
  player.loopScene = on;
  player.loopSceneId = sceneAt(currentTime())?.id || null;
  bus.emit('loop', { on });
}

export function setMuted(on) {
  player.muted = on;
  applyGains(true);
  bus.emit('mute', { on });
}

export function prevScene() {
  const t = currentTime();
  const sc = store.reel.scenes;
  const cur = sceneAt(t);
  const i = sc.indexOf(cur);
  // within the first half second of a scene, go to the one before
  const target = t - cur.t[0] > 0.5 || i <= 0 ? cur : sc[i - 1];
  seek(target.t[0]);
}

export function nextScene() {
  const sc = store.reel.scenes;
  const i = sc.indexOf(sceneAt(currentTime()));
  if (i >= 0 && i < sc.length - 1) seek(sc[i + 1].t[0]);
}

// ---------------------------------------------------------------- the loop

function syncMusic(hard = false) {
  const m = player.music;
  if (!player._musicSrc || !player.musicOk) {
    if (!m.paused) m.pause();
    return;
  }
  const a = effectiveAudio();
  const t = currentTime();
  const mt = hooks.outT(t) - (a.musicOffset || 0);
  const inRange = mt >= 0 && mt < (player.musicDuration || Infinity) - 0.02;
  if (player._playing && inRange) {
    if (m.paused) {
      m.currentTime = mt;
      m.playbackRate = player.rate;
      const p = m.play();
      if (p && p.catch) p.catch(() => {});
      player._lastReseek = performance.now();
    } else if (Math.abs(m.currentTime - mt) > DRIFT && performance.now() - player._lastReseek > 300) {
      m.currentTime = mt;
      player._lastReseek = performance.now();
    }
  } else {
    if (!m.paused) m.pause();
    if (hard && inRange) m.currentTime = mt;
  }
}

function tick() {
  requestAnimationFrame(tick);
  if (!store.reel) return;
  let t = currentTime();
  const d = duration();
  if (player._playing) {
    if (player.loopScene) {
      const sc = store.reel.scenes.find((x) => x.id === player.loopSceneId) || sceneAt(t);
      if (sc && t >= sc.t[1] - 0.5 / fps()) {
        seek(sc.t[0]);
        if (player.videoOk && player.video.paused) player.video.play().catch(() => {});
        t = currentTime();
      }
    } else if (hooks.frame()) {
      t = currentTime();
    } else if (d && t >= d) {
      pause();
      t = d;
    }
    syncMusic();
    applyGains();
    if (player.live && Math.abs(t - player._lastLiveT) > 1e-4) {
      safeLive('seek', t);
      player._lastLiveT = t;
    }
  }
  if (t !== player._lastT) {
    player._lastT = t;
    store.ui.t = t;
    bus.emit('time', { t });
  }
}

// ---------------------------------------------------------------- takes and compare

export async function loadTakes() {
  try {
    const list = await api('/api/takes');
    player.takes = Array.isArray(list) ? list.filter((x) => x && Number.isFinite(+x.version) && (x.url || x.src)) : [];
  } catch {
    player.takes = [];
  }
  const cur = store.master.version; // takes are versions of the master
  const older = player.takes.filter((x) => +x.version < cur).sort((a, b) => b.version - a.version);
  player.prevTake = older[0] || null;
  if (player.cmp) {
    player.cmp.removeAttribute('src');
    player.cmp.dataset.loaded = '';
  }
  bus.emit('takes', { prev: player.prevTake });
}

export function setCompare(on) {
  if (on && store.reel.derived) {
    toast('Compare works on the master: switch to it to see the previous version.');
    on = false;
  }
  if (on && !player.prevTake) {
    if (on) toast('No earlier version to compare with yet.');
    on = false;
  }
  if (store.ui.compare === on) return;
  store.ui.compare = on;
  const c = player.cmp;
  if (on) {
    if (c.dataset.loaded !== String(player.prevTake.version)) {
      c.src = player.prevTake.url || projectUrl(player.prevTake.src);
      c.dataset.loaded = String(player.prevTake.version);
      c.addEventListener('loadedmetadata', syncCompare, { once: true });
    }
    syncCompare();
  }
  bus.emit('compare', { on });
}

function syncCompare() {
  const c = player.cmp;
  if (!c || !c.src) return;
  try {
    if (c.readyState >= 1) c.currentTime = Math.min(currentTime(), (c.duration || Infinity) - 0.01);
  } catch {
    /* not ready yet */
  }
}

// ---------------------------------------------------------------- live renderer

function loadLive(live, version) {
  const host = player.liveHost;
  host.innerHTML = '';
  player.live = null;
  const token = (player._liveToken = (player._liveToken || 0) + 1);
  const started = (api) => {
    if (token !== player._liveToken) return;
    if (!api || typeof api.seek !== 'function') throw new Error('MotionSnipLive() must return { seek, play, pause, setRate, setBoxes }');
    player.live = api;
    document.body.classList.add('has-live');
    player.frameMsg.hidden = true;
    safeLive('setRate', player.rate);
    safeLive('seek', currentTime());
    pushLiveBoxes();
    pushLiveProps();
    if (player._playing) safeLive('play');
    bus.emit('live', { on: true });
  };
  const failed = (msg) => {
    if (token !== player._liveToken) return;
    console.warn('[motionsnip] live renderer failed:', msg);
    toast(`Live renderer didn't start: ${msg}. Showing the video.`);
    document.body.classList.remove('has-live');
  };

  // a scene project: scene.json drawn by MotionSnip's own scene runtime (no project code runs)
  if (live && typeof live === 'object' && live.type === 'scene') {
    const specUrl = projectUrl(live.spec || 'scene.json') + `?v=${version}`;
    Promise.all([
      fetch(specUrl).then((r) => {
        if (!r.ok) throw new Error(`${live.spec || 'scene.json'} returned ${r.status}`);
        return r.json();
      }),
      import('./scene/runtime.js'),
    ])
      .then(([raw, mod]) => {
        if (token !== player._liveToken) return;
        started(mod.createScene(host, raw, { asset: (p) => projectUrl(p) }));
      })
      .catch((e) => failed(e.message));
    return;
  }

  const file = live;
  const s = document.createElement('script');
  s.src = projectUrl(file) + `?v=${version}`;
  s.onload = () => {
    try {
      if (typeof window.MotionSnipLive !== 'function') throw new Error('window.MotionSnipLive is not a function');
      started(window.MotionSnipLive(host));
    } catch (e) {
      failed(e.message);
    }
  };
  s.onerror = () => {
    toast(`Couldn't load the live renderer ${file}. Showing the video.`);
  };
  document.head.append(s);
}

function safeLive(fn, arg) {
  const l = player.live;
  if (!l || typeof l[fn] !== 'function') return;
  try {
    l[fn](arg);
  } catch (e) {
    console.warn('[motionsnip] live.' + fn + ' failed:', e.message);
  }
}

/**
 * Script and Look edits, shown at once: setProps({ elId: { prop: value } }, patches). A scene also gets the
 * same edits as scene.json patches ([{ path, value }]), from each prop's `path`, plus palette changes.
 */
export function pushLiveProps() {
  const l = player.live;
  if (!l || typeof l.setProps !== 'function' || !store.reel) return;
  const els = new Map((store.reel.scenes || []).flatMap((s) => s.els.map((e) => [e.id, e])));
  const edits = {};
  const patches = [];
  for (const c of store.data.changes) {
    if (c.kind === 'prop') {
      (edits[c.elId] ||= {})[c.propKey] = c.after;
      const path = els.get(c.elId)?.props?.[c.propKey]?.path;
      if (path) patches.push({ path, value: c.after });
    } else if (c.kind === 'brand' && store.reel.scene) patches.push({ path: `style.palette.${c.colorId}`, value: c.after });
  }
  try {
    l.setProps(edits, patches);
  } catch (e) {
    console.warn('[motionsnip] live.setProps failed:', e.message);
  }
}

export function pushLiveBoxes(extra) {
  if (!player.live) return;
  const boxes = {};
  for (const c of store.data.changes) {
    if (c.kind !== 'box') continue;
    boxes[c.elId] = [...c.before, ...c.after];
  }
  if (extra) boxes[extra.id] = [...extra.before, ...extra.after];
  safeLive('setBoxes', boxes);
}
