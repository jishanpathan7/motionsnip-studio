// The keyframe world: the landing page's opening scene.
//
// A camera glides over an endless editing timeline. Lanes run to the horizon,
// keyframes float above them and bloom as they come close, empty frames drift
// overhead with their cue dots blinking, and a playhead line passes under you
// every few seconds. Scrolling scrubs through one review round (circle the
// logo, fix the headline, send to Claude); when v2 lands every keyframe snaps
// onto the grid. The cursor pushes keyframes aside and lights the nearest ones.
//
// Plain WebGL2, no dependencies. Without JavaScript, WebGL or with reduced
// motion, the page shows the same story as static text (see world.css).

const world = document.getElementById('world');
if (world) start();

function start() {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = matchMedia('(max-width: 820px)').matches;
  const fine = matchMedia('(pointer: fine)').matches;

  const $ = (s) => world.querySelector(s);
  const clip = $('.clip');
  const headText = $('.clip-head-text');
  const status = $('.clip-status');
  const count = $('.clip-count');
  const tc = $('#tc');
  const cta = $('.btn.tape');
  const markers = [...world.querySelectorAll('.scrub button')];

  // ---------- scroll story ----------
  const S = { p: reduce ? 1 : 0 };
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const OLD = 'Meet Acme', NEW = 'Say hi to Acme';
  const STARTS = [0, 0.24, 0.48, 0.72];

  if (!reduce) world.classList.add('live');

  function progress() {
    if (reduce) return 1;
    const r = world.getBoundingClientRect();
    const run = r.height - innerHeight;
    return run > 0 ? clamp01(-r.top / run) : 0;
  }

  let lastStory = '';
  function story(p) {
    const t1 = clamp01((p - 0.24) / 0.2), t2 = clamp01((p - 0.48) / 0.2), t3 = clamp01((p - 0.72) / 0.2);
    const v2 = t3 > 0.5;
    const st = world.style;
    st.setProperty('--p', p.toFixed(4));
    st.setProperty('--intro', (1 - smooth(0.1, 0.19, p)).toFixed(3));
    st.setProperty('--clip-in', smooth(0.15, 0.25, p).toFixed(3));
    STARTS.slice(1).forEach((s, i) => {
      const a = smooth(s - 0.07, s - 0.01, p) * (i < 2 ? 1 - smooth(s + 0.19, s + 0.235, p) : 1);
      st.setProperty(`--c${i + 1}`, a.toFixed(3));
    });
    st.setProperty('--ring', (1 - smooth(0.05, 0.5, t1)).toFixed(3));

    // the frame card, as discrete states (only touch the DOM when one changes)
    let text = OLD;
    if (t2 > 0.15) {
      const q = clamp01((t2 - 0.15) / 0.62);
      text = q < 0.3 ? OLD.slice(0, Math.round(OLD.length * (1 - q / 0.3))) : NEW.slice(0, Math.round(NEW.length * ((q - 0.3) / 0.7)));
    }
    if (v2) text = NEW;
    const n = (t1 > 0.6 ? 1 : 0) + (t2 > 0.86 ? 1 : 0);
    const flags = {
      note: t1 > 0.58 && !v2,
      sel: t2 > 0.04 && t2 < 0.98 && !v2,
      edited: t2 > 0.86 && !v2,
      press: t3 > 0.06 && t3 < 0.2,
      working: t3 > 0.12 && !v2,
      v2,
      flash: t3 > 0.5 && t3 < 0.64,
      tick1: t3 > 0.6,
      tick2: t3 > 0.7,
      has1: n >= 1 || v2,
      has2: n >= 2 || v2,
    };
    const key = text + n + Object.values(flags).join();
    if (key !== lastStory) {
      lastStory = key;
      headText.textContent = text || '​';
      for (const k in flags) clip.classList.toggle(`is-${k}`, flags[k]);
      count.textContent = v2 ? 'v2 · 2 of 2 applied' : flags.working ? 'Claude is applying 2 notes' : n ? `${n} ${n === 1 ? 'change' : 'changes'} ready` : 'Nothing changed yet';
      status.textContent = v2 ? 'v2' : 'v1';
      let at = 0;
      STARTS.forEach((s, i) => { if (p >= s - 0.03) at = i; });
      markers.forEach((m, i) => m.toggleAttribute('aria-current', i === at));
    }
    return {
      snap: smooth(0.45, 0.8, t3),
      hi: t2 > 0.04 && !v2 ? 1 : 0,
      zoom: Math.sin(Math.PI * clamp01(t1 * 1.1)) * (1 - t2),
    };
  }

  markers.forEach((m, i) => m.addEventListener('click', () => {
    if (reduce) return;
    const r = world.getBoundingClientRect();
    const run = r.height - innerHeight;
    scrollTo({ top: scrollY + r.top + run * (STARTS[i] + (i ? 0.08 : 0)), behavior: 'smooth' });
  }));

  // ---------- WebGL ----------
  const canvas = document.getElementById('world-gl');
  const gl = canvas && canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
  if (!gl) {
    world.classList.add('no-gl');
    const tick = () => { story(progress()); };
    addEventListener('scroll', tick, { passive: true });
    addEventListener('resize', tick);
    tick();
    return;
  }

  const L = 64;                       // depth of the visible world; everything wraps around it
  const laneY = (x) => -2.1 - 0.0045 * x * x;
  const LANES = [];
  for (let x = -17.6; x <= 17.61; x += 0.8) LANES.push(+x.toFixed(2));

  // seeded random, so the scene is the same on every visit
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;

  // instances: pos(3) snap(3) meta(4: kind, size, colour, phase)
  const inst = [];
  const push = (px, py, pz, sx, sy, sz, kind, size, col, ph) => inst.push(px, py, pz, sx, sy, sz, kind, size, col, ph);
  const perLane = small ? 52 : 110;
  for (const x of LANES) {
    const y = laneY(x) + 0.07;
    let z = rnd() * 3;
    for (let i = 0; i < perLane && z < L; i++) {
      z += rnd() < 0.7 ? 0.25 + rnd() * 0.5 : 1.5 + rnd() * 3;   // keyframes come in clusters
      const zs = Math.round(z / 0.75) * 0.75;
      const r = rnd();
      const col = r < 0.82 ? 0 : r < 0.94 ? 1 : 2;
      const size = (col ? 0.12 : 0.075 + rnd() * 0.04);
      push(x + gauss() * 0.22, y + Math.abs(gauss()) * 0.85 * rnd(), zs + gauss() * 0.35, x, y, zs % L, 0, size, col, rnd());
    }
  }
  const frames = small ? 34 : 70;
  for (let i = 0; i < frames; i++) {
    const x = (rnd() * 2 - 1) * 15, y = -0.6 + rnd() * 4.5, z = rnd() * L;
    push(x, y, z, x, y, z, 1, 0.32 + rnd() * 0.28, 3, rnd());
  }
  const dust = small ? 700 : 1500;
  for (let i = 0; i < dust; i++) {
    const x = (rnd() * 2 - 1) * 20, y = -2.4 + rnd() * 9, z = rnd() * L;
    push(x, y, z, x, y, z, 2, 0.018 + rnd() * 0.02, rnd() < 0.15 ? 2 : 0, rnd());
  }
  const N = inst.length / 10;

  // lines: x, y, z, mode (0 lane: z is 0..1 along it; 1 playhead: z is world z), r, g, b, a
  const lines = [];
  for (const x of LANES) {
    const y = laneY(x), a = Math.abs(x) < 1.7 ? 0.3 : 0.2;
    lines.push(x, y, 0, 0, 0.62, 0.56, 0.78, a, x, y, 1, 0, 0.62, 0.56, 0.78, a);
  }
  for (let g = 0; g < 4; g++) {
    const z = g * (L / 4) + 6;
    for (let x = -17.6; x < 17.6; x += 0.8) {
      const x2 = x + 0.8;
      lines.push(x, laneY(x) + 0.01, z, 1, 1, 0.31, 0.66, 0.85, x2, laneY(x2) + 0.01, z, 1, 1, 0.31, 0.66, 0.85);
    }
  }
  const NL = lines.length / 8;

  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = (vs, fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; };

  const COMMON = `#version 300 es
precision highp float;
uniform mat4 uProj, uView;
uniform float uTravel, uL, uTime, uSnap, uAspect, uHi, uMouseOn;
uniform vec2 uMouse;
float fall(float a, float b, float x){ return 1.0 - smoothstep(b, a, x); }  // 1 below b, 0 above a (smoothstep needs a < b)
float wrapZ(float z){ return mod(z + uTravel, uL) - uL + 1.5; }
float fade(float d){ return fall(uL, uL * 0.55, d) * smoothstep(0.3, 1.6, d); }
`;

  let pointsProg, linesProg;
  try {
    pointsProg = prog(COMMON + `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aPos;
layout(location=2) in vec3 aSnap;
layout(location=3) in vec4 aMeta;
out vec2 vUv; out vec3 vCol; out float vA, vGlow, vKind, vPhase, vSnap;
const vec3 COLS[4] = vec3[4](vec3(0.965,0.957,0.937), vec3(0.91,1.0,0.28), vec3(1.0,0.31,0.66), vec3(0.64,0.6,0.78));
void main(){
  float kind = aMeta.x, ph = aMeta.w;
  float delay = fract(ph * 7.31) * 0.35;
  float s = clamp((uSnap - delay) / 0.65, 0.0, 1.0); s = s * s * (3.0 - 2.0 * s);
  vec3 p = kind < 0.5 ? mix(aPos, aSnap, s) : aPos;
  if (kind > 1.5) { p.x += cos(uTime * 0.21 + ph * 13.0) * 0.35; p.y += sin(uTime * 0.27 + ph * 20.0) * 0.3; }
  else if (kind > 0.5) { p.y += sin(uTime * 0.45 + ph * 9.0) * 0.18; }
  else { p.y += sin(uTime * 0.8 + ph * 31.0) * 0.03 * (1.0 - s); }
  vec4 view = uView * vec4(p.x, p.y, wrapZ(p.z), 1.0);
  float dist = -view.z;
  if (dist < 0.25) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 clip = uProj * view;
  vec2 ndc = clip.xy / clip.w;
  // the cursor parts the field and lights what is nearest
  vec2 dm = (ndc - uMouse) * vec2(uAspect, 1.0);
  float l2 = dot(dm, dm);
  float near = fall(uL * 0.7, 4.0, dist);
  ndc += dm / (sqrt(l2) + 1e-4) * exp(-l2 / 0.045) * 0.085 * uMouseOn * near * vec2(1.0 / uAspect, 1.0);
  vGlow = exp(-l2 / 0.01) * uMouseOn * near;
  float bloom = kind < 0.5 ? mix(0.18, 1.0, fall(uL * 0.85, uL * 0.28, dist)) : 1.0;
  vec2 corner = kind > 0.5 && kind < 1.5 ? aCorner * vec2(1.5, 1.0) : aCorner;
  float pix = min(aMeta.y * bloom * uProj[1][1] / dist, kind > 0.5 && kind < 1.5 ? 0.09 : 0.016) * (1.0 + vGlow * 0.7);
  gl_Position = vec4((ndc + corner * pix * vec2(1.0 / uAspect, 1.0)) * clip.w, clip.z, clip.w);
  vUv = corner; vKind = kind; vPhase = ph; vSnap = s;
  vec3 col = COLS[int(aMeta.z)];
  if (kind < 0.5) col = mix(col, COLS[1], uHi * step(abs(aSnap.x), 1.7));
  vCol = col;
  vA = fade(dist) * (kind < 0.5 ? (0.7 + 0.5 * s) * smoothstep(1.5, 6.0, dist) : 1.0);
}`, `#version 300 es
precision highp float;
float fall(float a, float b, float x){ return 1.0 - smoothstep(b, a, x); }  // 1 below b, 0 above a (smoothstep needs a < b)
uniform float uTime;
in vec2 vUv; in vec3 vCol; in float vA, vGlow, vKind, vPhase, vSnap;
out vec4 o;
void main(){
  vec3 c = vCol; float a;
  if (vKind < 0.5) {                       // keyframe: a diamond with a soft halo
    float d = abs(vUv.x) + abs(vUv.y);
    float core = fall(0.6, 0.5, d);
    a = core * 0.95 + exp(-d * d * 4.5) * (0.28 + vGlow * 1.1 + vSnap * 0.2);
    c = mix(c, vec3(1.0), core * 0.2 + vGlow * 0.35);
  } else if (vKind < 1.5) {                // frame: the MotionSnip mark, 3:2 with its cue dot
    vec2 dd = abs(vUv) - vec2(1.36, 0.86) + 0.24;
    float sd = length(max(dd, 0.0)) + min(max(dd.x, dd.y), 0.0) - 0.24;
    float edge = fall(0.07, 0.0, abs(sd));
    float on = step(0.62, fract(uTime * 0.31 + vPhase * 5.0));
    float dc = length(vUv - vec2(0.88, 0.42));
    float dotA = fall(0.2, 0.15, dc) * (0.25 + 0.75 * on) + exp(-dc * dc * 18.0) * 0.5 * on;
    a = edge * 0.42 + fall(0.02, -0.02, sd) * 0.035;
    c = c * a + vec3(1.0, 0.31, 0.66) * dotA;
    a += dotA;
    o = vec4(c * vA, a * vA); return;
  } else {                                 // dust
    a = exp(-dot(vUv, vUv) * 5.0) * 0.55;
  }
  a *= vA;
  o = vec4(c * a, a);
}`);
    linesProg = prog(COMMON + `
layout(location=0) in vec4 aP;
layout(location=1) in vec4 aCol;
out vec4 vCol; out float vWz, vMode, vD;
void main(){
  float z = aP.w < 0.5 ? mix(1.5, -uL, aP.z) : wrapZ(aP.z);
  vec4 view = uView * vec4(aP.xy, z, 1.0);
  gl_Position = uProj * view;
  vD = -view.z; vWz = z - uTravel; vMode = aP.w; vCol = aCol;
}`, `#version 300 es
precision highp float;
float fall(float a, float b, float x){ return 1.0 - smoothstep(b, a, x); }  // 1 below b, 0 above a (smoothstep needs a < b)
uniform float uL, uSnap;
in vec4 vCol; in float vWz, vMode, vD;
out vec4 o;
void main(){
  float a = vCol.a * fall(uL, uL * 0.5, vD) * smoothstep(0.0, 2.0, vD);
  if (vMode < 0.5) a *= 0.55 + 0.9 * step(fract(vWz / 0.75), 0.08) + 0.35 * uSnap;   // beat ticks along each lane
  o = vec4(vCol.rgb * a, a);
}`);
  } catch (e) {
    console.warn('keyframe world: falling back to the still version', e);
    world.classList.add('no-gl');
    addEventListener('scroll', () => story(progress()), { passive: true });
    story(progress());
    return;
  }

  const buf = (data, target = gl.ARRAY_BUFFER) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };

  const vaoP = gl.createVertexArray();
  gl.bindVertexArray(vaoP);
  buf(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  buf(new Float32Array(inst));
  [[1, 3, 0], [2, 3, 12], [3, 4, 24]].forEach(([loc, n, off]) => {
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 40, off); gl.vertexAttribDivisor(loc, 1);
  });

  const vaoL = gl.createVertexArray();
  gl.bindVertexArray(vaoL);
  buf(new Float32Array(lines));
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
  gl.bindVertexArray(null);

  const U = (p) => new Proxy({}, { get: (c, k) => c[k] ?? (c[k] = gl.getUniformLocation(p, k)) });
  const UP = U(pointsProg), UL = U(linesProg);

  // ---------- camera and input ----------
  let dpr = Math.min(devicePixelRatio || 1, small ? 1.5 : 1.75);
  let W = 1, H = 1;
  function resize() {
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const mouse = { x: 0, y: 0, tx: 0, ty: 0, on: 0, ton: 0 };
  if (fine && !reduce) {
    world.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      mouse.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
      mouse.ty = 1 - ((e.clientY - r.top) / r.height) * 2;
      mouse.ton = 1;
    });
    world.addEventListener('pointerleave', () => { mouse.ton = 0; });
  }

  let hover = 0, hoverT = 0;
  if (cta) {
    const on = () => (hoverT = 1), off = () => (hoverT = 0);
    cta.addEventListener('pointerenter', on); cta.addEventListener('pointerleave', off);
    cta.addEventListener('focus', on); cta.addEventListener('blur', off);
  }

  const perspective = (fov, aspect) => {
    const f = 1 / Math.tan(fov / 2), n = 0.1, far = 200;
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + n) / (n - far), -1, 0, 0, (2 * far * n) / (n - far), 0]);
  };
  const viewM = (yaw, pitch, cx, cy) => {
    const cy_ = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // R = Rx(pitch) * Ry(yaw), then translate by -camera
    const m = [cy_, sy * sp, -sy * cp, 0, 0, cp, sp, 0, sy, -cy_ * sp, cy_ * cp, 0, 0, 0, 0, 1];
    m[12] = -(m[0] * cx + m[4] * cy); m[13] = -(m[1] * cx + m[5] * cy); m[14] = -(m[2] * cx + m[6] * cy);
    return new Float32Array(m);
  };

  const cam = { drift: 0, scroll: 0, snap: reduce ? 1 : 0, hi: 0, zoom: 0, speed: 0, travelPrev: 0, mul: 1 };
  let t0 = performance.now(), last = t0, running = false, visible = true, slow = 0;

  function frame(now) {
    running = false;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const time = (now - t0) / 1000;
    if (dt > 0.03) slow++; else slow = Math.max(0, slow - 1);
    if (slow > 45 && dpr > 1) { dpr = 1; resize(); slow = 0; }

    const p = progress();
    S.p = p;
    const s = story(p);
    const k = (rate) => 1 - Math.exp(-rate * dt);

    hover += (hoverT - hover) * k(3);
    cam.mul += ((1 - hover) * (1 - s.zoom * 0.7) - cam.mul) * k(2.5);
    cam.drift += dt * 0.55 * cam.mul;
    cam.scroll += (p * 96 - cam.scroll) * k(4);
    const travel = cam.drift + cam.scroll;
    cam.speed += (Math.abs(travel - cam.travelPrev) / Math.max(dt, 1e-3) - cam.speed) * k(4);
    cam.travelPrev = travel;
    cam.snap += (Math.max(s.snap, hover) - cam.snap) * k(3.5);
    cam.hi += (s.hi - cam.hi) * k(4);
    cam.zoom += (s.zoom - cam.zoom) * k(3);

    mouse.x += (mouse.tx - mouse.x) * k(6); mouse.y += (mouse.ty - mouse.y) * k(6);
    mouse.on += (mouse.ton - mouse.on) * k(3);

    const aspect = W / Math.max(H, 1);
    const fovDeg = (small ? 64 : 54) - 13 * cam.zoom + 7 * cam.snap + Math.min(cam.speed, 30) * 0.12;
    const proj = perspective((fovDeg * Math.PI) / 180, aspect);
    const yaw = mouse.x * 0.05 * mouse.on + Math.sin(time * 0.11) * 0.03;
    const pitch = -0.13 + mouse.y * 0.03 * mouse.on + Math.sin(time * 0.17) * 0.012 - cam.zoom * 0.05;
    const view = viewM(yaw, -pitch, Math.sin(time * 0.07) * 0.8, Math.sin(time * 0.13) * 0.15 + cam.zoom * -0.4);

    world.style.setProperty('--speed', Math.min(1, cam.speed / 40).toFixed(3));
    if (tc) {
      const f = Math.floor(travel * 12), ff = f % 24, sec = Math.floor(f / 24);
      tc.textContent = `00:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    const common = (u) => {
      gl.uniformMatrix4fv(u.uProj, false, proj);
      gl.uniformMatrix4fv(u.uView, false, view);
      gl.uniform1f(u.uTravel, travel); gl.uniform1f(u.uL, L); gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uSnap, cam.snap); gl.uniform1f(u.uAspect, aspect); gl.uniform1f(u.uHi, cam.hi);
      gl.uniform1f(u.uMouseOn, mouse.on); gl.uniform2f(u.uMouse, mouse.x, mouse.y);
    };
    gl.useProgram(linesProg); common(UL);
    gl.bindVertexArray(vaoL); gl.drawArrays(gl.LINES, 0, NL);
    gl.useProgram(pointsProg); common(UP);
    gl.bindVertexArray(vaoP); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, N);

    if (!reduce) loop();
  }
  function loop() { if (!running && visible && !document.hidden) { running = true; requestAnimationFrame(frame); } }

  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) { last = performance.now(); loop(); } }).observe(world);
  document.addEventListener('visibilitychange', () => { last = performance.now(); loop(); });
  if (reduce) {
    // one still frame, with v2 in and the keyframes on the grid
    requestAnimationFrame(frame);
    addEventListener('resize', () => requestAnimationFrame(frame));
  } else {
    loop();
    // keep the text and the frame card in step with the scroll even if frames are throttled
    addEventListener('scroll', () => story(progress()), { passive: true });
  }
  world.classList.add('gl');
}
