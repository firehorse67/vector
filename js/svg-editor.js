/* SVG editor core: document, view, selection, tools, transforms, undo. */
'use strict';
(function (V) {
  const { NS, svgEl, fmt } = V;
  const LOCK = 'data-vector-locked';
  const GEOM = ['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points', 'd', 'transform'];
  const SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'image', 'use', 'g', 'a', 'svg', 'foreignObject', 'switch']);

  const ed = V.ed = {
    doc: null, ctx: null, sel: [], tool: 'select', zoom: 1, panX: 40, panY: 40,
    meta: { width: null, height: null }, fileName: 'drawing.svg', fileHandle: null,
    grid: V.storage.get('grid', false), snap: V.storage.get('snap', false), gridSize: V.storage.get('gridSize', 10),
    opts: Object.assign({ sides: 6, points: 5, inner: 0.5, radius: 0, strokeWidth: 2, fontSize: 32, fontFamily: 'system-ui, sans-serif', fillOn: true, strokeOn: false },
      V.storage.get('toolOpts', {})),
    defFill: V.storage.get('defFill', '#4f8cff'), defStroke: V.storage.get('defStroke', '#1d2b4f'),
    undoStack: [], redoStack: [], clipboard: null, pasteCount: 0,
    node: null, // node-edit state
    listeners: {},
  };

  ed.on = (ev, fn) => { (ed.listeners[ev] = ed.listeners[ev] || []).push(fn); };
  ed.emit = (ev, ...a) => { (ed.listeners[ev] || []).forEach((f) => f(...a)); };

  let view, viewport, docHost, overlay, stage, pageBg, pageShadow, gridLayer;

  /* ================= document ================= */
  ed.vb = () => {
    const v = V.svg2pdf.parseViewBox(ed.doc);
    return v || [0, 0, 300, 150];
  };

  ed.newDoc = (w = 800, h = 600) => {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    ed.meta = { width: String(w), height: String(h) };
    ed.installDoc(svg);
    ed.fileName = 'drawing.svg';
    ed.fileHandle = null;
    ed.resetHistory();
    ed.fit();
  };

  /* Load SVG text as the document. Returns warnings. */
  ed.loadText = (text, name) => {
    const { svg, warnings } = V.parseSvgText(text);
    const vbAttr = V.svg2pdf.parseViewBox(svg);
    const wAttr = svg.getAttribute('width'), hAttr = svg.getAttribute('height');
    const wpx = V.toPx(wAttr, vbAttr ? vbAttr[2] : 300), hpx = V.toPx(hAttr, vbAttr ? vbAttr[3] : 150);
    if (!vbAttr) svg.setAttribute('viewBox', `0 0 ${fmt(wpx)} ${fmt(hpx)}`);
    ed.meta = { width: wAttr && !/%$/.test(wAttr) ? wAttr : null, height: hAttr && !/%$/.test(hAttr) ? hAttr : null };
    ed.installDoc(svg);
    if (name) ed.fileName = name;
    ed.resetHistory();
    ed.fit();
    return warnings;
  };

  ed.installDoc = (svg) => {
    ['width', 'height', 'x', 'y'].forEach((a) => svg.removeAttribute(a));
    svg.setAttribute('id', svg.getAttribute('id') || '');
    if (!svg.getAttribute('id')) svg.removeAttribute('id');
    if (ed.doc) ed.doc.remove();
    ed.doc = svg;
    docHost.appendChild(svg);
    ed.layoutDoc();
    ed.ctx = svg;
    ed.sel = [];
    ed.exitNodeMode(true);
    ed.emit('doc');
    ed.emit('select');
    ed.redraw();
  };

  ed.layoutDoc = () => {
    const [, , w, h] = ed.vb();
    ed.doc.setAttribute('width', w);
    ed.doc.setAttribute('height', h);
    ed.doc.setAttribute('overflow', 'visible');
    for (const r of [pageBg, pageShadow]) { r.setAttribute('width', w); r.setAttribute('height', h); }
    const bg = ed.doc.getAttribute('data-vector-bg');
    pageBg.setAttribute('fill', bg || 'url(#checker)');
    ed.drawGrid();
  };

  ed.setDocSize = (w, h, keepVb) => {
    const vb = ed.vb();
    if (!keepVb) ed.doc.setAttribute('viewBox', `${fmt(vb[0])} ${fmt(vb[1])} ${fmt(w)} ${fmt(h)}`);
    ed.meta.width = String(fmt(w));
    ed.meta.height = String(fmt(h));
    ed.layoutDoc();
    ed.commit();
  };

  /* Serialise the document. opts: { pretty, raw (keep editor attrs) } */
  ed.getText = (opts = {}) => {
    const c = ed.doc.cloneNode(true);
    const vb = ed.vb();
    c.removeAttribute('overflow');
    c.setAttribute('width', ed.meta.width || fmt(vb[2]));
    c.setAttribute('height', ed.meta.height || fmt(vb[3]));
    if (!opts.raw) {
      c.removeAttribute('data-vector-bg');
      V.$$('[' + LOCK + ']', c).forEach((e) => e.removeAttribute(LOCK));
      V.$$('[data-vector-editing]', c).forEach((e) => { e.removeAttribute('data-vector-editing'); e.style.removeProperty('visibility'); if (!e.getAttribute('style')) e.removeAttribute('style'); });
    }
    return V.serialize(c, opts.pretty !== false);
  };

  /* Pretty XML serializer that keeps text content intact. */
  const INLINE = new Set(['text', 'tspan', 'textPath', 'style', 'title', 'desc', 'script', 'a']);
  V.serialize = (root, pretty = true) => {
    const xs = new XMLSerializer();
    const escA = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, '&#10;');
    const escT = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let usesXlink = false;
    const attrs = (el, isRoot) => {
      let s = '';
      if (isRoot) {
        s += ` xmlns="${NS}"`;
      }
      for (const a of el.attributes) {
        if (a.name === 'xmlns') continue;
        if (a.name === 'xmlns:xlink') continue;
        if (a.name.startsWith('xlink:')) usesXlink = true;
        s += ` ${a.name}="${escA(a.value)}"`;
      }
      return s;
    };
    const hasElementKids = (el) => Array.from(el.childNodes).some((k) => k.nodeType === 1);
    const inlineContent = (el) => Array.from(el.childNodes).map((k) => {
      if (k.nodeType === 3) return escT(k.data);
      if (k.nodeType === 4) return '<![CDATA[' + k.data + ']]>';
      if (k.nodeType === 1) {
        const tag = k.tagName;
        const kids = inlineContent(k);
        return `<${tag}${attrs(k, false)}${kids ? '>' + kids + `</${tag}>` : '/>'}`;
      }
      return '';
    }).join('');
    const out = [];
    const walk = (el, depth, isRoot) => {
      const ind = pretty ? '  '.repeat(depth) : '';
      const tag = el.tagName;
      const a = attrs(el, isRoot);
      if (INLINE.has(el.localName) || !hasElementKids(el)) {
        const kids = el.localName === 'style' ? Array.from(el.childNodes).map((k) => (k.nodeType === 4 ? '<![CDATA[' + k.data + ']]>' : escT(k.data || ''))).join('') : inlineContent(el);
        const trimmedKids = (!INLINE.has(el.localName) && !kids.trim()) ? '' : kids;
        out.push(ind + `<${tag}${a}${trimmedKids ? '>' + trimmedKids + `</${tag}>` : '/>'}`);
        return;
      }
      out.push(ind + `<${tag}${a}>`);
      for (const k of el.childNodes) {
        if (k.nodeType === 1) walk(k, depth + 1, false);
        else if (k.nodeType === 3 && k.data.trim()) out.push((pretty ? '  '.repeat(depth + 1) : '') + escT(k.data.trim()));
        else if (k.nodeType === 4) out.push((pretty ? '  '.repeat(depth + 1) : '') + '<![CDATA[' + k.data + ']]>');
      }
      out.push(ind + `</${tag}>`);
    };
    walk(root, 0, true);
    let s = out.join(pretty ? '\n' : '');
    if (usesXlink) s = s.replace(`xmlns="${NS}"`, `xmlns="${NS}" xmlns:xlink="${V.XLINK}"`);
    void xs;
    return s + (pretty ? '\n' : '');
  };

  /* ================= history ================= */
  const snapshot = () => ed.getText({ pretty: false, raw: true });
  const indexPath = (el) => {
    const p = [];
    while (el && el !== ed.doc) { p.unshift(Array.prototype.indexOf.call(el.parentNode.children, el)); el = el.parentNode; }
    return el === ed.doc ? p : null;
  };
  const resolvePath = (p) => {
    let el = ed.doc;
    for (const i of p) { el = el && el.children[i]; }
    return el || null;
  };

  ed.resetHistory = () => {
    ed.undoStack = [{ text: snapshot(), meta: Object.assign({}, ed.meta), sel: [] }];
    ed.redoStack = [];
    ed.emit('history');
    ed.emit('change', { reset: true });
  };
  ed.commit = (opts = {}) => {
    const text = snapshot();
    const top = ed.undoStack[ed.undoStack.length - 1];
    if (top && top.text === text && JSON.stringify(top.meta) === JSON.stringify(ed.meta)) { ed.redraw(); return false; }
    ed.undoStack.push({ text, meta: Object.assign({}, ed.meta), sel: ed.sel.map(indexPath).filter(Boolean) });
    if (ed.undoStack.length > 300) ed.undoStack.shift();
    ed.redoStack = [];
    ed.emit('history');
    ed.emit('change', opts);
    ed.redraw();
    return true;
  };
  const restore = (state) => {
    const ctxPath = ed.ctx && ed.ctx !== ed.doc ? indexPath(ed.ctx) : null;
    const { svg } = (() => {
      const d = new DOMParser().parseFromString(state.text, 'image/svg+xml');
      return { svg: document.importNode(d.documentElement, true) };
    })();
    ed.meta = Object.assign({}, state.meta);
    ['width', 'height'].forEach((a) => svg.removeAttribute(a));
    if (ed.doc) ed.doc.remove();
    ed.doc = svg;
    docHost.appendChild(svg);
    ed.layoutDoc();
    ed.ctx = (ctxPath && resolvePath(ctxPath)) || svg;
    if (ed.ctx.localName !== 'g' && ed.ctx !== svg) ed.ctx = svg;
    ed.sel = (state.sel || []).map(resolvePath).filter(Boolean);
    ed.exitNodeMode(true);
    ed.emit('doc');
    ed.emit('select');
    ed.emit('change', { history: true });
    ed.redraw();
  };
  ed.undo = () => {
    if (ed.node) { /* node edits are committed per drag; undo normally */ }
    if (ed.undoStack.length < 2) return;
    const cur = ed.undoStack.pop();
    cur.sel = ed.sel.map(indexPath).filter(Boolean);
    ed.redoStack.push(cur);
    restore(ed.undoStack[ed.undoStack.length - 1]);
    ed.emit('history');
  };
  ed.redo = () => {
    const s = ed.redoStack.pop();
    if (!s) return;
    ed.undoStack.push(s);
    restore(s);
    ed.emit('history');
  };

  /* ================= coordinates ================= */
  const viewInv = () => V.mOf(view.getScreenCTM()).inverse();
  ed.clientToView = (x, y) => V.apply(viewInv(), x, y);
  ed.clientToDoc = (x, y) => V.apply(ed.doc.getScreenCTM().inverse(), x, y);
  ed.clientToLocal = (el, x, y) => V.apply(el.getScreenCTM().inverse(), x, y);
  ed.localToView = (el) => { const c = el.getScreenCTM(); return c ? viewInv().multiply(V.mOf(c)) : null; };
  ed.localToDoc = (el) => { const c = el.getScreenCTM(); return c ? V.mOf(ed.doc.getScreenCTM()).inverse().multiply(V.mOf(c)) : null; };
  ed.parentToDoc = (el) => ed.localToDoc(el.parentNode);
  ed.docToView = () => viewInv().multiply(V.mOf(ed.doc.getScreenCTM()));
  ed.snapV = (v) => (ed.snap ? Math.round(v / ed.gridSize) * ed.gridSize : v);
  ed.snapPt = (p) => ({ x: ed.snapV(p.x), y: ed.snapV(p.y) });

  /* Bounding box of an element in document coordinates (axis aligned). */
  ed.docBBox = (el) => {
    let b;
    try { b = el.getBBox(); } catch (e) { return null; }
    const m = ed.localToDoc(el);
    if (!m) return null;
    const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]].map(([x, y]) => V.apply(m, x, y));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  };
  ed.unionBBox = (els) => {
    let r = null;
    for (const el of els) {
      const b = ed.docBBox(el);
      if (!b) continue;
      if (!r) r = { ...b };
      else {
        const x2 = Math.max(r.x + r.width, b.x + b.width), y2 = Math.max(r.y + r.height, b.y + b.height);
        r.x = Math.min(r.x, b.x); r.y = Math.min(r.y, b.y); r.width = x2 - r.x; r.height = y2 - r.y;
      }
    }
    return r;
  };

  /* ================= view ================= */
  const applyView = () => {
    viewport.setAttribute('transform', `translate(${ed.panX} ${ed.panY}) scale(${ed.zoom})`);
    ed.drawGrid();
    ed.redraw();
    ed.emit('zoom');
  };
  ed.setZoom = (z, cx, cy) => {
    z = V.clamp(z, 0.02, 256);
    const r = view.getBoundingClientRect();
    if (cx == null) { cx = r.width / 2; cy = r.height / 2; }
    const k = z / ed.zoom;
    ed.panX = cx - (cx - ed.panX) * k;
    ed.panY = cy - (cy - ed.panY) * k;
    ed.zoom = z;
    applyView();
  };
  ed.zoomBy = (f, cx, cy) => ed.setZoom(ed.zoom * f, cx, cy);
  ed.fit = (box) => {
    const r = view.getBoundingClientRect();
    if (!r.width) { requestAnimationFrame(() => ed.fit(box)); return; }
    const vb = ed.vb();
    const b = box || { x: 0, y: 0, width: vb[2], height: vb[3] }; // viewport coords
    const pad = 40;
    const z = Math.min((r.width - pad * 2) / Math.max(b.width, 1), (r.height - pad * 2) / Math.max(b.height, 1));
    ed.zoom = V.clamp(z, 0.02, 64);
    ed.panX = (r.width - b.width * ed.zoom) / 2 - b.x * ed.zoom;
    ed.panY = (r.height - b.height * ed.zoom) / 2 - b.y * ed.zoom;
    applyView();
  };
  ed.fitSelection = () => {
    const b = ed.unionBBox(ed.sel);
    if (!b) return ed.fit();
    const vb = ed.vb();
    ed.fit({ x: b.x - vb[0], y: b.y - vb[1], width: b.width, height: b.height });
  };

  ed.drawGrid = () => {
    if (!gridLayer || !ed.doc) return;
    gridLayer.textContent = '';
    if (!ed.grid) return;
    const vb = ed.vb();
    const g = ed.gridSize;
    if (!(g > 0)) return;
    let step = g;
    while (step * ed.zoom < 6) step *= 5;
    const sw = 1 / ed.zoom;
    const x0 = Math.ceil(vb[0] / step) * step, y0 = Math.ceil(vb[1] / step) * step;
    const frag = document.createDocumentFragment();
    let count = 0;
    for (let x = x0; x <= vb[0] + vb[2] + 1e-9 && count < 2000; x += step, count++) {
      const major = Math.abs(Math.round(x / (step * 5)) * step * 5 - x) < 1e-6;
      svgEl('line', { x1: x - vb[0], y1: 0, x2: x - vb[0], y2: vb[3], 'stroke-width': sw, class: major ? 'major' : null }, frag);
    }
    count = 0;
    for (let y = y0; y <= vb[1] + vb[3] + 1e-9 && count < 2000; y += step, count++) {
      const major = Math.abs(Math.round(y / (step * 5)) * step * 5 - y) < 1e-6;
      svgEl('line', { x1: 0, y1: y - vb[1], x2: vb[2], y2: y - vb[1], 'stroke-width': sw, class: major ? 'major' : null }, frag);
    }
    gridLayer.appendChild(frag);
  };

  /* ================= selection ================= */
  ed.isLocked = (el) => {
    for (let n = el; n && n !== ed.doc; n = n.parentNode) if (n.hasAttribute && n.hasAttribute(LOCK)) return true;
    return false;
  };
  ed.select = (els, add) => {
    els = (Array.isArray(els) ? els : [els]).filter(Boolean);
    if (add) {
      const s = new Set(ed.sel);
      for (const e of els) { if (s.has(e)) s.delete(e); else s.add(e); }
      ed.sel = Array.from(s);
    } else ed.sel = els;
    if (ed.node && (ed.sel.length !== 1 || ed.sel[0] !== ed.node.el)) ed.exitNodeMode();
    ed.emit('select');
    ed.redraw();
  };
  ed.selectAll = () => {
    ed.select(Array.from(ed.ctx.children).filter((e) => SHAPES.has(e.localName) && !ed.isLocked(e) && getComputedStyle(e).display !== 'none'));
  };
  ed.setCtx = (g) => {
    ed.ctx = g || ed.doc;
    ed.emit('select');
    ed.redraw();
  };

  /* Map a hit target to the selectable element in the current context. */
  ed.pick = (node) => {
    if (!node || !ed.doc.contains(node) || node === ed.doc) return null;
    if (!ed.ctx.contains(node) || node === ed.ctx) {
      ed.ctx = ed.doc;
    }
    let n = node;
    while (n.parentNode && n.parentNode !== ed.ctx) n = n.parentNode;
    if (n.parentNode !== ed.ctx) return null;
    if (ed.isLocked(n)) return null;
    return n;
  };

  /* ================= transforms ================= */
  const origAttrs = (el) => {
    const o = {};
    for (const a of GEOM) o[a] = el.getAttribute(a);
    return o;
  };
  const restoreAttrs = (el, o) => {
    for (const a of GEOM) { if (o[a] == null) el.removeAttribute(a); else el.setAttribute(a, o[a]); }
  };

  /* Bake a transform into geometry where it can be done exactly. */
  ed.bake = (el) => {
    const m = V.elTransform(el);
    if (V.mIsIdentity(m, 1e-12)) { el.removeAttribute('transform'); return; }
    const tag = el.localName;
    const noRot = Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;
    const num = (a, d = 0) => { const v = parseFloat(el.getAttribute(a)); return isFinite(v) ? v : d; };
    const set = (a, v) => el.setAttribute(a, fmt(v, 3));
    if ((tag === 'rect' || tag === 'image') && noRot && (tag === 'rect' || (m.a > 0 && m.d > 0))) {
      if (/%/.test((el.getAttribute('width') || '') + (el.getAttribute('height') || '') + (el.getAttribute('x') || '') + (el.getAttribute('y') || ''))) return;
      const x = num('x'), y = num('y'), w = num('width'), h = num('height');
      const x1 = m.a * x + m.e, x2 = m.a * (x + w) + m.e, y1 = m.d * y + m.f, y2 = m.d * (y + h) + m.f;
      set('x', Math.min(x1, x2)); set('y', Math.min(y1, y2)); set('width', Math.abs(x2 - x1)); set('height', Math.abs(y2 - y1));
      if (tag === 'rect') {
        if (el.hasAttribute('rx')) set('rx', num('rx') * Math.abs(m.a));
        if (el.hasAttribute('ry')) set('ry', num('ry') * Math.abs(m.d));
      }
      el.removeAttribute('transform');
    } else if (tag === 'ellipse' && noRot) {
      set('cx', m.a * num('cx') + m.e); set('cy', m.d * num('cy') + m.f);
      set('rx', Math.abs(m.a) * num('rx')); set('ry', Math.abs(m.d) * num('ry'));
      el.removeAttribute('transform');
    } else if (tag === 'circle' && noRot && Math.abs(Math.abs(m.a) - Math.abs(m.d)) < 1e-9) {
      set('cx', m.a * num('cx') + m.e); set('cy', m.d * num('cy') + m.f); set('r', Math.abs(m.a) * num('r'));
      el.removeAttribute('transform');
    } else if (tag === 'line') {
      const p1 = V.apply(m, num('x1'), num('y1')), p2 = V.apply(m, num('x2'), num('y2'));
      set('x1', p1.x); set('y1', p1.y); set('x2', p2.x); set('y2', p2.y);
      el.removeAttribute('transform');
    } else if (tag === 'polyline' || tag === 'polygon') {
      const pts = V.Path.parsePoints(el.getAttribute('points')).map(([x, y]) => { const q = V.apply(m, x, y); return [q.x, q.y]; });
      el.setAttribute('points', V.Path.pointsToString(pts));
      el.removeAttribute('transform');
    } else if (tag === 'path') {
      const segs = V.Path.parse(el.getAttribute('d'));
      let out;
      if (V.Path.hasArcs(segs)) {
        const dc = V.mDecompose(m);
        const similar = Math.abs(Math.abs(dc.sx) - Math.abs(dc.sy)) < 1e-6 && Math.abs(dc.skew) < 1e-6;
        if (!similar) out = V.Path.transform(segs, m);
        else {
          const s = Math.abs(dc.sx), flip = (m.a * m.d - m.b * m.c) < 0;
          out = segs.map((g) => {
            if (g.c === 'Z') return g;
            if (g.c === 'A') {
              const q = V.apply(m, g.p[5], g.p[6]);
              return { c: 'A', p: [g.p[0] * s, g.p[1] * s, g.p[2] + dc.angle, g.p[3], flip ? 1 - g.p[4] : g.p[4], q.x, q.y] };
            }
            const p = g.p.slice();
            for (let i = 0; i < p.length; i += 2) { const q = V.apply(m, p[i], p[i + 1]); p[i] = q.x; p[i + 1] = q.y; }
            return { c: g.c, p };
          });
        }
      } else out = V.Path.transform(segs, m);
      el.setAttribute('d', V.Path.serialize(out));
      el.removeAttribute('transform');
    } else if (tag === 'text' && Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && noRot) {
      const xs = (el.getAttribute('x') || '0').trim(), ys = (el.getAttribute('y') || '0').trim();
      if (/[\s,]/.test(xs) || /[\s,]/.test(ys)) return;
      set('x', num('x') + m.e); set('y', num('y') + m.f);
      for (const t of el.querySelectorAll('tspan[x]')) { const v = parseFloat(t.getAttribute('x')); if (isFinite(v) && !/[\s,]/.test(t.getAttribute('x').trim())) t.setAttribute('x', fmt(v + m.e, 3)); }
      for (const t of el.querySelectorAll('tspan[y]')) { const v = parseFloat(t.getAttribute('y')); if (isFinite(v) && !/[\s,]/.test(t.getAttribute('y').trim())) t.setAttribute('y', fmt(v + m.f, 3)); }
      el.removeAttribute('transform');
    } else {
      V.setTransform(el, m);
    }
  };

  /* Begin a transform session on elements; returns object with apply(X docspace) or applyLocal(S). */
  const beginXform = (els) => els.map((el) => {
    const P = ed.parentToDoc(el) || new DOMMatrix();
    return { el, T0: V.elTransform(el), P, Pi: P.inverse(), orig: origAttrs(el), origTspans: V.$$('tspan', el).map((t) => [t, t.getAttribute('x'), t.getAttribute('y')]) };
  });
  const resetXform = (it) => {
    restoreAttrs(it.el, it.orig);
    for (const [t, x, y] of it.origTspans) { x == null ? t.removeAttribute('x') : t.setAttribute('x', x); y == null ? t.removeAttribute('y') : t.setAttribute('y', y); }
  };
  const applyDocX = (items, X) => {
    for (const it of items) {
      resetXform(it);
      V.setTransform(it.el, it.Pi.multiply(X).multiply(it.P).multiply(it.T0));
      ed.bake(it.el);
    }
  };
  const applyLocalX = (it, S) => {
    resetXform(it);
    V.setTransform(it.el, it.T0.multiply(S));
    ed.bake(it.el);
  };

  ed.transformSel = (X) => {
    if (!ed.sel.length) return;
    applyDocX(beginXform(ed.sel), X);
    ed.commit();
  };
  ed.nudge = (dx, dy) => {
    if (ed.node) return ed.nodeNudge(dx, dy);
    ed.transformSel(new DOMMatrix().translate(dx, dy));
  };
  ed.flip = (axis) => {
    const b = ed.unionBBox(ed.sel); if (!b) return;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    ed.transformSel(new DOMMatrix().translate(cx, cy).scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1).translate(-cx, -cy));
  };
  ed.rotateSel = (deg) => {
    const b = ed.unionBBox(ed.sel); if (!b) return;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    ed.transformSel(new DOMMatrix().translate(cx, cy).rotate(deg).translate(-cx, -cy));
  };
  ed.setBBox = (x, y, w, h) => {
    const b = ed.unionBBox(ed.sel); if (!b) return;
    const sx = b.width ? (w / b.width) : 1, sy = b.height ? (h / b.height) : 1;
    ed.transformSel(new DOMMatrix().translate(x, y).scale(sx || 1, sy || 1).translate(-b.x, -b.y));
  };
  ed.setRotation = (deg) => {
    if (ed.sel.length !== 1) return;
    const el = ed.sel[0];
    const cur = V.mDecompose(ed.localToDoc(el)).angle;
    ed.rotateSel(deg - cur);
  };

  ed.align = (how) => {
    if (!ed.sel.length) return;
    const vb = ed.vb();
    const ref = ed.sel.length === 1 ? { x: vb[0], y: vb[1], width: vb[2], height: vb[3] } : ed.unionBBox(ed.sel);
    const items = beginXform(ed.sel);
    for (const it of items) {
      const b = ed.docBBox(it.el); if (!b) continue;
      let dx = 0, dy = 0;
      if (how === 'left') dx = ref.x - b.x;
      if (how === 'hcenter') dx = ref.x + ref.width / 2 - (b.x + b.width / 2);
      if (how === 'right') dx = ref.x + ref.width - (b.x + b.width);
      if (how === 'top') dy = ref.y - b.y;
      if (how === 'vcenter') dy = ref.y + ref.height / 2 - (b.y + b.height / 2);
      if (how === 'bottom') dy = ref.y + ref.height - (b.y + b.height);
      applyDocX([it], new DOMMatrix().translate(dx, dy));
    }
    ed.commit();
  };
  ed.distribute = (axis) => {
    if (ed.sel.length < 3) { V.toast('Select three or more objects to distribute'); return; }
    const items = beginXform(ed.sel).map((it) => ({ it, b: ed.docBBox(it.el) })).filter((o) => o.b);
    const k = axis === 'h' ? 'x' : 'y', s = axis === 'h' ? 'width' : 'height';
    items.sort((a, b) => a.b[k] - b.b[k]);
    const first = items[0].b, last = items[items.length - 1].b;
    const total = items.reduce((a, o) => a + o.b[s], 0);
    const gap = (last[k] + last[s] - first[k] - total) / (items.length - 1);
    let pos = first[k] + first[s] + gap;
    for (let i = 1; i < items.length - 1; i++) {
      const o = items[i];
      const d = pos - o.b[k];
      applyDocX([o.it], new DOMMatrix().translate(axis === 'h' ? d : 0, axis === 'h' ? 0 : d));
      pos += o.b[s] + gap;
    }
    ed.commit();
  };

  /* ================= structure ops ================= */
  const uniqueIds = (root) => {
    for (const e of [root, ...root.querySelectorAll('[id]')]) {
      const id = e.getAttribute && e.getAttribute('id');
      if (id && ed.doc.querySelector('#' + CSS.escape(id))) e.setAttribute('id', id + '-' + Math.random().toString(36).slice(2, 5));
    }
  };
  ed.deleteSel = () => {
    if (ed.node) return ed.nodeDelete();
    if (!ed.sel.length) return;
    ed.sel.forEach((e) => e.remove());
    ed.sel = [];
    ed.emit('select');
    ed.commit();
  };
  ed.duplicate = (offset = 10) => {
    if (!ed.sel.length) return;
    const clones = ed.sel.map((e) => {
      const c = e.cloneNode(true);
      uniqueIds(c);
      e.parentNode.insertBefore(c, e.nextSibling);
      return c;
    });
    ed.sel = clones;
    if (offset) applyDocX(beginXform(clones), new DOMMatrix().translate(offset, offset));
    ed.emit('select');
    ed.commit();
  };
  ed.copy = (cut) => {
    if (!ed.sel.length) return;
    const ordered = ed.sel.slice().sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    // copy with transforms flattened into document space so paste lands in the same place anywhere
    ed.clipboard = ordered.map((e) => {
      const c = e.cloneNode(true);
      const m = ed.localToDoc(e) || V.elTransform(e);
      V.setTransform(c, m);
      return V.serialize(c, false).replace(/^<(\w+) xmlns="[^"]+"/, '<$1');
    });
    ed.pasteCount = 0;
    const snippet = `<svg xmlns="${NS}" xmlns:xlink="${V.XLINK}">${ed.clipboard.join('')}</svg>`;
    try { navigator.clipboard && navigator.clipboard.writeText(snippet).catch(() => {}); } catch (e) {}
    ed._lastCopiedText = snippet;
    if (cut) ed.deleteSel();
  };
  ed.pasteInternal = () => {
    if (!ed.clipboard) return false;
    ed.pasteCount++;
    ed.importSnippet(`<svg xmlns="${NS}" xmlns:xlink="${V.XLINK}">${ed.clipboard.join('')}</svg>`, ed.pasteCount * 10, true);
    return true;
  };
  /* Insert SVG markup's children into the current context (as-is, or wrapped in a group). */
  ed.importSnippet = (text, offset = 0, flat = false) => {
    const { svg, warnings } = V.parseSvgText(text);
    const vb = V.svg2pdf.parseViewBox(svg);
    const ctxInv = (ed.localToDoc(ed.ctx) || new DOMMatrix()).inverse();
    const added = [];
    // Copy defs/styles so references keep working.
    if (flat) {
      for (const k of Array.from(svg.children)) {
        uniqueIds(k);
        ed.ctx.appendChild(k);
        V.setTransform(k, ctxInv.multiply(V.elTransform(k)));
        added.push(k);
      }
    } else {
      const g = svgEl('g');
      for (const k of Array.from(svg.children)) g.appendChild(k);
      uniqueIds(g);
      const w = V.toPx(svg.getAttribute('width'), vb ? vb[2] : 100), h = V.toPx(svg.getAttribute('height'), vb ? vb[3] : 100);
      const m = V.svg2pdf.viewBoxMatrix(vb, w, h, svg.getAttribute('preserveAspectRatio'));
      ed.ctx.appendChild(g);
      V.setTransform(g, ctxInv.multiply(m));
      added.push(g);
    }
    if (offset) applyDocX(beginXform(added), new DOMMatrix().translate(offset, offset));
    ed.sel = added;
    ed.emit('select');
    ed.commit();
    return warnings;
  };
  ed.insertImage = async (file, at) => {
    const url = await V.readAs(file, 'dataurl');
    const img = await V.loadImage(url);
    const vb = ed.vb();
    let w = img.naturalWidth || 300, h = img.naturalHeight || 150;
    const max = Math.min(vb[2], vb[3]) * 0.8;
    if (Math.max(w, h) > max) { const k = max / Math.max(w, h); w *= k; h *= k; }
    const c = at || { x: vb[0] + vb[2] / 2 - w / 2, y: vb[1] + vb[3] / 2 - h / 2 };
    const el = svgEl('image', { x: fmt(c.x), y: fmt(c.y), width: fmt(w), height: fmt(h), href: url, preserveAspectRatio: 'xMidYMid meet' });
    ed.ctx.appendChild(el);
    const ctxInv = (ed.localToDoc(ed.ctx) || new DOMMatrix()).inverse();
    if (!V.mIsIdentity(ctxInv)) { V.setTransform(el, ctxInv); ed.bake(el); }
    ed.select([el]);
    ed.commit();
  };

  ed.group = () => {
    if (!ed.sel.length) return;
    const ordered = ed.sel.slice().sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const parent = ordered[ordered.length - 1].parentNode;
    const g = svgEl('g');
    parent.insertBefore(g, ordered[ordered.length - 1].nextSibling);
    const gInv = (ed.localToDoc(g) || new DOMMatrix()).inverse();
    for (const e of ordered) {
      const m = ed.localToDoc(e);
      g.appendChild(e);
      if (m) { V.setTransform(e, gInv.multiply(m)); ed.bake(e); }
    }
    ed.select([g]);
    ed.commit();
  };
  const INHERIT = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'fill-opacity', 'stroke-opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'fill-rule', 'color'];
  ed.ungroup = () => {
    const groups = ed.sel.filter((e) => e.localName === 'g');
    if (!groups.length) return;
    const out = [];
    for (const g of groups) {
      const parent = g.parentNode;
      const gm = V.elTransform(g);
      const gop = parseFloat(g.getAttribute('opacity'));
      for (const k of Array.from(g.children)) {
        if (k.nodeType !== 1) continue;
        parent.insertBefore(k, g);
        V.setTransform(k, gm.multiply(V.elTransform(k)));
        for (const a of INHERIT) if (g.hasAttribute(a) && !k.hasAttribute(a)) k.setAttribute(a, g.getAttribute(a));
        if (isFinite(gop) && gop < 1) k.setAttribute('opacity', fmt(gop * (parseFloat(k.getAttribute('opacity')) || 1), 3));
        if (g.getAttribute('style') && !k.getAttribute('style')) k.setAttribute('style', g.getAttribute('style'));
        if (g.getAttribute('class')) k.setAttribute('class', ((k.getAttribute('class') || '') + ' ' + g.getAttribute('class')).trim());
        ed.bake(k);
        out.push(k);
      }
      g.remove();
    }
    ed.select(out);
    ed.commit();
  };
  ed.order = (how) => {
    if (!ed.sel.length) return;
    const els = ed.sel.slice().sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const isShape = (n) => n && n.nodeType === 1 && SHAPES.has(n.localName);
    const nextShape = (n) => { let s = n.nextElementSibling; while (s && !isShape(s)) s = s.nextElementSibling; return s; };
    const prevShape = (n) => { let s = n.previousElementSibling; while (s && !isShape(s)) s = s.previousElementSibling; return s; };
    if (how === 'front') els.forEach((e) => e.parentNode.appendChild(e));
    else if (how === 'back') els.slice().reverse().forEach((e) => { const p = e.parentNode; let f = p.firstElementChild; while (f && !isShape(f)) f = f.nextElementSibling; if (f !== e) p.insertBefore(e, f); });
    else if (how === 'forward') els.slice().reverse().forEach((e) => { const n = nextShape(e); if (n && !ed.sel.includes(n)) e.parentNode.insertBefore(e, n.nextSibling); });
    else if (how === 'backward') els.forEach((e) => { const p = prevShape(e); if (p && !ed.sel.includes(p)) e.parentNode.insertBefore(e, p); });
    ed.emit('select');
    ed.commit();
  };
  ed.toPath = () => {
    const out = [];
    let changed = false;
    for (const el of ed.sel) {
      if (!['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(el.localName)) { out.push(el); continue; }
      const segs = V.Path.fromElement(el);
      const p = svgEl('path', { d: V.Path.serialize(segs) });
      const skip = new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points']);
      for (const a of el.attributes) if (!skip.has(a.name)) p.setAttribute(a.name, a.value);
      if (el.localName === 'line' || el.localName === 'polyline') { if (!p.hasAttribute('fill')) p.setAttribute('fill', 'none'); }
      el.parentNode.replaceChild(p, el);
      out.push(p);
      changed = true;
    }
    if (!changed) { V.toast('Select a rectangle, ellipse, line or polygon to convert'); return; }
    ed.select(out);
    ed.commit();
  };

  ed.toggleLock = (el) => { if (el.hasAttribute(LOCK)) el.removeAttribute(LOCK); else el.setAttribute(LOCK, ''); if (ed.sel.includes(el)) ed.select(ed.sel.filter((e) => e !== el)); ed.commit(); };
  ed.toggleHidden = (el) => {
    if (el.getAttribute('display') === 'none') el.removeAttribute('display'); else el.setAttribute('display', 'none');
    ed.commit();
  };

  /* ================= text helpers ================= */
  ed.getTextLines = (el) => {
    const kids = Array.from(el.childNodes).filter((k) => !(k.nodeType === 3 && !k.data.trim()));
    const lines = kids.filter((k) => k.nodeType === 1 && k.localName === 'tspan' && k.hasAttribute('x'));
    if (lines.length > 1 && lines.length === kids.length) return lines.map((t) => t.textContent).join('\n');
    return el.textContent;
  };
  ed.setTextLines = (el, text) => {
    const lines = String(text).split('\n');
    el.textContent = '';
    if (lines.length === 1) { el.textContent = lines[0]; return; }
    const x = el.getAttribute('x') || '0';
    lines.forEach((ln, i) => {
      const t = svgEl('tspan', { x, dy: i ? '1.2em' : null }, el);
      t.textContent = ln || ' ';
    });
  };

  /* ================= style helpers ================= */
  ed.newStyle = (closed = true) => {
    const o = ed.opts;
    const a = {};
    a.fill = closed && o.fillOn !== false ? ed.defFill : 'none';
    if (o.strokeOn || !closed || a.fill === 'none') { a.stroke = ed.defStroke; a['stroke-width'] = o.strokeWidth; }
    return a;
  };

  /* ================= overlay ================= */
  let raf = 0;
  ed.redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawOverlay(); }); };
  let hoverEl = null;
  ed.redrawNow = () => drawOverlay();

  const drawOverlay = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!overlay || !ed.doc) return;
    overlay.textContent = '';
    if (ed.ctx && ed.ctx !== ed.doc && ed.doc.contains(ed.ctx)) {
      const b = ed.docBBox(ed.ctx);
      if (b) drawDocRect(b, 'ctxbox', 6);
    }
    if (hoverEl && !ed.sel.includes(hoverEl) && ed.doc.contains(hoverEl) && ed.tool === 'select' && !drag) {
      drawOriented(hoverEl, 'hoverbox');
    }
    if (ed.node) { drawNodes(); return; }
    if (penState) drawPen();
    if (!ed.sel.length) { drawMarquee(); return; }
    const toV = ed.docToView();
    if (ed.sel.length === 1) {
      const el = ed.sel[0];
      if (el.localName === 'line' && ed.tool === 'select') {
        const m = ed.localToView(el);
        if (!m) return;
        const n = (a) => parseFloat(el.getAttribute(a)) || 0;
        const p1 = V.apply(m, n('x1'), n('y1')), p2 = V.apply(m, n('x2'), n('y2'));
        svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'bbox' }, overlay);
        handle(p1.x, p1.y, 'p1', 'move');
        handle(p2.x, p2.y, 'p2', 'move');
        return;
      }
      const box = orientedBox(el);
      if (!box) return;
      svgEl('polygon', { points: box.pts.map((p) => p.x + ',' + p.y).join(' '), class: 'bbox' }, overlay);
      if (ed.tool === 'select') drawHandles(box);
    } else {
      for (const el of ed.sel) drawOriented(el, 'hoverbox');
      const b = ed.unionBBox(ed.sel);
      if (!b) return;
      const p1 = V.apply(toV, b.x, b.y), p2 = V.apply(toV, b.x + b.width, b.y + b.height);
      const pts = [p1, { x: p2.x, y: p1.y }, p2, { x: p1.x, y: p2.y }];
      svgEl('polygon', { points: pts.map((p) => p.x + ',' + p.y).join(' '), class: 'bbox' }, overlay);
      if (ed.tool === 'select') drawHandles({ pts, axisAligned: true });
    }
    drawMarquee();
  };
  const drawDocRect = (b, cls, pad = 0) => {
    const toV = ed.docToView();
    const p1 = V.apply(toV, b.x, b.y), p2 = V.apply(toV, b.x + b.width, b.y + b.height);
    svgEl('rect', { x: Math.min(p1.x, p2.x) - pad, y: Math.min(p1.y, p2.y) - pad, width: Math.abs(p2.x - p1.x) + pad * 2, height: Math.abs(p2.y - p1.y) + pad * 2, class: cls }, overlay);
  };
  const orientedBox = (el) => {
    let b;
    try { b = el.getBBox(); } catch (e) { return null; }
    const m = ed.localToView(el);
    if (!m) return null;
    const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]].map(([x, y]) => V.apply(m, x, y));
    return { pts, b, m };
  };
  const drawOriented = (el, cls) => {
    const box = orientedBox(el);
    if (box) svgEl('polygon', { points: box.pts.map((p) => p.x + ',' + p.y).join(' '), class: cls }, overlay);
  };
  const HS = 8;
  const handle = (x, y, id, cursor) => {
    svgEl('rect', { x: x - HS / 2, y: y - HS / 2, width: HS, height: HS, class: 'handle', 'data-h': id, style: `cursor:${cursor}` }, overlay);
  };
  const CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];
  const drawHandles = (box) => {
    const [a, b, c, d] = box.pts;
    const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    const hs = [['nw', a], ['n', mid(a, b)], ['ne', b], ['e', mid(b, c)], ['se', c], ['s', mid(c, d)], ['sw', d], ['w', mid(d, a)]];
    const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    const base = { nw: 0, n: 1, ne: 2, e: 3, se: 0, s: 1, sw: 2, w: 3 };
    const w = Math.hypot(b.x - a.x, b.y - a.y), h = Math.hypot(d.x - a.x, d.y - a.y);
    for (const [id, p] of hs) {
      if ((id === 'n' || id === 's') && w < 24) continue;
      if ((id === 'e' || id === 'w') && h < 24) continue;
      const idx = (base[id] + Math.round(((ang % 180) + 180) / 45)) % 4;
      handle(p.x, p.y, id, CURSORS[idx]);
    }
    // rotation handle above the top edge
    const tm = mid(a, b);
    let nx = d.x - a.x, ny = d.y - a.y;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    const rp = { x: tm.x - nx * 24, y: tm.y - ny * 24 };
    svgEl('line', { x1: tm.x, y1: tm.y, x2: rp.x, y2: rp.y, class: 'rotline' }, overlay);
    svgEl('circle', { cx: rp.x, cy: rp.y, r: 5, class: 'handle rot', 'data-h': 'rot' }, overlay);
  };
  let marqueeRect = null;
  const drawMarquee = () => {
    if (!marqueeRect) return;
    const r = marqueeRect;
    svgEl('rect', { x: Math.min(r.x1, r.x2), y: Math.min(r.y1, r.y2), width: Math.abs(r.x2 - r.x1), height: Math.abs(r.y2 - r.y1), class: 'marquee' }, overlay);
  };

  /* ================= node editing ================= */
  ed.enterNodeMode = (el) => {
    if (!el) return;
    if (el.localName !== 'path') {
      if (['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(el.localName)) {
        ed.select([el]);
        ed.toPath();
        el = ed.sel[0];
        V.toast('Converted to a path for node editing');
      } else { V.toast('Node editing works on paths and basic shapes'); return; }
    }
    ed.sel = [el];
    ed.node = { el, segs: V.Path.parse(el.getAttribute('d')), selNodes: new Set() };
    ed.setTool('node', true);
    ed.emit('select');
    ed.redraw();
  };
  ed.exitNodeMode = (silent) => {
    if (!ed.node) return;
    ed.node = null;
    if (!silent && ed.tool === 'node') ed.setTool('select', true);
    ed.redraw();
  };
  const nodeWrite = () => {
    ed.node.el.setAttribute('d', V.Path.serialize(ed.node.segs));
  };
  /* Anchor info: for each segment index with an endpoint, prev index for control handles. */
  const nodeList = () => {
    const segs = ed.node.segs;
    const list = [];
    let start = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.c === 'M') start = i;
      if (s.c === 'Z') continue;
      const e = V.Path.endPoint(s);
      list.push({ i, x: e[0], y: e[1], start });
    }
    return list;
  };
  const prevEnd = (segs, i) => {
    for (let k = i - 1; k >= 0; k--) {
      if (segs[k].c === 'Z') { // back to subpath start
        for (let j = k - 1; j >= 0; j--) if (segs[j].c === 'M') return V.Path.endPoint(segs[j]);
      }
      const e = V.Path.endPoint(segs[k]);
      if (e) return e;
    }
    return [0, 0];
  };
  const drawNodes = () => {
    const nd = ed.node;
    const el = nd.el;
    if (!ed.doc.contains(el)) { ed.node = null; return; }
    const m = ed.localToView(el);
    if (!m) return;
    const segs = nd.segs;
    const outline = svgEl('path', { d: V.Path.serialize(V.Path.transform(segs, m)), class: 'pathoutline' }, overlay);
    void outline;
    const P = (x, y) => V.apply(m, x, y);
    // control handles
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.c !== 'C' && s.c !== 'Q') continue;
      const pe = prevEnd(segs, i);
      const a = P(pe[0], pe[1]);
      const end = V.Path.endPoint(s);
      const e = P(end[0], end[1]);
      if (s.c === 'C') {
        const c1 = P(s.p[0], s.p[1]), c2 = P(s.p[2], s.p[3]);
        svgEl('line', { x1: a.x, y1: a.y, x2: c1.x, y2: c1.y, class: 'ctrlline' }, overlay);
        svgEl('line', { x1: e.x, y1: e.y, x2: c2.x, y2: c2.y, class: 'ctrlline' }, overlay);
        svgEl('circle', { cx: c1.x, cy: c1.y, r: 3.5, class: 'ctrl', 'data-c': i + ':0' }, overlay);
        svgEl('circle', { cx: c2.x, cy: c2.y, r: 3.5, class: 'ctrl', 'data-c': i + ':2' }, overlay);
      } else {
        const c = P(s.p[0], s.p[1]);
        svgEl('line', { x1: a.x, y1: a.y, x2: c.x, y2: c.y, class: 'ctrlline' }, overlay);
        svgEl('line', { x1: e.x, y1: e.y, x2: c.x, y2: c.y, class: 'ctrlline' }, overlay);
        svgEl('circle', { cx: c.x, cy: c.y, r: 3.5, class: 'ctrl', 'data-c': i + ':0' }, overlay);
      }
    }
    for (const n of nodeList()) {
      const p = P(n.x, n.y);
      const cls = 'node' + (nd.selNodes.has(n.i) ? ' sel' : '') + (segs[n.i].c === 'M' ? ' first' : '');
      svgEl('rect', { x: p.x - 4, y: p.y - 4, width: 8, height: 8, class: cls, 'data-n': n.i }, overlay);
    }
    drawMarquee();
  };
  /* Move anchor i by (dx,dy) in local coords including attached control points. */
  const moveAnchor = (segs, i, dx, dy) => {
    const s = segs[i];
    const mv = (arr, k) => { arr[k] += dx; arr[k + 1] += dy; };
    if (s.c === 'M' || s.c === 'L') mv(s.p, 0);
    else if (s.c === 'C') { mv(s.p, 4); mv(s.p, 2); }
    else if (s.c === 'Q') mv(s.p, 2);
    else if (s.c === 'A') mv(s.p, 5);
    // outgoing control of next segment
    let nxt = segs[i + 1];
    if (nxt && nxt.c === 'C') mv(nxt.p, 0);
    // closed subpath: M point coincides with last point -> keep together
    if (s.c === 'M') {
      let j = i + 1;
      while (j < segs.length && segs[j].c !== 'M' && segs[j].c !== 'Z') j++;
      if (j < segs.length && segs[j].c === 'Z') {
        const last = segs[j - 1];
        const le = V.Path.endPoint(last);
        if (le && Math.abs(le[0] - (s.p[0] - dx)) < 1e-6 && Math.abs(le[1] - (s.p[1] - dy)) < 1e-6 && j - 1 !== i) {
          if (last.c === 'C') { mv(last.p, 4); mv(last.p, 2); } else if (last.c === 'Q') mv(last.p, 2); else if (last.c === 'L') mv(last.p, 0); else if (last.c === 'A') mv(last.p, 5);
        }
      }
    }
  };
  ed.nodeNudge = (dx, dy) => {
    const nd = ed.node;
    if (!nd.selNodes.size) return;
    const m = ed.localToDoc(nd.el).inverse();
    const o = V.apply(m, 0, 0), q = V.apply(m, dx, dy);
    for (const i of nd.selNodes) moveAnchor(nd.segs, i, q.x - o.x, q.y - o.y);
    nodeWrite();
    ed.commit();
  };
  ed.nodeDelete = () => {
    const nd = ed.node;
    if (!nd || !nd.selNodes.size) return;
    const idx = Array.from(nd.selNodes).sort((a, b) => b - a);
    for (const i of idx) {
      const s = nd.segs[i];
      if (s.c === 'M') {
        const nxt = nd.segs[i + 1];
        if (nxt && nxt.c !== 'M' && nxt.c !== 'Z') { const e = V.Path.endPoint(nxt); nd.segs.splice(i, 2, { c: 'M', p: e }); }
        else nd.segs.splice(i, 1);
      } else {
        const nxt = nd.segs[i + 1];
        if (nxt && nxt.c === 'C' && s.c === 'C') nxt.p[0] = s.p[0], nxt.p[1] = s.p[1];
        nd.segs.splice(i, 1);
      }
    }
    // tidy: drop subpaths that became empty
    nd.segs = nd.segs.filter((s, i, a) => !(s.c === 'M' && (!a[i + 1] || a[i + 1].c === 'M')) && !(s.c === 'Z' && (i === 0 || a[i - 1].c === 'Z' || a[i - 1].c === 'M')));
    nd.selNodes.clear();
    if (!nd.segs.length) { const el = nd.el; ed.exitNodeMode(); el.remove(); ed.sel = []; ed.emit('select'); ed.commit(); return; }
    nodeWrite();
    ed.commit();
  };
  const splitSeg = (i, t = 0.5) => {
    const segs = ed.node.segs;
    const s = segs[i];
    const pe = prevEnd(segs, i);
    if (s.c === 'L') {
      const mx = pe[0] + (s.p[0] - pe[0]) * t, my = pe[1] + (s.p[1] - pe[1]) * t;
      segs.splice(i, 0, { c: 'L', p: [mx, my] });
    } else if (s.c === 'C') {
      const [a, b] = V.Path.splitCubic(pe[0], pe[1], s.p, t);
      segs.splice(i, 1, { c: 'C', p: a }, { c: 'C', p: b });
    } else if (s.c === 'Q') {
      const [a, b] = V.Path.splitQuad(pe[0], pe[1], s.p, t);
      segs.splice(i, 1, { c: 'Q', p: a }, { c: 'Q', p: b });
    } else if (s.c === 'Z') {
      // closing segment: insert an explicit line point
      let st = i - 1; while (st >= 0 && segs[st].c !== 'M') st--;
      const sp = segs[st].p;
      segs.splice(i, 0, { c: 'L', p: [pe[0] + (sp[0] - pe[0]) * t, pe[1] + (sp[1] - pe[1]) * t] });
    } else return false;
    return true;
  };
  ed.nodeAdd = () => {
    const nd = ed.node;
    if (!nd) return;
    const targets = nd.selNodes.size ? Array.from(nd.selNodes).sort((a, b) => b - a) : null;
    if (!targets) { V.toast('Select a node first — a new node is added after it (or double-click the path)'); return; }
    for (const i of targets) { const nx = i + 1; if (nd.segs[nx] && nd.segs[nx].c !== 'M') splitSeg(nx); }
    nd.selNodes.clear();
    nodeWrite(); ed.commit();
  };
  ed.nodeType = (kind) => {
    const nd = ed.node;
    if (!nd || !nd.selNodes.size) { V.toast('Select one or more nodes first'); return; }
    for (const i of nd.selNodes) {
      const s = nd.segs[i];
      const pe = prevEnd(nd.segs, i);
      const e = V.Path.endPoint(s);
      if (kind === 'curve' && s.c === 'L') {
        nd.segs[i] = { c: 'C', p: [pe[0] + (e[0] - pe[0]) / 3, pe[1] + (e[1] - pe[1]) / 3, pe[0] + 2 * (e[0] - pe[0]) / 3, pe[1] + 2 * (e[1] - pe[1]) / 3, e[0], e[1]] };
      } else if (kind === 'line' && (s.c === 'C' || s.c === 'Q' || s.c === 'A')) {
        nd.segs[i] = { c: 'L', p: [e[0], e[1]] };
      } else if (kind === 'smooth') {
        // make handles around this anchor collinear
        const nxt = nd.segs[i + 1];
        if (s.c === 'C' && nxt && nxt.c === 'C') {
          const ix = s.p[2] - e[0], iy = s.p[3] - e[1], ox = nxt.p[0] - e[0], oy = nxt.p[1] - e[1];
          const il = Math.hypot(ix, iy), ol = Math.hypot(ox, oy);
          const ang = Math.atan2(oy - iy, ox - ix);
          nxt.p[0] = e[0] + Math.cos(ang) * ol; nxt.p[1] = e[1] + Math.sin(ang) * ol;
          s.p[2] = e[0] - Math.cos(ang) * il; s.p[3] = e[1] - Math.sin(ang) * il;
        }
      }
    }
    nodeWrite(); ed.commit();
  };
  ed.nodeToggleClose = () => {
    const nd = ed.node; if (!nd) return;
    const i = nd.selNodes.size ? Math.min(...nd.selNodes) : 0;
    let st = i; while (st > 0 && nd.segs[st].c !== 'M') st--;
    let j = st + 1; while (j < nd.segs.length && nd.segs[j].c !== 'M' && nd.segs[j].c !== 'Z') j++;
    if (nd.segs[j] && nd.segs[j].c === 'Z') nd.segs.splice(j, 1); else nd.segs.splice(j, 0, { c: 'Z', p: [] });
    nodeWrite(); ed.commit();
  };
  const nearestOnPath = (lx, ly) => {
    const segs = ed.node.segs;
    let best = { d: Infinity };
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.c === 'M' || s.c === 'A') continue;
      const pe = prevEnd(segs, i);
      let st = i; while (st > 0 && segs[st].c !== 'M') st--;
      for (let k = 1; k < 24; k++) {
        const t = k / 24;
        let x, y;
        if (s.c === 'L' || s.c === 'Z') { const e = s.c === 'Z' ? segs[st].p : s.p; x = pe[0] + (e[0] - pe[0]) * t; y = pe[1] + (e[1] - pe[1]) * t; }
        else if (s.c === 'C') { const mt = 1 - t; x = mt ** 3 * pe[0] + 3 * mt * mt * t * s.p[0] + 3 * mt * t * t * s.p[2] + t ** 3 * s.p[4]; y = mt ** 3 * pe[1] + 3 * mt * mt * t * s.p[1] + 3 * mt * t * t * s.p[3] + t ** 3 * s.p[5]; }
        else { const mt = 1 - t; x = mt * mt * pe[0] + 2 * mt * t * s.p[0] + t * t * s.p[2]; y = mt * mt * pe[1] + 2 * mt * t * s.p[1] + t * t * s.p[3]; }
        const d = Math.hypot(x - lx, y - ly);
        if (d < best.d) best = { d, i, t };
      }
    }
    return best;
  };

  /* ================= tools ================= */
  ed.setTool = (t, keepNode) => {
    if (penState && t !== 'pen') finishPen();
    if (!keepNode && ed.node && t !== 'node') ed.exitNodeMode(true);
    if (t === 'node' && !ed.node) {
      const el = ed.sel.length === 1 ? ed.sel[0] : null;
      ed.tool = 'node';
      if (el) { ed.enterNodeMode(el); return; }
    }
    ed.tool = t;
    stage.dataset.tool = t;
    hoverEl = null;
    ed.emit('tool');
    ed.redraw();
  };

  let drag = null; // active pointer interaction
  let penState = null;
  let spaceDown = false;

  const createEl = (tag, attrs) => {
    const el = svgEl(tag, attrs);
    ed.ctx.appendChild(el);
    return el;
  };
  const ctxLocal = (e) => {
    let d = ed.clientToDoc(e.clientX, e.clientY);
    d = ed.snapPt(d);
    const m = (ed.localToDoc(ed.ctx) || new DOMMatrix()).inverse();
    return V.apply(m, d.x, d.y);
  };

  const shapeAttrs = (tool, a, b, e) => {
    let x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
    if (e.shiftKey && tool !== 'line') {
      const s = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
      x2 = x1 + Math.sign(x2 - x1 || 1) * s; y2 = y1 + Math.sign(y2 - y1 || 1) * s;
    }
    if (e.altKey && tool !== 'line') { x1 = a.x - (x2 - a.x); y1 = a.y - (y2 - a.y); }
    const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    switch (tool) {
      case 'rect': return { x: fmt(x), y: fmt(y), width: fmt(w), height: fmt(h), rx: ed.opts.radius ? fmt(Math.min(ed.opts.radius, w / 2, h / 2)) : null };
      case 'ellipse': return { cx: fmt(x + w / 2), cy: fmt(y + h / 2), rx: fmt(w / 2), ry: fmt(h / 2) };
      case 'line': {
        if (e.shiftKey) {
          const ang = Math.round(Math.atan2(y2 - y1, x2 - x1) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(x2 - x1, y2 - y1);
          x2 = x1 + Math.cos(ang) * len; y2 = y1 + Math.sin(ang) * len;
        }
        return { x1: fmt(x1), y1: fmt(y1), x2: fmt(x2), y2: fmt(y2) };
      }
      case 'polygon': return { points: V.Path.pointsToString(V.Path.polygonPoints(x + w / 2, y + h / 2, w / 2, h / 2, V.clamp(ed.opts.sides | 0, 3, 64))) };
      case 'star': return { points: V.Path.pointsToString(V.Path.starPoints(x + w / 2, y + h / 2, w / 2, h / 2, V.clamp(ed.opts.points | 0, 3, 64), V.clamp(+ed.opts.inner || 0.5, 0.05, 0.95))) };
    }
    return {};
  };

  /* ---------- pen ---------- */
  const penPathD = (pts, closed, extra) => {
    const all = extra ? pts.concat([extra]) : pts;
    if (!all.length) return '';
    const segs = [{ c: 'M', p: [all[0].x, all[0].y] }];
    const seg = (p, q) => {
      if (p.cout || q.cin) segs.push({ c: 'C', p: [(p.cout || p).x, (p.cout || p).y, (q.cin || q).x, (q.cin || q).y, q.x, q.y] });
      else segs.push({ c: 'L', p: [q.x, q.y] });
    };
    for (let i = 1; i < all.length; i++) seg(all[i - 1], all[i]);
    if (closed) { seg(all[all.length - 1], all[0]); segs.push({ c: 'Z', p: [] }); }
    return segs;
  };
  const drawPen = () => {
    const m = ed.localToView(ed.ctx);
    if (!m || !penState.pts.length) return;
    const segs = penPathD(penState.pts, false, penState.hover);
    svgEl('path', { d: V.Path.serialize(V.Path.transform(segs, m)), class: 'penpreview' }, overlay);
    penState.pts.forEach((p, i) => {
      const q = V.apply(m, p.x, p.y);
      svgEl('rect', { x: q.x - 4, y: q.y - 4, width: 8, height: 8, class: 'node' + (i === 0 ? ' first' : '') }, overlay);
      for (const c of [p.cin, p.cout]) {
        if (!c) continue;
        const cq = V.apply(m, c.x, c.y);
        svgEl('line', { x1: q.x, y1: q.y, x2: cq.x, y2: cq.y, class: 'ctrlline' }, overlay);
        svgEl('circle', { cx: cq.x, cy: cq.y, r: 3, class: 'ctrl' }, overlay);
      }
    });
  };
  const finishPen = (closed) => {
    const st = penState;
    penState = null;
    if (!st || st.pts.length < 2) { ed.redraw(); return; }
    const segs = penPathD(st.pts, closed);
    const el = createEl('path', Object.assign({ d: V.Path.serialize(segs) }, ed.newStyle(!!closed)));
    ed.select([el]);
    ed.commit();
  };
  ed.finishPen = finishPen;
  ed.penActive = () => !!penState;

  /* ---------- pointer handling ---------- */
  const onDown = (e) => {
    if (e.button === 1 || (e.button === 0 && (spaceDown || ed.tool === 'hand'))) {
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: ed.panX, py: ed.panY };
      stage.classList.add('panning');
      try { view.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    stage.focus({ preventScroll: true });
    const target = e.target;
    const vp = ed.clientToView(e.clientX, e.clientY);
    const t = ed.tool;
    try { view.setPointerCapture(e.pointerId); } catch (err) {}

    if (t === 'node' && ed.node) return nodeDown(e, target, vp);

    if (t === 'select') {
      const h = target.getAttribute && target.getAttribute('data-h');
      if (h) return startHandleDrag(e, h);
      const el = ed.pick(target);
      if (el) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) { ed.select([el], true); if (!ed.sel.includes(el)) return; }
        else if (!ed.sel.includes(el)) ed.select([el]);
        drag = { kind: 'move', sd: ed.clientToDoc(e.clientX, e.clientY), items: null, alt: e.altKey, moved: false, bbox0: ed.unionBBox(ed.sel) };
        return;
      }
      // empty: marquee
      if (!(e.shiftKey || e.ctrlKey)) ed.select([]);
      drag = { kind: 'marquee', add: e.shiftKey || e.ctrlKey };
      marqueeRect = { x1: vp.x, y1: vp.y, x2: vp.x, y2: vp.y };
      return;
    }
    if (t === 'eyedrop') {
      const el = ed.pick(target) || (target !== ed.doc && ed.doc.contains(target) ? target : null);
      if (el) {
        const cs = getComputedStyle(el);
        const fill = el.getAttribute('fill') || cs.fill, stroke = el.getAttribute('stroke') || cs.stroke;
        if (ed.sel.length && !ed.sel.includes(el)) {
          for (const s of ed.sel) {
            s.setAttribute('fill', fill);
            if (stroke && stroke !== 'none') { s.setAttribute('stroke', stroke); s.setAttribute('stroke-width', el.getAttribute('stroke-width') || cs.strokeWidth.replace('px', '')); } else s.removeAttribute('stroke');
          }
          ed.commit();
          V.toast('Style applied to selection');
        } else {
          const f = V.toHex(cs.fill), s = V.toHex(cs.stroke);
          if (f) ed.defFill = f;
          if (s) ed.defStroke = s;
          ed.emit('defaults');
          V.toast('Picked colours for new shapes');
        }
      }
      return;
    }
    if (t === 'text') {
      const hit = ed.pick(target);
      if (hit && hit.localName === 'text') { ed.select([hit]); ed.emit('edit-text', hit); return; }
      const p = ctxLocal(e);
      const el = createEl('text', { x: fmt(p.x), y: fmt(p.y), 'font-family': ed.opts.fontFamily, 'font-size': ed.opts.fontSize, fill: ed.defFill });
      el.textContent = 'Text';
      ed.select([el]);
      ed.commit();
      ed.emit('edit-text', el, true);
      return;
    }
    if (t === 'image') { ed.emit('pick-image', ctxLocal(e)); return; }
    if (t === 'pen') return penDown(e);
    if (t === 'pencil') {
      const p = ctxLocal(e);
      drag = { kind: 'pencil', pts: [[p.x, p.y]], el: createEl('path', Object.assign({ d: `M${fmt(p.x)} ${fmt(p.y)}` }, ed.newStyle(false), { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) };
      return;
    }
    if (['rect', 'ellipse', 'line', 'polygon', 'star'].includes(t)) {
      drag = { kind: 'create', tool: t, a: ctxLocal(e), el: null, sx: e.clientX, sy: e.clientY };
    }
  };

  const startHandleDrag = (e, h) => {
    const items = beginXform(ed.sel);
    const sd = ed.clientToDoc(e.clientX, e.clientY);
    if (h === 'p1' || h === 'p2') {
      drag = { kind: 'lineEnd', el: ed.sel[0], h, items };
      return;
    }
    if (h === 'rot') {
      let c;
      if (ed.sel.length === 1) {
        const el = ed.sel[0];
        const b = el.getBBox();
        c = V.apply(ed.localToDoc(el), b.x + b.width / 2, b.y + b.height / 2);
      } else {
        const b = ed.unionBBox(ed.sel);
        c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      drag = { kind: 'rotate', items, c, a0: Math.atan2(sd.y - c.y, sd.x - c.x) };
      return;
    }
    // resize
    if (ed.sel.length === 1) {
      const el = ed.sel[0];
      const b = el.getBBox();
      const inv = V.mOf(el.getScreenCTM()).inverse();
      drag = { kind: 'resize1', h, items, b, inv };
    } else {
      drag = { kind: 'resizeN', h, items, b: ed.unionBBox(ed.sel) };
    }
  };

  const handleScale = (h, b, p, e) => {
    // b: box {x,y,width,height}; p: pointer in same space. returns {sx,sy,ax,ay}
    const hx = h.includes('w') ? 0 : h.includes('e') ? 1 : 0.5;
    const hy = h.includes('n') ? 0 : h.includes('s') ? 1 : 0.5;
    let ax = b.x + (1 - hx) * b.width, ay = b.y + (1 - hy) * b.height;
    const hpx = b.x + hx * b.width, hpy = b.y + hy * b.height;
    if (e.altKey) { ax = b.x + b.width / 2; ay = b.y + b.height / 2; }
    let sx = hx === 0.5 ? 1 : (p.x - ax) / ((hpx - ax) || 1e-9);
    let sy = hy === 0.5 ? 1 : (p.y - ay) / ((hpy - ay) || 1e-9);
    if (e.shiftKey) {
      if (hx === 0.5) sx = Math.abs(sy) * Math.sign(sx || 1);
      else if (hy === 0.5) sy = Math.abs(sx) * Math.sign(sy || 1);
      else { const s = Math.max(Math.abs(sx), Math.abs(sy)); sx = s * Math.sign(sx || 1); sy = s * Math.sign(sy || 1); }
    }
    const lim = (v) => (Math.abs(v) < 1e-4 ? 1e-4 * Math.sign(v || 1) : v);
    return { sx: lim(sx), sy: lim(sy), ax, ay };
  };

  const onMove = (e) => {
    const d = ed.clientToDoc(e.clientX, e.clientY);
    ed.emit('cursor', d);
    if (!drag) {
      if (ed.tool === 'select') {
        const el = e.target.getAttribute && e.target.getAttribute('data-h') ? null : ed.pickNoCtx(e.target);
        if (el !== hoverEl) { hoverEl = el; ed.redraw(); }
      }
      if (penState) { penState.hover = ctxLocal(e); ed.redraw(); }
      return;
    }
    switch (drag.kind) {
      case 'pan':
        ed.panX = drag.px + (e.clientX - drag.sx);
        ed.panY = drag.py + (e.clientY - drag.sy);
        applyView();
        break;
      case 'marquee': {
        const vp = ed.clientToView(e.clientX, e.clientY);
        marqueeRect.x2 = vp.x; marqueeRect.y2 = vp.y;
        ed.redraw();
        break;
      }
      case 'move': {
        let dx = d.x - drag.sd.x, dy = d.y - drag.sd.y;
        if (!drag.moved && Math.hypot(dx, dy) * ed.zoom < 2) return;
        if (!drag.moved) {
          drag.moved = true;
          if (drag.alt) {
            const clones = ed.sel.map((el) => { const c = el.cloneNode(true); uniqueIds(c); el.parentNode.insertBefore(c, el.nextSibling); return c; });
            ed.sel = clones;
            ed.emit('select');
          }
          drag.items = beginXform(ed.sel);
        }
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (ed.snap && drag.bbox0) {
          dx = ed.snapV(drag.bbox0.x + dx) - drag.bbox0.x;
          dy = ed.snapV(drag.bbox0.y + dy) - drag.bbox0.y;
        }
        applyDocX(drag.items, new DOMMatrix().translate(dx, dy));
        ed.redraw();
        ed.emit('live');
        break;
      }
      case 'resize1': {
        const it = drag.items[0];
        const lp = V.apply(drag.inv, e.clientX, e.clientY);
        const { sx, sy, ax, ay } = handleScale(drag.h, drag.b, lp, e);
        applyLocalX(it, new DOMMatrix().translate(ax, ay).scale(sx, sy).translate(-ax, -ay));
        ed.redraw();
        ed.emit('live');
        break;
      }
      case 'resizeN': {
        const p = ed.snapPt(d);
        const { sx, sy, ax, ay } = handleScale(drag.h, drag.b, p, e);
        applyDocX(drag.items, new DOMMatrix().translate(ax, ay).scale(sx, sy).translate(-ax, -ay));
        ed.redraw();
        ed.emit('live');
        break;
      }
      case 'rotate': {
        let a = (Math.atan2(d.y - drag.c.y, d.x - drag.c.x) - drag.a0) * 180 / Math.PI;
        if (e.shiftKey) a = Math.round(a / 15) * 15;
        applyDocX(drag.items, new DOMMatrix().translate(drag.c.x, drag.c.y).rotate(a).translate(-drag.c.x, -drag.c.y));
        drag.angle = a;
        ed.redraw();
        ed.emit('live', { angle: a });
        break;
      }
      case 'lineEnd': {
        const el = drag.el;
        let p = ed.clientToLocal(el, e.clientX, e.clientY);
        if (ed.snap) { const dp = ed.snapPt(V.apply(ed.localToDoc(el), p.x, p.y)); p = V.apply(ed.localToDoc(el).inverse(), dp.x, dp.y); }
        const k = drag.h === 'p1' ? '1' : '2', o = drag.h === 'p1' ? '2' : '1';
        if (e.shiftKey) {
          const ox = parseFloat(el.getAttribute('x' + o)) || 0, oy = parseFloat(el.getAttribute('y' + o)) || 0;
          const ang = Math.round(Math.atan2(p.y - oy, p.x - ox) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(p.x - ox, p.y - oy);
          p = { x: ox + Math.cos(ang) * len, y: oy + Math.sin(ang) * len };
        }
        el.setAttribute('x' + k, fmt(p.x)); el.setAttribute('y' + k, fmt(p.y));
        ed.redraw();
        ed.emit('live');
        break;
      }
      case 'create': {
        if (!drag.el && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
        const b = ctxLocal(e);
        const attrs = shapeAttrs(drag.tool, drag.a, b, e);
        if (!drag.el) {
          const tag = drag.tool === 'star' ? 'polygon' : drag.tool;
          drag.el = createEl(tag, Object.assign({}, attrs, ed.newStyle(drag.tool !== 'line')));
        } else for (const k in attrs) { if (attrs[k] == null) drag.el.removeAttribute(k); else drag.el.setAttribute(k, attrs[k]); }
        ed.sel = [drag.el];
        ed.redraw();
        ed.emit('live');
        break;
      }
      case 'pencil': {
        const p = ctxLocal(e);
        const last = drag.pts[drag.pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) * ed.zoom < 1.5) return;
        drag.pts.push([p.x, p.y]);
        drag.el.setAttribute('d', 'M' + drag.pts.map((q) => fmt(q[0], 2) + ' ' + fmt(q[1], 2)).join('L'));
        break;
      }
      case 'pen': {
        const p = ctxLocal(e);
        const pt = drag.pt;
        if (Math.hypot(p.x - pt.x, p.y - pt.y) * ed.zoom > 2) {
          pt.cout = { x: p.x, y: p.y };
          pt.cin = { x: 2 * pt.x - p.x, y: 2 * pt.y - p.y };
          if (e.altKey) pt.cin = null;
        }
        ed.redraw();
        break;
      }
      case 'node': nodeMove(e); break;
      case 'nodeMarquee': {
        const vp = ed.clientToView(e.clientX, e.clientY);
        marqueeRect.x2 = vp.x; marqueeRect.y2 = vp.y;
        ed.redraw();
        break;
      }
    }
  };

  ed.pickNoCtx = (node) => {
    if (!node || !ed.doc.contains(node) || node === ed.doc) return null;
    let n = node;
    const ctx = ed.ctx.contains(node) && node !== ed.ctx ? ed.ctx : ed.doc;
    while (n.parentNode && n.parentNode !== ctx) n = n.parentNode;
    if (n.parentNode !== ctx || ed.isLocked(n)) return null;
    return n;
  };

  const onUp = (e) => {
    const dg = drag;
    drag = null;
    stage.classList.remove('panning');
    try { view.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!dg) return;
    switch (dg.kind) {
      case 'marquee': {
        const r = marqueeRect;
        marqueeRect = null;
        if (Math.abs(r.x2 - r.x1) < 3 && Math.abs(r.y2 - r.y1) < 3) { ed.redraw(); break; }
        const toDoc = ed.docToView().inverse();
        const a = V.apply(toDoc, Math.min(r.x1, r.x2), Math.min(r.y1, r.y2)), b = V.apply(toDoc, Math.max(r.x1, r.x2), Math.max(r.y1, r.y2));
        const hits = Array.from(ed.ctx.children).filter((el) => {
          if (!SHAPES.has(el.localName) || ed.isLocked(el)) return false;
          const bb = ed.docBBox(el);
          return bb && bb.x < b.x && bb.x + bb.width > a.x && bb.y < b.y && bb.y + bb.height > a.y;
        });
        ed.select(dg.add ? ed.sel.concat(hits.filter((h) => !ed.sel.includes(h))) : hits);
        break;
      }
      case 'move': if (dg.moved) ed.commit(); break;
      case 'resize1': case 'resizeN': case 'rotate': case 'lineEnd': ed.commit(); break;
      case 'create': {
        let el = dg.el;
        if (!el) {
          // click without drag: default size
          const s = 100 / (ed.zoom * (V.mDecompose(ed.localToDoc(ed.ctx) || new DOMMatrix()).sx || 1)) * Math.min(1, ed.zoom * 1);
          const size = Math.max(10, Math.round(s));
          const b = { x: dg.a.x + size, y: dg.a.y + (dg.tool === 'line' ? 0 : size) };
          const tag = dg.tool === 'star' ? 'polygon' : dg.tool;
          el = createEl(tag, Object.assign({}, shapeAttrs(dg.tool, dg.a, b, {}), ed.newStyle(dg.tool !== 'line')));
        }
        ed.select([el]);
        ed.commit();
        break;
      }
      case 'pencil': {
        const tol = 1.2 / (ed.zoom || 1);
        const pts = V.Path.simplify(dg.pts, tol);
        if (pts.length < 2) { dg.el.remove(); ed.redraw(); break; }
        const close = pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) * ed.zoom < 8;
        if (close) pts.pop();
        dg.el.setAttribute('d', V.Path.serialize(V.Path.smoothPath(pts, close), 2));
        ed.select([dg.el]);
        ed.commit();
        break;
      }
      case 'pen': ed.redraw(); break;
      case 'node': if (dg.moved) { ed.commit(); } ed.redraw(); break;
      case 'nodeMarquee': {
        const r = marqueeRect; marqueeRect = null;
        const m = ed.localToView(ed.node.el);
        const x1 = Math.min(r.x1, r.x2), x2 = Math.max(r.x1, r.x2), y1 = Math.min(r.y1, r.y2), y2 = Math.max(r.y1, r.y2);
        if (!dg.add) ed.node.selNodes.clear();
        for (const n of nodeList()) { const p = V.apply(m, n.x, n.y); if (p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) ed.node.selNodes.add(n.i); }
        ed.emit('nodesel');
        ed.redraw();
        break;
      }
    }
  };

  const penDown = (e) => {
    const p = ctxLocal(e);
    if (!penState) penState = { pts: [] };
    const st = penState;
    if (st.pts.length >= 2) {
      const m = ed.localToView(ed.ctx);
      const f = V.apply(m, st.pts[0].x, st.pts[0].y);
      const vp = ed.clientToView(e.clientX, e.clientY);
      if (Math.hypot(f.x - vp.x, f.y - vp.y) < 9) { finishPen(true); return; }
    }
    const pt = { x: p.x, y: p.y, cin: null, cout: null };
    st.pts.push(pt);
    drag = { kind: 'pen', pt };
    ed.redraw();
  };

  const nodeDown = (e, target, vp) => {
    const nd = ed.node;
    const ni = target.getAttribute && target.getAttribute('data-n');
    const ci = target.getAttribute && target.getAttribute('data-c');
    const inv = V.mOf(nd.el.getScreenCTM()).inverse();
    const lp = V.apply(inv, e.clientX, e.clientY);
    if (ni != null) {
      const i = +ni;
      if (e.shiftKey) { if (nd.selNodes.has(i)) nd.selNodes.delete(i); else nd.selNodes.add(i); }
      else if (!nd.selNodes.has(i)) { nd.selNodes.clear(); nd.selNodes.add(i); }
      drag = { kind: 'node', what: 'anchors', inv, last: lp, moved: false };
      ed.emit('nodesel');
      ed.redraw();
      return;
    }
    if (ci != null) {
      const [i, k] = ci.split(':').map(Number);
      // remember opposite handle for smooth behaviour
      const segs = nd.segs;
      let opp = null;
      if (segs[i].c === 'C') {
        if (k === 2 && segs[i + 1] && segs[i + 1].c === 'C') opp = { i: i + 1, k: 0, ax: segs[i].p[4], ay: segs[i].p[5] };
        if (k === 0) {
          const pe = prevEnd(segs, i);
          const pi = i - 1;
          if (segs[pi] && segs[pi].c === 'C') opp = { i: pi, k: 2, ax: pe[0], ay: pe[1] };
        }
        if (opp) {
          const s = segs[i], o = segs[opp.i];
          const a1 = Math.atan2(s.p[k + 1] - opp.ay, s.p[k] - opp.ax), a2 = Math.atan2(o.p[opp.k + 1] - opp.ay, o.p[opp.k] - opp.ax);
          let diff = Math.abs(((a1 - a2) * 180 / Math.PI) % 360);
          if (diff > 180) diff = 360 - diff;
          if (Math.abs(diff - 180) > 4) opp = null; // not smooth: leave alone
        }
      }
      drag = { kind: 'node', what: 'ctrl', i, k, opp, inv, moved: false };
      return;
    }
    // clicked on another element: switch target, or leave node mode
    const el = ed.pick(target);
    if (el && el !== nd.el) {
      if (['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(el.localName)) { ed.enterNodeMode(el); return; }
    }
    if (el === nd.el && e.detail >= 2) {
      // double-click on path: add node there
      const best = nearestOnPath(lp.x, lp.y);
      if (best.i != null && splitSeg(best.i, best.t)) { nodeWrite(); ed.commit(); }
      return;
    }
    if (!e.shiftKey) nd.selNodes.clear();
    drag = { kind: 'nodeMarquee', add: e.shiftKey };
    marqueeRect = { x1: vp.x, y1: vp.y, x2: vp.x, y2: vp.y };
    ed.emit('nodesel');
    ed.redraw();
  };
  const nodeMove = (e) => {
    const nd = ed.node;
    let lp = V.apply(drag.inv, e.clientX, e.clientY);
    if (ed.snap) {
      const toDoc = ed.localToDoc(nd.el);
      const dp = ed.snapPt(V.apply(toDoc, lp.x, lp.y));
      lp = V.apply(toDoc.inverse(), dp.x, dp.y);
    }
    drag.moved = true;
    if (drag.what === 'anchors') {
      const dx = lp.x - drag.last.x, dy = lp.y - drag.last.y;
      drag.last = lp;
      for (const i of nd.selNodes) moveAnchor(nd.segs, i, dx, dy);
    } else {
      const s = nd.segs[drag.i];
      s.p[drag.k] = lp.x; s.p[drag.k + 1] = lp.y;
      if (drag.opp && !e.altKey) {
        const o = nd.segs[drag.opp.i];
        const len = Math.hypot(o.p[drag.opp.k] - drag.opp.ax, o.p[drag.opp.k + 1] - drag.opp.ay);
        const ang = Math.atan2(lp.y - drag.opp.ay, lp.x - drag.opp.ax) + Math.PI;
        o.p[drag.opp.k] = drag.opp.ax + Math.cos(ang) * len;
        o.p[drag.opp.k + 1] = drag.opp.ay + Math.sin(ang) * len;
      }
    }
    nodeWrite();
    ed.redraw();
  };

  const onDbl = (e) => {
    if (ed.tool === 'pen' && penState) { if (penState.pts.length > 2) penState.pts.pop(); finishPen(false); return; }
    if (ed.tool !== 'select') return;
    const el = ed.pickNoCtx(e.target);
    if (!el) { if (ed.ctx !== ed.doc) ed.setCtx(ed.ctx.parentNode === ed.doc || ed.ctx.parentNode.localName !== 'g' ? ed.doc : ed.ctx.parentNode); return; }
    if (el.localName === 'g' || el.localName === 'a') {
      ed.ctx = el;
      const inner = ed.pick(e.target);
      ed.select(inner ? [inner] : []);
      V.toast('Editing inside group — Esc or double-click outside to leave');
      return;
    }
    if (el.localName === 'text') { ed.select([el]); ed.emit('edit-text', el); return; }
    if (['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(el.localName)) ed.enterNodeMode(el);
  };

  const onWheel = (e) => {
    e.preventDefault();
    const vp = ed.clientToView(e.clientX, e.clientY);
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
      ed.zoomBy(f, vp.x, vp.y);
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      ed.panX -= (e.shiftKey ? e.deltaY : e.deltaX) * k;
      ed.panY -= (e.shiftKey ? 0 : e.deltaY) * k;
      applyView();
    }
  };

  ed.keyDown = (e) => {
    if (e.code === 'Space' && !V.isTyping(e)) { if (!spaceDown) { spaceDown = true; stage.classList.add('panning'); } e.preventDefault(); return true; }
    return false;
  };
  ed.keyUp = (e) => { if (e.code === 'Space') { spaceDown = false; stage.classList.remove('panning'); } };

  ed.escape = () => {
    if (penState) { finishPen(false); return; }
    if (ed.node) { const el = ed.node.el; ed.exitNodeMode(); ed.select([el]); return; }
    if (ed.sel.length) { ed.select([]); return; }
    if (ed.ctx !== ed.doc) { const g = ed.ctx; ed.ctx = g.parentNode && g.parentNode !== ed.doc && g.parentNode.localName === 'g' ? g.parentNode : ed.doc; ed.select([g]); }
  };
  ed.enter = () => {
    if (penState) { finishPen(false); return; }
    if (ed.sel.length !== 1) return;
    const el = ed.sel[0];
    if (el.localName === 'text') ed.emit('edit-text', el);
    else if (el.localName === 'g') { ed.ctx = el; ed.select([]); }
    else ed.enterNodeMode(el);
  };

  ed.init = () => {
    view = V.$('#view'); viewport = V.$('#viewport'); docHost = V.$('#docHost'); overlay = V.$('#overlay');
    stage = V.$('#stage'); pageBg = V.$('#pageBg'); pageShadow = V.$('#pageShadow'); gridLayer = V.$('#gridLayer');
    view.addEventListener('pointerdown', onDown);
    view.addEventListener('pointermove', onMove);
    view.addEventListener('pointerup', onUp);
    view.addEventListener('pointercancel', onUp);
    view.addEventListener('dblclick', onDbl);
    view.addEventListener('wheel', onWheel, { passive: false });
    view.addEventListener('pointerleave', () => { if (hoverEl) { hoverEl = null; ed.redraw(); } });
    new ResizeObserver(() => ed.redraw()).observe(stage);
    stage.dataset.tool = ed.tool;
  };
})(window.V);
