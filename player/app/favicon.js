// Live favicon: idle, notes waiting (pink dot), Claude working (sweep), new version (big pink dot until focus).
// Drawn on a canvas so the sweep can move.

import { prefersReducedMotion } from './util.js';

const BAY = '#15121D';
const PAPER = '#F6F4EF';
const CUE = '#FF4FA8';
const GRAIN = '#A49DB3';

const fav = { link: null, canvas: null, state: 'idle', timer: 0, angle: 0 };

export function initFavicon() {
  fav.link = document.querySelector('link[rel="icon"]') || document.createElement('link');
  fav.link.rel = 'icon';
  fav.link.type = 'image/png';
  if (!fav.link.isConnected) document.head.append(fav.link);
  fav.canvas = document.createElement('canvas');
  fav.canvas.width = 64;
  fav.canvas.height = 64;
  draw();
}

/** 'idle' | 'notes' | 'working' | 'ready' */
export function setFavicon(state) {
  if (state === fav.state && fav.link?.href) return;
  fav.state = state;
  clearInterval(fav.timer);
  fav.timer = 0;
  if (state === 'working' && !prefersReducedMotion()) {
    fav.timer = setInterval(() => {
      fav.angle = (fav.angle + Math.PI / 10) % (Math.PI * 2);
      draw();
    }, 120);
  }
  draw();
}

function draw() {
  const c = fav.canvas;
  if (!c) return;
  const g = c.getContext('2d');
  const s = c.width / 32;
  g.setTransform(s, 0, 0, s, 0, 0);
  g.clearRect(0, 0, 32, 32);
  rr(g, 0, 0, 32, 32, 7, BAY);
  rr(g, 3.5, 8, 25, 16.5, 3.5, PAPER);
  const cx = 22.5;
  const cy = 13.6;
  const st = fav.state;
  if (st === 'idle') {
    g.beginPath();
    g.arc(cx, cy, 3, 0, Math.PI * 2);
    g.strokeStyle = GRAIN;
    g.lineWidth = 1.6;
    g.stroke();
  } else if (st === 'notes') {
    dot(g, cx, cy, 3.8, CUE);
  } else if (st === 'working') {
    dot(g, cx, cy, 3.8, '#D9D5CE');
    const a0 = -Math.PI / 2 + fav.angle;
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, 3.8, a0, a0 + Math.PI * 0.6);
    g.closePath();
    g.fillStyle = BAY;
    g.fill();
  } else if (st === 'ready') {
    dot(g, cx, cy, 5, CUE);
    g.beginPath();
    g.arc(cx, cy, 5, 0, Math.PI * 2);
    g.strokeStyle = BAY;
    g.lineWidth = 1.2;
    g.stroke();
  }
  try {
    fav.link.href = c.toDataURL('image/png');
  } catch {
    /* ignore */
  }
}

function rr(g, x, y, w, h, r, fill) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

function dot(g, x, y, r, fill) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
}
