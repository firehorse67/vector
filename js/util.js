/* Shared helpers. Everything hangs off window.V. */
'use strict';
window.V = window.V || {};
(function (V) {
  const NS = V.NS = 'http://www.w3.org/2000/svg';
  V.XLINK = 'http://www.w3.org/1999/xlink';

  V.$ = (sel, root = document) => root.querySelector(sel);
  V.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  V.svgEl = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  V.h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };
  V.icon = (id) => {
    const s = document.createElementNS(NS, 'svg');
    const u = document.createElementNS(NS, 'use');
    u.setAttribute('href', '#' + id);
    s.appendChild(u);
    return s;
  };

  V.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* Number formatting: trims trailing zeros. */
  V.fmt = (n, dp = 3) => {
    if (!isFinite(n)) return '0';
    const p = Math.pow(10, dp);
    let r = Math.round(n * p) / p;
    if (Object.is(r, -0)) r = 0;
    return String(r);
  };
  V.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  V.debounce = (fn, ms) => {
    let t;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.flush = (...a) => { clearTimeout(t); fn(...a); };
    d.cancel = () => clearTimeout(t);
    return d;
  };
  V.uid = (prefix = 'v') => prefix + Math.random().toString(36).slice(2, 8);

  /* ---------------- toast / busy / prompt ---------------- */
  let toastT;
  V.toast = (msg, kind) => {
    const t = V.$('#toast');
    t.textContent = msg;
    t.className = 'show' + (kind === 'err' ? ' err' : '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.className = ''; }, kind === 'err' ? 6000 : 3200);
  };
  V.busy = (msg) => {
    const b = V.$('#busy');
    if (msg === false) { b.hidden = true; return; }
    V.$('#busyMsg').textContent = msg || 'Working…';
    b.hidden = false;
  };
  // Lets the busy overlay paint before heavy work; the timeout covers background windows where rAF never fires.
  V.nextFrame = () => new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; setTimeout(r, 0); } }; requestAnimationFrame(go); setTimeout(go, 80); });

  V.prompt = (title, msg, value = '', type = 'text') => new Promise((resolve) => {
    const dlg = V.$('#promptDlg');
    V.$('#promptTitle').textContent = title;
    V.$('#promptMsg').textContent = msg || '';
    const inp = V.$('#promptInput');
    inp.type = type;
    inp.value = value;
    dlg.returnValue = '';
    const done = () => {
      dlg.removeEventListener('close', done);
      resolve(dlg.returnValue === 'ok' ? inp.value : null);
      inp.type = 'text';
    };
    dlg.addEventListener('close', done);
    dlg.showModal();
    inp.select();
  });

  /* ---------------- files ---------------- */
  V.readAs = (file, how) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    if (how === 'text') r.readAsText(file);
    else if (how === 'dataurl') r.readAsDataURL(file);
    else r.readAsArrayBuffer(file);
  });
  V.blobToDataURL = (blob) => V.readAs(blob, 'dataurl');

  V.download = (data, name, mime) => {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = V.h('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  /* Save with the File System Access API when available (lets Ctrl+S write back to the
     same file), otherwise fall back to a normal download. Returns the handle used, or null. */
  V.saveFile = async (data, name, mime, ext, handle) => {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    if (window.showSaveFilePicker) {
      try {
        if (!handle) {
          handle = await window.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: ext.toUpperCase() + ' file', accept: { [mime]: ['.' + ext] } }],
          });
        }
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        return handle;
      } catch (e) {
        if (e && e.name === 'AbortError') return undefined; // user cancelled
        console.warn('File System Access failed, falling back to download', e);
      }
    }
    V.download(blob, name, mime);
    return null;
  };

  V.pickFile = (inputId) => new Promise((resolve) => {
    const inp = document.getElementById(inputId);
    inp.value = '';
    const on = () => { inp.removeEventListener('change', on); resolve(inp.multiple ? Array.from(inp.files) : inp.files[0] || null); };
    inp.addEventListener('change', on);
    inp.click();
  });

  V.baseName = (n) => String(n || 'untitled').replace(/\.[^.]+$/, '');

  /* ---------------- matrices ---------------- */
  V.M = (a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) => new DOMMatrix([a, b, c, d, e, f]);
  V.mOf = (m) => (m ? new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]) : new DOMMatrix());
  V.elTransform = (el) => {
    const tl = el.transform && el.transform.baseVal;
    if (!tl || !tl.numberOfItems) return new DOMMatrix();
    const c = tl.consolidate();
    return c ? V.mOf(c.matrix) : new DOMMatrix();
  };
  V.mIsIdentity = (m, eps = 1e-9) => Math.abs(m.a - 1) < eps && Math.abs(m.b) < eps && Math.abs(m.c) < eps && Math.abs(m.d - 1) < eps && Math.abs(m.e) < eps && Math.abs(m.f) < eps;
  V.mToString = (m) => {
    if (V.mIsIdentity(m)) return null;
    const f = (n) => V.fmt(n, 4);
    if (Math.abs(m.a - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.d - 1) < 1e-9) return `translate(${f(m.e)} ${f(m.f)})`;
    const rot = V.mDecompose(m);
    if (Math.abs(rot.sx - 1) < 1e-6 && Math.abs(rot.sy - 1) < 1e-6 && Math.abs(rot.skew) < 1e-6 && Math.abs(rot.angle) > 1e-6) {
      // pure rotation (+translation): express as rotate(a cx cy) when it has a fixed point
      const a = rot.angle * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      const den = 2 - 2 * cos;
      if (den > 1e-9) {
        const cx = ((1 - cos) * m.e - sin * m.f) / den;
        const cy = (sin * m.e + (1 - cos) * m.f) / den;
        return `rotate(${f(rot.angle)} ${f(cx)} ${f(cy)})`;
      }
    }
    return `matrix(${f(m.a)} ${f(m.b)} ${f(m.c)} ${f(m.d)} ${f(m.e)} ${f(m.f)})`;
  };
  V.setTransform = (el, m) => {
    const s = V.mToString(m);
    if (s) el.setAttribute('transform', s); else el.removeAttribute('transform');
  };
  V.mDecompose = (m) => {
    const sx = Math.hypot(m.a, m.b);
    const angle = Math.atan2(m.b, m.a) * 180 / Math.PI;
    const det = m.a * m.d - m.b * m.c;
    const sy = sx ? det / sx : 0;
    const skew = sx ? (m.a * m.c + m.b * m.d) / (sx * sx) : 0;
    return { sx, sy, angle, skew, tx: m.e, ty: m.f };
  };
  V.pt = (x, y) => new DOMPoint(x, y);
  V.apply = (m, x, y) => { const p = new DOMPoint(x, y).matrixTransform(m); return { x: p.x, y: p.y }; };

  /* ---------------- colour ---------------- */
  const cc = document.createElement('canvas').getContext('2d');
  V.toHex = (c) => {
    if (!c || c === 'none' || c === 'transparent') return null;
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('').toLowerCase();
    if (/^url\(/.test(c)) return null;
    cc.fillStyle = '#000';
    cc.fillStyle = c;
    const v = cc.fillStyle;
    if (v.startsWith('#')) return v;
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b] = m[1].split(',').map((n) => parseFloat(n));
    return '#' + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
  };
  V.parseColor = (c) => {
    // -> {r,g,b,a} 0..1, or null for none/unknown
    if (!c || c === 'none' || c === 'transparent' || /^url\(/.test(c)) return null;
    cc.fillStyle = '#000';
    cc.fillStyle = c;
    const v = cc.fillStyle;
    if (v.startsWith('#')) {
      return { r: parseInt(v.slice(1, 3), 16) / 255, g: parseInt(v.slice(3, 5), 16) / 255, b: parseInt(v.slice(5, 7), 16) / 255, a: 1 };
    }
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((n) => parseFloat(n));
    return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
  };

  /* ---------------- SVG sanitising ----------------
     Imported SVG is untrusted. Remove anything that can run code or fetch remote content. */
  const BAD_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'audio', 'video', 'meta', 'link', 'base', 'form', 'input', 'button', 'textarea', 'select', 'frame', 'frameset', 'applet']);
  V.sanitizeSvg = (root) => {
    const warn = new Set();
    const walk = (node) => {
      for (const kid of Array.from(node.childNodes)) {
        if (kid.nodeType === 1) {
          const tag = kid.localName.toLowerCase();
          if (BAD_TAGS.has(tag)) { kid.remove(); warn.add('scripts and embedded objects were removed'); continue; }
          if (tag === 'foreignobject') {
            // Keep foreignObject but strip anything active inside it.
            V.$$('script,iframe,object,embed,link,meta,base,form', kid).forEach((n) => n.remove());
          }
          for (const at of Array.from(kid.attributes)) {
            const n = at.name.toLowerCase();
            const v = at.value.trim().toLowerCase().replace(/\s+/g, '');
            if (n.startsWith('on')) { kid.removeAttribute(at.name); warn.add('event handlers were removed'); continue; }
            if ((n === 'href' || n === 'xlink:href' || n === 'src' || n === 'action' || n === 'formaction') &&
              (v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html') || v.startsWith('data:application'))) {
              kid.removeAttribute(at.name); warn.add('script links were removed'); continue;
            }
            if ((n === 'href' || n === 'xlink:href') && /^(https?:)?\/\//.test(v) && tag !== 'a') {
              kid.removeAttribute(at.name); warn.add('external resources were removed'); continue;
            }
            if (n === 'style' && /url\(\s*['"]?\s*(https?:|\/\/|javascript:)/i.test(at.value)) {
              kid.setAttribute('style', at.value.replace(/url\([^)]*\)/gi, 'none')); warn.add('external resources were removed');
            }
          }
          if (tag === 'style') {
            const t = kid.textContent;
            if (/@import|url\(\s*['"]?\s*(https?:|\/\/)|expression\(|javascript:/i.test(t)) {
              kid.textContent = t.replace(/@import[^;]+;?/gi, '').replace(/url\(\s*['"]?\s*(https?:|\/\/|javascript:)[^)]*\)/gi, 'none');
              warn.add('external stylesheet references were removed');
            }
          }
          if (tag === 'a') {
            const v = (kid.getAttribute('href') || kid.getAttributeNS(V.XLINK, 'href') || '').trim().toLowerCase();
            if (v.startsWith('javascript:')) { kid.removeAttribute('href'); kid.removeAttributeNS(V.XLINK, 'href'); }
          }
          walk(kid);
        } else if (kid.nodeType === 8 || kid.nodeType === 7) {
          // comments / processing instructions
          kid.remove();
        }
      }
    };
    walk(root);
    for (const at of Array.from(root.attributes)) if (at.name.toLowerCase().startsWith('on')) root.removeAttribute(at.name);
    return Array.from(warn);
  };

  /* Parse SVG text into an <svg> element owned by this document (sanitised). */
  V.parseSvgText = (text) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    if (err) {
      const msg = (err.textContent || 'Invalid SVG').split('\n').filter(Boolean).slice(0, 2).join(' ');
      throw new Error(msg.replace(/^This page contains the following errors:/, '').trim());
    }
    const root = doc.documentElement;
    if (!root || root.localName !== 'svg') throw new Error('Not an SVG document (root element is <' + (root && root.localName) + '>)');
    const svg = document.importNode(root, true);
    const warnings = V.sanitizeSvg(svg);
    return { svg, warnings };
  };

  /* Unit conversion to CSS px. */
  V.toPx = (val, fallback) => {
    if (val == null || val === '') return fallback;
    const m = String(val).trim().match(/^([+-]?[\d.]+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|%|em|ex)?$/i);
    if (!m) return fallback;
    const n = parseFloat(m[1]);
    switch ((m[2] || 'px').toLowerCase()) {
      case 'px': return n;
      case 'pt': return n * 96 / 72;
      case 'pc': return n * 16;
      case 'mm': return n * 96 / 25.4;
      case 'cm': return n * 96 / 2.54;
      case 'in': return n * 96;
      case 'em': return n * 16;
      case 'ex': return n * 8;
      default: return fallback; // %
    }
  };

  /* Load an image (data/blob url) into an HTMLImageElement. */
  V.loadImage = (src) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not load image'));
    img.src = src;
  });
  V.canvasToBlob = (canvas, type, q) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Canvas export failed (image may be too large)'))), type, q));

  V.dataUrlToBytes = (url) => {
    const i = url.indexOf(',');
    const meta = url.slice(5, i);
    const isB64 = /;base64/i.test(meta);
    const body = url.slice(i + 1);
    let bytes;
    if (isB64) {
      const bin = atob(body);
      bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
    return { mime: meta.split(';')[0] || 'application/octet-stream', bytes };
  };

  V.storage = {
    get(k, d) { try { const v = localStorage.getItem('vector:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('vector:' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem('vector:' + k); } catch (e) {} },
  };

  V.isTyping = (e) => {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  };
})(window.V);
