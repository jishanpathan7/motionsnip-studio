// Browser-only stand-in for the local player server, used by the public demo.
// The real player talks to a Node server on 127.0.0.1 that reads and writes the
// project folder. Here the same /api/* calls are answered in the page: the reel
// comes from /p/reel.json, saved state lives in localStorage, and "Send to Claude"
// shows the feedback file it would have written instead of saving it.
(() => {
  const realFetch = window.fetch.bind(window);
  const STATE_KEY = 'motionsnip:demo:server-state';
  const DEMO_PATH = '~/motionsnip-demo';
  const RESET_KEY = 'motionsnip:demo:reset';

  try {
    if (sessionStorage.getItem(RESET_KEY)) {
      sessionStorage.removeItem(RESET_KEY);
      for (const k of Object.keys(localStorage)) if (k.startsWith('motionsnip:') && k !== 'motionsnip:theme') localStorage.removeItem(k);
    }
  } catch {}

  const json = (status, body) =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const readState = () => {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    } catch {
      return {};
    }
  };

  async function bodyJson(init) {
    try {
      return JSON.parse(init && typeof init.body === 'string' ? init.body : '{}');
    } catch {
      return {};
    }
  }

  async function handle(route, method, url, init) {
    switch (`${method} ${route}`) {
      case 'GET reel': {
        const res = await realFetch('/p/reel.json', { cache: 'no-store' });
        if (!res.ok) return json(404, { error: 'Demo reel is missing' });
        const reel = await res.json();
        reel.path = DEMO_PATH;
        return json(200, reel);
      }
      case 'GET state':
        return json(200, readState());
      case 'POST state': {
        try {
          localStorage.setItem(STATE_KEY, init.body);
        } catch {}
        return json(200, { ok: true });
      }
      case 'POST feedback': {
        const body = await bodyJson(init);
        const path = `${DEMO_PATH}/.motionsnip/feedback-v${body.version || 1}.md`;
        setTimeout(() => showFeedback(body.markdown || '', path), 250);
        return json(200, { path });
      }
      case 'POST upload': {
        const name = url.searchParams.get('name') || 'music.mp3';
        const image = /\.(png|jpe?g|webp)$/i.test(name);
        if (!image && !/\.(mp3|wav|m4a)$/i.test(name)) return json(400, { error: 'Only mp3, wav, m4a, png, jpg or webp files can be uploaded' });
        const blob = init && init.body instanceof Blob ? init.body : null;
        if (!blob) return json(400, { error: 'The file is empty' });
        // a blob URL plays in this tab; it won't survive a reload, which is fine for a demo
        return json(200, { id: URL.createObjectURL(blob), name, type: image ? 'image' : 'audio' });
      }
      case 'GET takes':
        return json(200, []);
      case 'GET export':
        return json(200, null);
      case 'GET ffmpeg':
        return json(200, { ok: false, path: null, edits: false });
      case 'POST export':
        return json(400, { error: 'Export runs on your own computer. Install MotionSnip Studio to export an mp4.' });
      case 'GET cutdown':
        return json(200, { state: 'idle', pct: 0, line: '', id: null, label: null });
      case 'POST cutdown':
        return json(400, { error: 'Cutdowns are made on your own computer. Install MotionSnip Studio to make a 9:16, 1:1 or bumper.' });
      case 'POST cutdown-remove':
        return json(400, { error: 'Not available in the web demo' });
      case 'POST reveal':
        return json(400, { error: 'Not available in the web demo' });
      default:
        return json(404, { error: 'Unknown API route' });
    }
  }

  window.fetch = (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input && input.url;
    const url = new URL(raw, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
      const method = (init.method || (input && input.method) || 'GET').toUpperCase();
      return handle(url.pathname.slice(5), method === 'HEAD' ? 'GET' : method, url, init);
    }
    return realFetch(input, init);
  };

  // ------------------------------------------------------------------ banner + feedback dialog

  const css = `
  .demo-bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9999;display:flex;gap:10px;align-items:center;
    background:#15121d;color:#f6f4ef;border:1px solid #3e3552;border-radius:999px;padding:7px 8px 7px 14px;
    font:500 13px/1.2 "Bricolage Grotesque",system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:calc(100vw - 32px)}
  .demo-bar i{width:8px;height:8px;border-radius:50%;background:#ff4fa8;flex:none}
  .demo-bar span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .demo-bar a{color:#15121d;background:#e8ff47;border-radius:999px;padding:5px 11px;text-decoration:none;font-weight:600;white-space:nowrap}
  .demo-bar button{all:unset;cursor:pointer;color:#a49db3;padding:0 6px;font-size:16px}
  .demo-bar button.reset{font-size:13px;color:#f6f4ef;white-space:nowrap}
  .demo-bar button:focus-visible,.demo-bar a:focus-visible{outline:2px solid #ff4fa8;outline-offset:2px;border-radius:6px}
  .demo-dlg{max-width:min(720px,calc(100vw - 32px));width:100%;border:1px solid #3e3552;border-radius:14px;padding:0;background:#211c2b;color:#f6f4ef;
    font:400 14px/1.5 "Bricolage Grotesque",system-ui,sans-serif}
  .demo-dlg::backdrop{background:rgba(21,18,29,.6)}
  .demo-dlg header{padding:18px 20px 6px}
  .demo-dlg h2{margin:0 0 4px;font-size:19px;font-weight:700}
  .demo-dlg p{margin:0;color:#cfcad8}
  .demo-dlg code{font-family:"DM Mono",ui-monospace,monospace}
  .demo-dlg pre{margin:14px 20px;max-height:46vh;overflow:auto;background:#15121d;border:1px solid #2f2840;border-radius:10px;padding:12px 14px;
    font:400 12.5px/1.55 "DM Mono",ui-monospace,monospace;white-space:pre-wrap;color:#f6f4ef}
  .demo-dlg footer{display:flex;gap:10px;justify-content:flex-end;padding:0 20px 18px;flex-wrap:wrap}
  .demo-dlg a,.demo-dlg button{font:600 14px/1 "Bricolage Grotesque",system-ui,sans-serif;border-radius:9px;padding:10px 14px;cursor:pointer;text-decoration:none}
  .demo-dlg .ghost{background:transparent;border:1px solid #3e3552;color:#f6f4ef}
  .demo-dlg .tape{background:#e8ff47;border:1px solid #e8ff47;color:#15121d}
  @media (max-width:640px){.demo-bar span{display:none}}`;

  function mountBar() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    try {
      if (sessionStorage.getItem('motionsnip:demo:bar') === 'hidden') return;
    } catch {}
    const bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.setAttribute('role', 'note');
    bar.innerHTML =
      '<i aria-hidden="true"></i><span>Web demo. Notes stay in this browser; nothing is uploaded.</span>' +
      '<button type="button" class="reset" data-reset>Start over</button>' +
      '<a href="https://github.com/jishanpathan7/motionsnip-studio#install">Install it</a>' +
      '<button type="button" data-hide aria-label="Hide this banner">×</button>';
    bar.querySelector('[data-reset]').addEventListener('click', resetDemo);
    bar.querySelector('[data-hide]').addEventListener('click', () => {
      bar.remove();
      try {
        sessionStorage.setItem('motionsnip:demo:bar', 'hidden');
      } catch {}
    });
    document.body.append(bar);
  }

  // Forget every note, edit and send so the demo opens fresh. The player saves its
  // state again while the page unloads, so the wipe happens at the start of the
  // next load, before the app reads anything.
  function resetDemo() {
    try {
      sessionStorage.setItem(RESET_KEY, '1');
    } catch {}
    location.replace(location.pathname);
  }

  function showFeedback(markdown, path) {
    const dlg = document.createElement('dialog');
    dlg.className = 'demo-dlg';
    dlg.innerHTML =
      '<header><h2>This is what Claude gets</h2>' +
      '<p>On your computer, MotionSnip saves this to <code></code> and copies one line for you to paste into Claude Code. Claude applies it and the next version loads here by itself.</p></header>' +
      '<pre></pre><footer><button type="button" class="ghost" data-reset>Start over</button><button type="button" class="ghost" data-close>Close</button>' +
      '<a class="tape" href="https://github.com/jishanpathan7/motionsnip-studio#install">Install MotionSnip Studio</a></footer>';
    dlg.querySelector('code').textContent = path;
    dlg.querySelector('pre').textContent = markdown;
    dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
    dlg.querySelector('[data-reset]').addEventListener('click', resetDemo);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBar);
  else mountBar();
})();
