/* PDF editor: pages (reorder, rotate, delete, duplicate, insert, merge, split), annotations
   (text, shapes, highlight, ink, white-out, true redaction, images, signatures, SVG drawings),
   form filling and metadata. Rendering with pdf.js, writing with pdf-lib. */
'use strict';
(function (V) {
  const { $, $$, h, fmt, icon } = V;
  const pdfjs = window.pdfjsLib;
  const PL = () => window.PDFLib;
  if (pdfjs) pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const P = V.pdf = {
    sources: [], pages: [], cur: 0, sel: new Set(), tool: 'select', zoom: null, fitMode: 'width',
    fileName: 'document.pdf', fileHandle: null, form: null, formValues: {}, flatten: false,
    meta: { title: '', author: '', subject: '', keywords: '' }, metaLoaded: false,
    asel: -1, undo: [], redo: [], dirty: false,
    style: Object.assign({ color: '#d0021b', width: 2, size: 14, font: 'Helvetica', bold: false, fillOn: false, fill: '#ffe08a' }, V.storage.get('pdfStyle', {})),
  };
  let uidN = 1;
  const nuid = () => 'p' + (uidN++);

  const CSS_FONT = { Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif', TimesRoman: '"Times New Roman", Times, "Liberation Serif", serif', Courier: '"Courier New", Courier, "Liberation Mono", monospace' };
  const ASCENT = 0.8, LH = 1.2;
  const BOXY = new Set(['rect', 'ellipse', 'highlight', 'whiteout', 'redact', 'image', 'sig', 'svg']);
  const KEEP_ASPECT = new Set(['image', 'sig', 'svg']);
  const ORIENTED = new Set(['text', 'image', 'sig', 'svg']);

  /* ================================================================ loading */
  const loadJs = (bytes, name) => new Promise((resolve, reject) => {
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: false, useSystemFonts: true });
    task.onPassword = async (update, reason) => {
      const pw = await V.prompt('Password required', (reason === 2 ? 'Incorrect password. ' : '') + `“${name}” is password protected.`, '', 'password');
      if (pw == null) { task.destroy(); reject(new Error('Password not entered')); } else update(pw);
    };
    task.promise.then(resolve, reject);
  });

  const addSource = async (file) => {
    const bytes = new Uint8Array(await V.readAs(file, 'buffer'));
    const js = await loadJs(bytes, file.name);
    let encrypted = false;
    try { await PL().PDFDocument.load(bytes, { updateMetadata: false }); }
    catch (e) { encrypted = e && /encrypt/i.test(e.message || e.name || ''); if (!encrypted) console.warn('pdf-lib could not parse', e); }
    const src = { id: P.sources.length, name: file.name, bytes, js, encrypted, pageCount: js.numPages };
    P.sources.push(src);
    return src;
  };

  const pageEntries = async (src) => {
    const out = [];
    for (let i = 0; i < src.js.numPages; i++) {
      const pg = await src.js.getPage(i + 1);
      const view = pg.view.slice();
      out.push({ uid: nuid(), kind: 'pdf', src: src.id, index: i, rot0: pg.rotate || 0, rot: 0, view, annots: [] });
    }
    return out;
  };

  const imageEntry = async (file) => {
    let url = await V.readAs(file, 'dataurl');
    let img = await V.loadImage(url);
    let mime = file.type;
    if (!/png|jpe?g/.test(mime)) {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      url = c.toDataURL('image/png'); mime = 'image/png';
      img = await V.loadImage(url);
    }
    const w = img.naturalWidth * 0.75, hh = img.naturalHeight * 0.75;
    // fit large photos onto an A4-ish page width
    const k = Math.min(1, 842 / Math.max(w, hh));
    return { uid: nuid(), kind: 'image', rot0: 0, rot: 0, view: [0, 0, w * k, hh * k], image: { url, mime }, annots: [] };
  };

  P.openFiles = async (files, append) => {
    files = files.filter(Boolean);
    if (!files.length) return;
    if (!append && P.pages.length && P.dirty && !confirm('Open a new document? Unsaved changes to the current PDF will be lost.')) return;
    V.busy('Opening…');
    try {
      if (!append) reset();
      let added = 0;
      for (const f of files) {
        if (/pdf/.test(f.type) || /\.pdf$/i.test(f.name)) {
          const src = await addSource(f);
          const entries = await pageEntries(src);
          P.pages.push(...entries);
          added += entries.length;
          if (src.id === 0) { await loadBaseInfo(src); P.fileName = f.name; }
          if (src.encrypted) V.toast(`“${f.name}” is encrypted — its pages will be saved as images.`);
        } else if (/^image\//.test(f.type)) {
          P.pages.push(await imageEntry(f));
          added++;
          if (!append && P.pages.length === 1) P.fileName = V.baseName(f.name) + '.pdf';
        }
      }
      if (!append) { P.cur = 0; P.undo = []; P.redo = []; P.dirty = false; }
      else P.dirty = true;
      commit(true);
      renderAll();
      if (append) V.toast(`Added ${added} page${added === 1 ? '' : 's'}`);
    } catch (e) {
      console.error(e);
      V.toast('Could not open: ' + e.message, 'err');
    } finally { V.busy(false); }
  };

  const reset = () => {
    for (const s of P.sources) try { s.js.destroy(); } catch (e) {}
    P.sources = []; P.pages = []; P.cur = 0; P.sel = new Set(); P.asel = -1;
    P.form = null; P.formValues = {}; P.flatten = false; P.meta = { title: '', author: '', subject: '', keywords: '' };
    P.fileHandle = null; P.fileName = 'document.pdf';
    thumbCache.clear();
  };

  const loadBaseInfo = async (src) => {
    P.form = null;
    try {
      const doc = await PL().PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
      P.meta = { title: doc.getTitle() || '', author: doc.getAuthor() || '', subject: doc.getSubject() || '', keywords: doc.getKeywords() || '' };
      try {
        const form = doc.getForm();
        const fields = form.getFields().map((f) => {
          const L = PL();
          const t = f instanceof L.PDFTextField ? 'PDFTextField' : f instanceof L.PDFCheckBox ? 'PDFCheckBox' : f instanceof L.PDFDropdown ? 'PDFDropdown'
            : f instanceof L.PDFOptionList ? 'PDFOptionList' : f instanceof L.PDFRadioGroup ? 'PDFRadioGroup' : 'other';
          const o = { name: f.getName(), type: t, readOnly: f.isReadOnly && f.isReadOnly() };
          try {
            if (t === 'PDFTextField') { o.value = f.getText() || ''; o.multiline = f.isMultiline(); o.max = f.getMaxLength(); }
            else if (t === 'PDFCheckBox') o.value = f.isChecked();
            else if (t === 'PDFDropdown' || t === 'PDFOptionList') { o.options = f.getOptions(); o.value = (f.getSelected() || [])[0] || ''; }
            else if (t === 'PDFRadioGroup') { o.options = f.getOptions(); o.value = f.getSelected() || ''; }
          } catch (e) { o.error = true; }
          return o;
        }).filter((f) => ['PDFTextField', 'PDFCheckBox', 'PDFDropdown', 'PDFOptionList', 'PDFRadioGroup'].includes(f.type));
        if (fields.length) P.form = { fields };
      } catch (e) { /* no form */ }
    } catch (e) { console.warn('metadata read failed', e); }
  };

  P.newBlank = () => {
    if (P.pages.length && P.dirty && !confirm('Start a new PDF? Unsaved changes will be lost.')) return;
    reset();
    P.pages.push({ uid: nuid(), kind: 'blank', rot0: 0, rot: 0, view: [0, 0, 595.28, 841.89], annots: [] });
    P.fileName = 'document.pdf';
    P.undo = []; P.redo = []; P.dirty = false;
    commit(true);
    renderAll();
  };

  /* ================================================================ history */
  const snap = () => JSON.stringify({
    pages: P.pages.map((p) => ({ ...p, annots: p.annots })),
    formValues: P.formValues, meta: P.meta, flatten: P.flatten, cur: P.cur,
  });
  const commit = (initial) => {
    const s = snap();
    if (P.undo.length && P.undo[P.undo.length - 1] === s) return;
    P.undo.push(s);
    if (P.undo.length > 200) P.undo.shift();
    P.redo = [];
    if (!initial) P.dirty = true;
    updateStatus();
  };
  const restore = (s) => {
    const o = JSON.parse(s);
    P.pages = o.pages; P.formValues = o.formValues; P.meta = o.meta; P.flatten = o.flatten;
    P.cur = Math.min(o.cur, P.pages.length - 1);
    P.asel = -1;
    P.sel = new Set();
    P.dirty = true;
    renderAll();
  };
  P.undoOp = () => { if (P.undo.length < 2) return; P.redo.push(P.undo.pop()); restore(P.undo[P.undo.length - 1]); };
  P.redoOp = () => { const s = P.redo.pop(); if (!s) return; P.undo.push(s); restore(s); };

  /* ================================================================ geometry */
  const totalRot = (pg) => (((pg.rot0 || 0) + (pg.rot || 0)) % 360 + 360) % 360;
  const dims = (pg) => ({ w: pg.view[2] - pg.view[0], h: pg.view[3] - pg.view[1] });

  /* ================================================================ thumbnails */
  const thumbCache = new Map();
  const THUMB_W = 132;
  const renderThumb = async (pg) => {
    const r = totalRot(pg);
    const key = (pg.kind === 'pdf' ? pg.src + ':' + pg.index : pg.kind === 'image' ? pg.image.url.slice(-64) : 'blank' + dims(pg).w + 'x' + dims(pg).h) + '@' + r;
    if (thumbCache.has(key)) return thumbCache.get(key);
    const { w, h: hh } = dims(pg);
    const rw = r % 180 ? hh : w, rh = r % 180 ? w : hh;
    const scale = THUMB_W / rw;
    const c = document.createElement('canvas');
    c.width = Math.round(rw * scale * 1.5); c.height = Math.round(rh * scale * 1.5);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    if (pg.kind === 'pdf') {
      const page = await P.sources[pg.src].js.getPage(pg.index + 1);
      const vp = page.getViewport({ scale: scale * 1.5, rotation: r });
      await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    } else if (pg.kind === 'image') {
      const img = await V.loadImage(pg.image.url);
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate(r * Math.PI / 180);
      const iw = w * scale * 1.5, ih = hh * scale * 1.5;
      ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
    }
    const url = c.toDataURL('image/jpeg', 0.8);
    thumbCache.set(key, url);
    return url;
  };

  let thumbDrag = null;
  const renderThumbs = () => {
    const box = $('#thumbs');
    box.textContent = '';
    P.pages.forEach((pg, i) => {
      const r = totalRot(pg);
      const { w, h: hh } = dims(pg);
      const rw = r % 180 ? hh : w, rh = r % 180 ? w : hh;
      const pgEl = h('div', { class: 'pg', style: `width:${THUMB_W}px;max-width:100%;aspect-ratio:${fmt(rw, 2)} / ${fmt(rh, 2)}` });
      const t = h('div', { class: 'thumb' + (i === P.cur ? ' cur' : '') + (P.sel.has(pg.uid) ? ' sel' : ''), draggable: 'true', 'data-i': i, title: pg.kind === 'pdf' ? `${P.sources[pg.src].name} — page ${pg.index + 1}` : pg.kind },
        pgEl, h('div', { class: 'num' }, String(i + 1) + (pg.kind === 'blank' ? ' · blank' : pg.kind === 'image' ? ' · image' : '')));
      if (pg.annots.length) t.append(h('span', { class: 'badge', title: 'Annotations' }, String(pg.annots.length)));
      renderThumb(pg).then((url) => { pgEl.append(h('img', { src: url, alt: '' })); }).catch((e) => console.warn(e));
      t.addEventListener('click', (e) => {
        if (e.shiftKey && P.pages[P.cur]) {
          const a = Math.min(P.cur, i), b = Math.max(P.cur, i);
          for (let k = a; k <= b; k++) P.sel.add(P.pages[k].uid);
        } else if (e.ctrlKey || e.metaKey) {
          if (P.sel.has(pg.uid)) P.sel.delete(pg.uid); else P.sel.add(pg.uid);
        } else { P.sel = new Set(); }
        goTo(i);
      });
      t.addEventListener('dragstart', (e) => {
        const uids = P.sel.has(pg.uid) ? P.pages.filter((p) => P.sel.has(p.uid)).map((p) => p.uid) : [pg.uid];
        thumbDrag = uids;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'pages');
        t.classList.add('dragging');
      });
      t.addEventListener('dragend', () => { t.classList.remove('dragging'); thumbDrag = null; $$('.thumb').forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
      t.addEventListener('dragover', (e) => {
        if (!thumbDrag) return;
        e.preventDefault();
        const rr = t.getBoundingClientRect();
        const before = e.clientY < rr.top + rr.height / 2;
        t.classList.toggle('drop-before', before); t.classList.toggle('drop-after', !before);
      });
      t.addEventListener('dragleave', () => t.classList.remove('drop-before', 'drop-after'));
      t.addEventListener('drop', (e) => {
        if (!thumbDrag) return;
        e.preventDefault();
        const before = t.classList.contains('drop-before');
        const moving = P.pages.filter((p) => thumbDrag.includes(p.uid));
        const curUid = P.pages[P.cur] && P.pages[P.cur].uid;
        const target = P.pages[i];
        if (moving.includes(target)) return;
        P.pages = P.pages.filter((p) => !thumbDrag.includes(p.uid));
        let at = P.pages.indexOf(target) + (before ? 0 : 1);
        P.pages.splice(at, 0, ...moving);
        P.cur = Math.max(0, P.pages.findIndex((p) => p.uid === curUid));
        thumbDrag = null;
        commit();
        renderAll();
      });
      box.append(t);
    });
    $('#pdfPageCount').textContent = P.pages.length ? `${P.pages.length} page${P.pages.length === 1 ? '' : 's'}` + (P.sel.size ? ` · ${P.sel.size} selected` : '') : '';
    const cur = box.children[P.cur];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  };

  /* ================================================================ page view */
  let renderTask = null, renderGen = 0;
  const pageEl = () => $('#pdfPage');
  const overlay = () => $('#pdfOverlay');

  const fitZoom = (pg) => {
    const st = $('#pdfStage');
    const r = totalRot(pg);
    const { w, h: hh } = dims(pg);
    const rw = r % 180 ? hh : w, rh = r % 180 ? w : hh;
    const aw = st.clientWidth - 64, ah = st.clientHeight - 64;
    if (P.fitMode === 'page') return Math.max(0.1, Math.min(aw / rw, ah / rh));
    return Math.max(0.1, Math.min(aw / rw, 4));
  };
  const scale = () => P.zoom || fitZoom(P.pages[P.cur]);

  const renderPage = async () => {
    const empty = !P.pages.length;
    $('#pdfEmpty').hidden = !empty;
    $('#pdfPageWrap').hidden = empty;
    if (empty) { overlay().textContent = ''; return; }
    P.cur = V.clamp(P.cur, 0, P.pages.length - 1);
    const pg = P.pages[P.cur];
    const s = scale();
    const { w, h: hh } = dims(pg);
    const r = totalRot(pg);
    const rot = $('#pdfRot');
    const W = w * s, H = hh * s;
    rot.style.width = (r % 180 ? H : W) + 'px';
    rot.style.height = (r % 180 ? W : H) + 'px';
    const pe = pageEl();
    Object.assign(pe.style, { width: W + 'px', height: H + 'px', left: ((r % 180 ? H : W) - W) / 2 + 'px', top: ((r % 180 ? W : H) - H) / 2 + 'px', transform: r ? `rotate(${r}deg)` : '' });
    overlay().setAttribute('viewBox', `0 0 ${w} ${hh}`);
    drawAnnots();
    const canvas = $('#pdfCanvas');
    const dpr = window.devicePixelRatio || 1;
    const gen = ++renderGen;
    if (renderTask) { try { renderTask.cancel(); } catch (e) {} renderTask = null; }
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    const off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    try {
      if (pg.kind === 'pdf') {
        const page = await P.sources[pg.src].js.getPage(pg.index + 1);
        if (gen !== renderGen) return;
        const vp = page.getViewport({ scale: s * dpr, rotation: 0 });
        renderTask = page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE });
        await renderTask.promise;
        renderTask = null;
      } else if (pg.kind === 'image') {
        const img = await V.loadImage(pg.image.url);
        ctx.drawImage(img, 0, 0, cw, ch);
      }
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.warn(e);
    }
    if (gen !== renderGen) return;
    canvas.width = cw; canvas.height = ch;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    canvas.getContext('2d').drawImage(off, 0, 0);
    $('#pdfZoomLabel').textContent = Math.round(s * 100) + '%';
    $('#pdfPageInfo').textContent = `Page ${P.cur + 1} of ${P.pages.length} · ${fmt(w, 0)} × ${fmt(hh, 0)} pt${r ? ' · rotated ' + r + '°' : ''}`;
  };

  const goTo = (i) => {
    finishTextEdit();
    P.cur = V.clamp(i, 0, P.pages.length - 1);
    P.asel = -1;
    renderThumbs();
    renderPage();
    renderAnnotPane();
    updateStatus();
  };

  /* ---------- pointer -> page coordinates (handles CSS rotation) ---------- */
  const toPage = (e) => {
    const pg = P.pages[P.cur];
    const s = scale();
    const r = totalRot(pg) * Math.PI / 180;
    const rect = pageEl().getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    const x = dx * Math.cos(r) + dy * Math.sin(r), y = -dx * Math.sin(r) + dy * Math.cos(r);
    const { w, h: hh } = dims(pg);
    return { x: x / s + w / 2, y: y / s + hh / 2 };
  };

  /* ================================================================ annotations: drawing */
  const svgE = V.svgEl;
  const arrowHead = (a) => {
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
    const L = Math.max(8, a.width * 4), Wd = L * 0.55;
    const bx = a.x2 - Math.cos(ang) * L, by = a.y2 - Math.sin(ang) * L;
    const px = -Math.sin(ang) * Wd / 2, py = Math.cos(ang) * Wd / 2;
    return { d: `M${fmt(a.x2)} ${fmt(a.y2)}L${fmt(bx + px)} ${fmt(by + py)}L${fmt(bx - px)} ${fmt(by - py)}Z`, bx, by };
  };
  const inkD = (pts) => V.Path.serialize(V.Path.smoothPath(pts, false), 2);
  const sigD = (a) => a.strokes.map((st) => V.Path.serialize(V.Path.smoothPath(st.map(([x, y]) => [a.x + x * a.w, a.y + y * a.h]), false), 2)).join(' ');
  const pivot = (a) => (a.type === 'text' ? { x: a.x, y: a.y } : { x: a.x + a.w / 2, y: a.y + a.h / 2 });

  const annBox = (a) => {
    if (BOXY.has(a.type)) return { x: a.x, y: a.y, w: a.w, h: a.h };
    if (a.type === 'line' || a.type === 'arrow') return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
    if (a.type === 'ink') { const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]); const x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }; }
    if (a.type === 'text') {
      const lines = a.text.split('\n');
      const ctx = measureCtx();
      ctx.font = `${a.bold ? 'bold ' : ''}${a.size}px ${CSS_FONT[a.font] || CSS_FONT.Helvetica}`;
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width), a.size * 0.5);
      return { x: a.x, y: a.y, w, h: a.size * LH * lines.length };
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  };
  let mctx = null;
  const measureCtx = () => mctx || (mctx = document.createElement('canvas').getContext('2d'));

  const drawAnn = (a, i, parent, draft) => {
    const g = svgE('g', { class: draft ? 'draft' : 'ann', 'data-ai': draft ? null : i }, parent);
    if (a.rot && ORIENTED.has(a.type)) { const p = pivot(a); g.setAttribute('transform', `rotate(${-a.rot} ${p.x} ${p.y})`); }
    const op = a.opacity ?? 1;
    switch (a.type) {
      case 'rect': svgE('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.fill || 'none', stroke: a.width ? a.color : 'none', 'stroke-width': a.width, opacity: op, 'pointer-events': 'visiblePainted' }, g); if (!a.fill) svgE('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: 'transparent', stroke: 'transparent', 'stroke-width': Math.max(6, a.width) }, g); break;
      case 'ellipse': svgE('ellipse', { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: a.w / 2, ry: a.h / 2, fill: a.fill || 'transparent', stroke: a.width ? a.color : 'none', 'stroke-width': a.width, opacity: op }, g); break;
      case 'highlight': svgE('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.color, opacity: 0.38, style: 'mix-blend-mode:multiply' }, g); break;
      case 'whiteout': svgE('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: '#ffffff', stroke: draft ? '#999' : 'none', 'stroke-dasharray': '3 2', 'stroke-width': 0.5 }, g); break;
      case 'redact': svgE('rect', { x: a.x, y: a.y, width: a.w, height: a.h, class: 'redact-box' }, g); break;
      case 'line': case 'arrow': {
        svgE('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, stroke: 'transparent', 'stroke-width': Math.max(8, a.width + 6) }, g);
        let x2 = a.x2, y2 = a.y2;
        if (a.type === 'arrow') { const ah = arrowHead(a); svgE('path', { d: ah.d, fill: a.color, opacity: op }, g); x2 = ah.bx; y2 = ah.by; }
        svgE('line', { x1: a.x1, y1: a.y1, x2, y2, stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': a.type === 'arrow' ? 'butt' : 'round', opacity: op }, g);
        break;
      }
      case 'ink':
        svgE('path', { d: inkD(a.points), fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(8, a.width + 6) }, g);
        svgE('path', { d: inkD(a.points), fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: op }, g);
        break;
      case 'sig':
        svgE('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: 'transparent' }, g);
        svgE('path', { d: sigD(a), fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
        break;
      case 'image': svgE('image', { x: a.x, y: a.y, width: a.w, height: a.h, href: a.url, preserveAspectRatio: 'none', opacity: op }, g); break;
      case 'svg': svgE('image', { x: a.x, y: a.y, width: a.w, height: a.h, href: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(a.svg), preserveAspectRatio: 'none', opacity: op }, g); break;
      case 'text': {
        if (editing && editing.a === a) break;
        const t = svgE('text', { x: a.x, y: a.y + a.size * ASCENT, fill: a.color, 'font-size': a.size, 'font-family': CSS_FONT[a.font] || CSS_FONT.Helvetica, 'font-weight': a.bold ? 'bold' : null, opacity: op, 'xml:space': 'preserve' }, g);
        a.text.split('\n').forEach((ln, k) => { const ts = svgE('tspan', { x: a.x, dy: k ? a.size * LH : 0 }, t); ts.textContent = ln || ' '; });
        const b = annBox(a);
        svgE('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'transparent' }, g);
        break;
      }
    }
    return g;
  };

  const drawAnnots = () => {
    const ov = overlay();
    ov.textContent = '';
    const pg = P.pages[P.cur];
    if (!pg) return;
    pg.annots.forEach((a, i) => drawAnn(a, i, ov));
    if (draftAnn) drawAnn(draftAnn, -1, ov, true);
    if (P.asel >= 0 && pg.annots[P.asel]) {
      const a = pg.annots[P.asel];
      const s = scale();
      const hs = 7 / s;
      const g = svgE('g', {}, ov);
      if (a.rot && ORIENTED.has(a.type)) { const p = pivot(a); g.setAttribute('transform', `rotate(${-a.rot} ${p.x} ${p.y})`); }
      if (a.type === 'line' || a.type === 'arrow') {
        for (const [k, x, y] of [['p1', a.x1, a.y1], ['p2', a.x2, a.y2]]) svgE('rect', { x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, class: 'ann-h', 'data-ah': k, style: 'cursor:move' }, g);
      } else {
        const b = annBox(a);
        const pad = 2 / s;
        svgE('rect', { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, class: 'ann-sel' }, g);
        if (BOXY.has(a.type)) {
          for (const [k, x, y, c] of [['nw', b.x, b.y, 'nwse'], ['ne', b.x + b.w, b.y, 'nesw'], ['se', b.x + b.w, b.y + b.h, 'nwse'], ['sw', b.x, b.y + b.h, 'nesw']]) {
            svgE('rect', { x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, class: 'ann-h', 'data-ah': k, style: `cursor:${c}-resize` }, g);
          }
        }
      }
    }
  };

  /* ================================================================ annotations: interaction */
  let draftAnn = null, adrag = null, editing = null;

  const styleFor = (type) => {
    const s = P.style;
    const base = { color: s.color, width: s.width, opacity: 1 };
    if (type === 'text') return { color: s.color, size: s.size, font: s.font, bold: s.bold };
    if (type === 'rect' || type === 'ellipse') return { ...base, fill: s.fillOn ? s.fill : null };
    if (type === 'highlight') return { color: s.fillOn ? s.fill : '#ffe600' };
    return base;
  };

  const onDown = (e) => {
    if (e.button !== 0 || !P.pages.length) return;
    const pg = P.pages[P.cur];
    const p = toPage(e);
    const t = P.tool;
    const ah = e.target.getAttribute && e.target.getAttribute('data-ah');
    const annG = e.target.closest && e.target.closest('[data-ai]');
    try { overlay().setPointerCapture(e.pointerId); } catch (err) {}
    if (ah && P.asel >= 0) {
      adrag = { kind: 'handle', h: ah, a: pg.annots[P.asel], orig: JSON.parse(JSON.stringify(pg.annots[P.asel])), start: p };
      return;
    }
    if (t === 'select') {
      if (annG) {
        const i = +annG.getAttribute('data-ai');
        P.asel = i;
        const a = pg.annots[i];
        if (e.detail >= 2 && a.type === 'text') { editText(a); return; }
        adrag = { kind: 'move', a, orig: JSON.parse(JSON.stringify(a)), start: p, moved: false };
      } else P.asel = -1;
      drawAnnots(); renderAnnotPane();
      return;
    }
    if (t === 'text') {
      if (annG && pg.annots[+annG.getAttribute('data-ai')].type === 'text') { P.asel = +annG.getAttribute('data-ai'); editText(pg.annots[P.asel]); return; }
      const a = { type: 'text', x: p.x, y: p.y - P.style.size * 0.6, text: '', rot: totalRot(pg), ...styleFor('text') };
      pg.annots.push(a);
      P.asel = pg.annots.length - 1;
      editText(a, true);
      return;
    }
    if (t === 'ink') {
      draftAnn = { type: 'ink', points: [[p.x, p.y]], ...styleFor('ink') };
      adrag = { kind: 'ink' };
      drawAnnots();
      return;
    }
    if (['rect', 'ellipse', 'highlight', 'whiteout', 'redact', 'line', 'arrow'].includes(t)) {
      adrag = { kind: 'create', start: p, type: t };
    }
  };
  const onMove = (e) => {
    if (!adrag) return;
    const pg = P.pages[P.cur];
    let p = toPage(e);
    const { w: pw, h: ph } = dims(pg);
    p = { x: V.clamp(p.x, 0, pw), y: V.clamp(p.y, 0, ph) };
    if (adrag.kind === 'create') {
      const s = adrag.start, t = adrag.type;
      if (t === 'line' || t === 'arrow') {
        let x2 = p.x, y2 = p.y;
        if (e.shiftKey) { const ang = Math.round(Math.atan2(y2 - s.y, x2 - s.x) / (Math.PI / 4)) * (Math.PI / 4); const len = Math.hypot(x2 - s.x, y2 - s.y); x2 = s.x + Math.cos(ang) * len; y2 = s.y + Math.sin(ang) * len; }
        draftAnn = { type: t, x1: s.x, y1: s.y, x2, y2, ...styleFor(t) };
      } else {
        let w = p.x - s.x, hh = p.y - s.y;
        if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
        draftAnn = { type: t, x: Math.min(s.x, s.x + w), y: Math.min(s.y, s.y + hh), w: Math.abs(w), h: Math.abs(hh), ...styleFor(t) };
      }
      drawAnnots();
    } else if (adrag.kind === 'ink') {
      const last = draftAnn.points[draftAnn.points.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) * scale() < 1.5) return;
      draftAnn.points.push([p.x, p.y]);
      drawAnnots();
    } else if (adrag.kind === 'move') {
      const dx = p.x - adrag.start.x, dy = p.y - adrag.start.y;
      if (!adrag.moved && Math.hypot(dx, dy) * scale() < 2) return;
      adrag.moved = true;
      moveAnn(adrag.a, adrag.orig, dx, dy);
      drawAnnots();
    } else if (adrag.kind === 'handle') {
      const a = adrag.a, o = adrag.orig;
      if (adrag.h === 'p1') { a.x1 = p.x; a.y1 = p.y; }
      else if (adrag.h === 'p2') { a.x2 = p.x; a.y2 = p.y; }
      else {
        // resize in the annotation's own (possibly counter-rotated) frame
        let q = p;
        if (a.rot && ORIENTED.has(a.type)) {
          const c = pivot(o), r = a.rot * Math.PI / 180;
          const dx = p.x - c.x, dy = p.y - c.y;
          q = { x: c.x + dx * Math.cos(r) - dy * Math.sin(r), y: c.y + dx * Math.sin(r) + dy * Math.cos(r) };
        }
        const ax = adrag.h.includes('w') ? o.x + o.w : o.x, ay = adrag.h.includes('n') ? o.y + o.h : o.y;
        let w = q.x - ax, hh = q.y - ay;
        if (KEEP_ASPECT.has(a.type) !== e.shiftKey && o.w && o.h) {
          const k = Math.max(Math.abs(w) / o.w, Math.abs(hh) / o.h);
          w = Math.sign(w || 1) * o.w * k; hh = Math.sign(hh || 1) * o.h * k;
        }
        a.x = Math.min(ax, ax + w); a.y = Math.min(ay, ay + hh); a.w = Math.max(1, Math.abs(w)); a.h = Math.max(1, Math.abs(hh));
      }
      drawAnnots();
    }
  };
  const onUp = () => {
    const d = adrag;
    adrag = null;
    if (!d) return;
    const pg = P.pages[P.cur];
    if (d.kind === 'create') {
      const a = draftAnn;
      draftAnn = null;
      if (a && ((a.w != null && a.w > 2 && a.h > 2) || (a.x1 != null && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) > 3))) {
        pg.annots.push(a);
        P.asel = pg.annots.length - 1;
        commit();
        if (a.type === 'redact') V.toast('Redaction: on save, this page is flattened to an image so the covered content is really removed.');
      }
      drawAnnots(); renderThumbsSoon(); renderAnnotPane();
    } else if (d.kind === 'ink') {
      const a = draftAnn;
      draftAnn = null;
      if (a && a.points.length > 1) {
        a.points = V.Path.simplify(a.points, 0.6 / scale() * 2);
        pg.annots.push(a);
        P.asel = pg.annots.length - 1;
        commit();
      }
      drawAnnots(); renderThumbsSoon(); renderAnnotPane();
    } else if ((d.kind === 'move' && d.moved) || d.kind === 'handle') {
      commit(); renderAnnotPane();
    }
  };
  const moveAnn = (a, o, dx, dy) => {
    if (a.x != null && a.type !== 'ink') { a.x = o.x + dx; a.y = o.y + dy; }
    if (a.x1 != null) { a.x1 = o.x1 + dx; a.y1 = o.y1 + dy; a.x2 = o.x2 + dx; a.y2 = o.y2 + dy; }
    if (a.points) a.points = o.points.map(([x, y]) => [x + dx, y + dy]);
  };
  const renderThumbsSoon = V.debounce(() => renderThumbs(), 200);

  /* ---------- inline text editing ---------- */
  const editText = (a, isNew) => {
    finishTextEdit();
    const s = scale();
    const ta = h('textarea', { class: 'pdf-text-edit', spellcheck: true, wrap: 'off' });
    ta.value = a.text;
    editing = { a, ta, isNew };
    Object.assign(ta.style, {
      left: a.x * s + 'px', top: a.y * s + 'px', fontSize: a.size * s + 'px', fontFamily: CSS_FONT[a.font] || CSS_FONT.Helvetica,
      fontWeight: a.bold ? 'bold' : 'normal', color: a.color, transform: a.rot ? `rotate(${-a.rot}deg)` : '',
    });
    const fit = () => { ta.style.width = 'auto'; ta.style.height = 'auto'; ta.style.width = Math.max(ta.scrollWidth + 4, 40) + 'px'; ta.style.height = ta.scrollHeight + 'px'; };
    pageEl().appendChild(ta);
    fit();
    drawAnnots();
    setTimeout(() => ta.focus(), 0);
    ta.addEventListener('input', () => { a.text = ta.value; fit(); });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); ta.blur(); }
    });
    ta.addEventListener('blur', () => finishTextEdit());
  };
  const finishTextEdit = () => {
    if (!editing) return;
    const { a, ta } = editing;
    editing = null;
    ta.remove();
    const pg = P.pages[P.cur];
    a.text = ta.value.replace(/\s+$/, '');
    if (!a.text.trim()) {
      const i = pg ? pg.annots.indexOf(a) : -1;
      if (i >= 0) pg.annots.splice(i, 1);
      P.asel = -1;
    }
    commit();
    drawAnnots(); renderThumbsSoon(); renderAnnotPane();
  };

  /* ---------- placing images / signatures / SVG drawings ---------- */
  const placeBox = (pg, w, hh) => {
    const { w: pw, h: ph } = dims(pg);
    const k = Math.min(1, (pw * 0.5) / w, (ph * 0.5) / hh);
    return { x: (pw - w * k) / 2, y: (ph - hh * k) / 2, w: w * k, h: hh * k };
  };
  const addPlaced = (a) => {
    const pg = P.pages[P.cur];
    a.rot = totalRot(pg);
    if (a.rot % 180) { const t = a.w; a.w = a.h; a.h = t; const b = placeBox(pg, a.w, a.h); Object.assign(a, b); }
    pg.annots.push(a);
    P.asel = pg.annots.length - 1;
    setTool('select');
    commit();
    drawAnnots(); renderThumbsSoon(); renderAnnotPane();
  };
  P.placeImage = async () => {
    if (!P.pages.length) return;
    const f = await V.pickFile('filePdfImg');
    if (!f) return;
    let url = await V.readAs(f, 'dataurl');
    let img = await V.loadImage(url);
    if (!/png|jpe?g/.test(f.type)) {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0); url = c.toDataURL('image/png');
    }
    const pg = P.pages[P.cur];
    addPlaced({ type: 'image', url, opacity: 1, ...placeBox(pg, img.naturalWidth * 0.75, img.naturalHeight * 0.75) });
  };
  P.placeSvg = (svgText) => {
    if (!P.pages.length) return;
    let m;
    try { m = V.svg2pdf.mount(svgText); } catch (e) { V.toast(e.message, 'err'); return; }
    const { w, h: hh } = V.svg2pdf.measure(m.svg);
    m.unmount();
    const pg = P.pages[P.cur];
    addPlaced({ type: 'svg', svg: svgText, opacity: 1, ...placeBox(pg, w * 0.75, hh * 0.75) });
    V.toast('Drawing placed as vector graphics — drag to move, corners to resize');
  };

  /* signature pad */
  const sig = { strokes: [], cur: null };
  const sigRedraw = () => {
    const c = $('#sigPad'), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#1b2a6b'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const st of sig.strokes.concat(sig.cur ? [sig.cur] : [])) {
      ctx.beginPath();
      st.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (st.length === 1) ctx.lineTo(st[0][0] + 0.1, st[0][1]);
      ctx.stroke();
    }
    ctx.strokeStyle = '#ccd'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(30, c.height - 40); ctx.lineTo(c.width - 30, c.height - 40); ctx.stroke();
  };
  const sigToAnn = (strokes) => {
    const all = strokes.flat();
    if (!all.length) return null;
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(Math.max(...xs) - x0, 1), hh = Math.max(Math.max(...ys) - y0, 1);
    const norm = strokes.map((st) => V.Path.simplify(st, 0.8).map(([x, y]) => [+((x - x0) / w).toFixed(4), +((y - y0) / hh).toFixed(4)]));
    return { strokes: norm, aspect: w / hh };
  };
  P.openSignature = () => {
    if (!P.pages.length) return;
    const dlg = $('#sigDlg');
    sig.strokes = []; sig.cur = null;
    const c = $('#sigPad');
    c.width = c.clientWidth || 560; c.height = 200;
    sigRedraw();
    const saved = V.storage.get('signature', null);
    $('#sigSaved').hidden = !saved;
    $('#sigRemember').checked = !!saved;
    dlg.returnValue = '';
    dlg.showModal();
    c.width = c.clientWidth; sigRedraw();
  };
  const placeSig = (s) => {
    const pg = P.pages[P.cur];
    const w = 180, hh = 180 / Math.max(0.5, s.aspect);
    addPlaced({ type: 'sig', strokes: s.strokes, color: '#1b2a6b', width: 1.6, ...placeBox(pg, w, hh) });
  };

  /* ================================================================ page operations */
  const targets = () => {
    if (P.sel.size) return P.pages.filter((p) => P.sel.has(p.uid));
    return P.pages[P.cur] ? [P.pages[P.cur]] : [];
  };
  P.rotatePages = (deg) => {
    const t = targets(); if (!t.length) return;
    t.forEach((p) => { p.rot = ((p.rot + deg) % 360 + 360) % 360; });
    commit(); renderThumbs(); renderPage();
  };
  P.deletePages = () => {
    const t = targets(); if (!t.length) return;
    if (t.length === P.pages.length && !confirm('Delete every page?')) return;
    const curUid = P.pages[P.cur].uid;
    P.pages = P.pages.filter((p) => !t.includes(p));
    P.sel = new Set();
    P.cur = Math.min(P.cur, P.pages.length - 1);
    if (t.every((p) => p.uid !== curUid)) P.cur = Math.max(0, P.pages.findIndex((p) => p.uid === curUid));
    commit(); renderAll();
    V.toast(`Deleted ${t.length} page${t.length === 1 ? '' : 's'}`);
  };
  P.duplicatePages = () => {
    const t = targets(); if (!t.length) return;
    const last = P.pages.indexOf(t[t.length - 1]);
    const copies = t.map((p) => ({ ...JSON.parse(JSON.stringify(p)), uid: nuid() }));
    P.pages.splice(last + 1, 0, ...copies);
    commit(); renderAll();
  };
  P.insertBlank = () => {
    const ref = P.pages[P.cur];
    const view = ref ? [0, 0, dims(ref).w, dims(ref).h] : [0, 0, 595.28, 841.89];
    const pg = { uid: nuid(), kind: 'blank', rot0: 0, rot: ref ? totalRot(ref) : 0, view, annots: [] };
    P.pages.splice(P.cur + 1, 0, pg);
    P.cur = P.cur + (ref ? 1 : 0);
    commit(); renderAll();
  };

  /* ================================================================ saving */
  const fontCache = new Map();
  const getStdFont = async (doc, name, bold) => {
    const SF = PL().StandardFonts;
    const key = name + (bold ? 'B' : '');
    const map = { Helvetica: SF.Helvetica, HelveticaB: SF.HelveticaBold, TimesRoman: SF.TimesRoman, TimesRomanB: SF.TimesRomanBold, Courier: SF.Courier, CourierB: SF.CourierBold };
    if (!fontCache.has(doc)) fontCache.set(doc, {});
    const fc = fontCache.get(doc);
    if (!fc[key]) { const f = await doc.embedFont(map[key] || SF.Helvetica); fc[key] = { font: f, set: new Set(f.getCharacterSet()) }; }
    return fc[key];
  };
  const rgbOf = (c) => { const p = V.parseColor(c) || { r: 0, g: 0, b: 0 }; return PL().rgb(p.r, p.g, p.b); };
  const warnings = new Set();

  /* Draw annotations onto a pdf-lib page whose native view box is `view`. */
  const drawAnnotsPdf = async (doc, page, annots, view) => {
    const L = PL();
    const [v0, , , v3] = view;
    const F = new DOMMatrix([1, 0, 0, -1, v0, v3]);
    const imgCache = new Map();
    for (const a of annots) {
      const op = a.opacity ?? 1;
      let wrapped = false;
      if (a.rot && ORIENTED.has(a.type)) {
        const c = pivot(a);
        const M = F.multiply(new DOMMatrix().translate(c.x, c.y).rotate(-a.rot).translate(-c.x, -c.y)).multiply(F.inverse());
        page.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(M.a, M.b, M.c, M.d, M.e, M.f));
        wrapped = true;
      }
      try {
        switch (a.type) {
          case 'rect':
            page.drawRectangle({ x: v0 + a.x, y: v3 - a.y - a.h, width: a.w, height: a.h, color: a.fill ? rgbOf(a.fill) : undefined, borderColor: a.width ? rgbOf(a.color) : undefined, borderWidth: a.width || 0, opacity: op, borderOpacity: op });
            break;
          case 'ellipse':
            page.drawEllipse({ x: v0 + a.x + a.w / 2, y: v3 - a.y - a.h / 2, xScale: a.w / 2, yScale: a.h / 2, color: a.fill ? rgbOf(a.fill) : undefined, borderColor: a.width ? rgbOf(a.color) : undefined, borderWidth: a.width || 0, opacity: op, borderOpacity: op });
            break;
          case 'highlight':
            page.drawRectangle({ x: v0 + a.x, y: v3 - a.y - a.h, width: a.w, height: a.h, color: rgbOf(a.color), opacity: 0.38, blendMode: L.BlendMode.Multiply });
            break;
          case 'whiteout':
            page.drawRectangle({ x: v0 + a.x, y: v3 - a.y - a.h, width: a.w, height: a.h, color: L.rgb(1, 1, 1) });
            break;
          case 'redact':
            page.drawRectangle({ x: v0 + a.x, y: v3 - a.y - a.h, width: a.w, height: a.h, color: L.rgb(0, 0, 0) });
            break;
          case 'line': case 'arrow': {
            let x2 = a.x2, y2 = a.y2;
            if (a.type === 'arrow') { const ah = arrowHead(a); page.drawSvgPath(ah.d, { x: v0, y: v3, color: rgbOf(a.color), opacity: op }); x2 = ah.bx; y2 = ah.by; }
            page.drawLine({ start: { x: v0 + a.x1, y: v3 - a.y1 }, end: { x: v0 + x2, y: v3 - y2 }, thickness: a.width, color: rgbOf(a.color), opacity: op, lineCap: a.type === 'arrow' ? L.LineCapStyle.Butt : L.LineCapStyle.Round });
            break;
          }
          case 'ink':
            page.drawSvgPath(inkD(a.points), { x: v0, y: v3, borderColor: rgbOf(a.color), borderWidth: a.width, borderOpacity: op, borderLineCap: L.LineCapStyle.Round });
            break;
          case 'sig':
            page.drawSvgPath(sigD(a), { x: v0, y: v3, borderColor: rgbOf(a.color), borderWidth: a.width, borderLineCap: L.LineCapStyle.Round });
            break;
          case 'image': {
            let img = imgCache.get(a.url);
            if (!img) {
              const { bytes, mime } = V.dataUrlToBytes(a.url);
              img = /png/.test(mime) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
              imgCache.set(a.url, img);
            }
            page.drawImage(img, { x: v0 + a.x, y: v3 - a.y - a.h, width: a.w, height: a.h, opacity: op });
            break;
          }
          case 'svg': {
            const m = V.svg2pdf.mount(a.svg);
            try {
              const { w, h: hh, vb } = V.svg2pdf.measure(m.svg);
              void w; void hh;
              const base = F.multiply(new DOMMatrix().translate(a.x, a.y)).multiply(V.svg2pdf.viewBoxMatrix(vb, a.w, a.h, 'none'));
              const res = await V.svg2pdf.draw(doc, page, m.svg, base);
              res.warnings.forEach((w2) => warnings.add(w2));
            } finally { m.unmount(); }
            break;
          }
          case 'text': {
            const f = await getStdFont(doc, a.font, a.bold);
            let replaced = false;
            const lines = a.text.split('\n').map((ln) => Array.from(ln).map((ch) => { if (f.set.has(ch.codePointAt(0))) return ch; replaced = true; return '?'; }).join(''));
            if (replaced) warnings.add('some characters are not in the standard PDF fonts and were replaced with "?"');
            lines.forEach((ln, k) => {
              if (!ln) return;
              page.drawText(ln, { x: v0 + a.x, y: v3 - (a.y + a.size * ASCENT + k * a.size * LH), size: a.size, font: f.font, color: rgbOf(a.color), opacity: op });
            });
            break;
          }
        }
      } finally {
        if (wrapped) page.pushOperators(L.popGraphicsState());
      }
    }
  };

  /* Render a page to a JPEG (for redaction / encrypted sources). */
  const rasterPage = async (pg, redacts) => {
    const { w, h: hh } = dims(pg);
    const k = 200 / 72;
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(hh * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    if (pg.kind === 'pdf') {
      const page = await P.sources[pg.src].js.getPage(pg.index + 1);
      const vp = page.getViewport({ scale: k, rotation: 0 });
      await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    } else if (pg.kind === 'image') {
      ctx.drawImage(await V.loadImage(pg.image.url), 0, 0, c.width, c.height);
    }
    ctx.fillStyle = '#000';
    for (const a of redacts) ctx.fillRect(Math.floor(a.x * k) - 1, Math.floor(a.y * k) - 1, Math.ceil(a.w * k) + 2, Math.ceil(a.h * k) + 2);
    const blob = await V.canvasToBlob(c, 'image/jpeg', 0.9);
    return new Uint8Array(await blob.arrayBuffer());
  };

  const applyForm = (doc) => {
    if (!P.form) return;
    let form;
    try { form = doc.getForm(); } catch (e) { return; }
    for (const f of P.form.fields) {
      if (!(f.name in P.formValues)) continue;
      const v = P.formValues[f.name];
      try {
        const field = f.type === 'PDFTextField' ? form.getTextField(f.name) : f.type === 'PDFCheckBox' ? form.getCheckBox(f.name)
          : f.type === 'PDFDropdown' ? form.getDropdown(f.name) : f.type === 'PDFOptionList' ? form.getOptionList(f.name) : form.getRadioGroup(f.name);
        if (f.type === 'PDFTextField') field.setText(String(v));
        else if (f.type === 'PDFCheckBox') { if (v) field.check(); else field.uncheck(); }
        else if (f.type === 'PDFDropdown' || f.type === 'PDFOptionList') { if (v) field.select(v); else field.clear(); }
        else if (f.type === 'PDFRadioGroup') { if (v) field.select(v); else field.clear(); }
      } catch (e) { warnings.add(`form field “${f.name}” could not be set`); }
    }
    try { form.updateFieldAppearances(); } catch (e) { warnings.add('some form fields need fonts that are not available; values may not show in every viewer'); }
  };

  /* Build a PDF from a list of page entries. */
  const build = async (list, { forSubset } = {}) => {
    const L = PL();
    warnings.clear();
    fontCache.clear();
    const libCache = new Map();
    const libOf = async (srcId) => {
      if (!libCache.has(srcId)) {
        const d = await L.PDFDocument.load(P.sources[srcId].bytes, { ignoreEncryption: true, updateMetadata: false });
        if (srcId === 0) applyForm(d);
        if (srcId === 0 && P.flatten && P.form) { try { d.getForm().flatten(); } catch (e) { warnings.add('form could not be flattened'); } }
        libCache.set(srcId, d);
      }
      return libCache.get(srcId);
    };
    const base0 = P.sources[0];
    const inPlace = !forSubset && base0 && !base0.encrypted && list.some((p) => p.kind === 'pdf' && p.src === 0);
    const out = inPlace ? await libOf(0) : await L.PDFDocument.create();
    const basePages = inPlace ? out.getPages() : [];
    const used = new Set();
    const final = [];
    for (const pg of list) {
      const redacts = pg.annots.filter((a) => a.type === 'redact');
      const src = pg.kind === 'pdf' ? P.sources[pg.src] : null;
      const raster = (src && src.encrypted) || redacts.length > 0;
      const { w, h: hh } = dims(pg);
      let page;
      let view = pg.view;
      if (raster) {
        const jpg = await out.embedJpg(await rasterPage(pg, redacts));
        page = out.addPage([w, hh]);
        page.drawImage(jpg, { x: 0, y: 0, width: w, height: hh });
        view = [0, 0, w, hh];
        page.setRotation(L.degrees(totalRot(pg)));
        if (src && src.encrypted) warnings.add('pages from encrypted PDFs were saved as images');
      } else if (pg.kind === 'blank') {
        page = out.addPage([w, hh]);
        page.setRotation(L.degrees(totalRot(pg)));
      } else if (pg.kind === 'image') {
        const { bytes, mime } = V.dataUrlToBytes(pg.image.url);
        const img = /png/.test(mime) ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        page = out.addPage([w, hh]);
        page.drawImage(img, { x: 0, y: 0, width: w, height: hh });
        page.setRotation(L.degrees(totalRot(pg)));
      } else if (inPlace && pg.src === 0 && !used.has(pg.index)) {
        page = basePages[pg.index];
        used.add(pg.index);
        page.setRotation(L.degrees(totalRot(pg)));
      } else {
        const srcDoc = await libOf(pg.src);
        [page] = await out.copyPages(srcDoc, [pg.index]);
        page.setRotation(L.degrees(totalRot(pg)));
      }
      const other = pg.annots.filter((a) => a.type !== 'redact' || raster);
      if (other.length) await drawAnnotsPdf(out, page, other, view);
      final.push(page);
    }
    // order pages: detach everything, then attach in order
    if (inPlace) {
      const removed = basePages.filter((_, i) => !used.has(i));
      while (out.getPageCount()) out.removePage(0);
      for (const p of final) out.addPage(p);
      // drop the content of deleted pages so it does not linger in the file
      for (const p of removed) {
        try {
          const node = p.node;
          const contents = node.get(L.PDFName.of('Contents'));
          const refs = contents instanceof L.PDFArray ? contents.asArray() : [contents];
          for (const r of refs) if (r instanceof L.PDFRef) out.context.delete(r);
          const annots = node.get(L.PDFName.of('Annots'));
          if (annots instanceof L.PDFRef) out.context.delete(annots);
          out.context.delete(p.ref);
        } catch (e) { console.warn('cleanup', e); }
      }
    } else {
      // pages were appended in order already (addPage) or copied (not yet attached)
      const attached = out.getPages();
      for (const p of attached) void p;
      while (out.getPageCount()) out.removePage(0);
      for (const p of final) out.addPage(p);
    }
    out.setTitle(P.meta.title || '');
    out.setAuthor(P.meta.author || '');
    out.setSubject(P.meta.subject || '');
    out.setKeywords((P.meta.keywords || '').split(/\s*[,;]\s*/).filter(Boolean));
    out.setProducer('Vector (pdf-lib)');
    out.setModificationDate(new Date());
    if (!inPlace) out.setCreator('Vector');
    return out.save({ useObjectStreams: true });
  };

  P.save = async (saveAs) => {
    if (!P.pages.length) return;
    finishTextEdit();
    V.busy('Building PDF…');
    await V.nextFrame();
    try {
      const bytes = await build(P.pages);
      V.busy(false);
      const res = await V.saveFile(bytes, P.fileName.replace(/\.pdf$/i, '') + (P.fileHandle || saveAs === false ? '' : '') + '.pdf', 'application/pdf', 'pdf', saveAs ? null : P.fileHandle);
      if (res === undefined) return;
      if (res) { P.fileHandle = res; if (res.name) P.fileName = res.name; }
      P.dirty = false;
      updateStatus();
      V.toast('Saved ' + P.fileName + (warnings.size ? ' — note: ' + Array.from(warnings).join('; ') : ''));
    } catch (e) {
      console.error(e);
      V.toast('Save failed: ' + e.message, 'err');
    } finally { V.busy(false); }
  };
  P.extract = async () => {
    const t = targets();
    if (!t.length) return;
    V.busy('Extracting…');
    await V.nextFrame();
    try {
      const bytes = await build(t, { forSubset: true });
      V.busy(false);
      const label = t.length === 1 ? `p${P.pages.indexOf(t[0]) + 1}` : `${t.length}pages`;
      await V.saveFile(bytes, V.baseName(P.fileName) + '-' + label + '.pdf', 'application/pdf', 'pdf');
    } catch (e) { V.toast('Extract failed: ' + e.message, 'err'); } finally { V.busy(false); }
  };
  P.split = async () => {
    if (P.pages.length < 2 || P.cur === 0) { V.toast('Select the first page of the second part (not page 1), then Split'); return; }
    V.busy('Splitting…');
    await V.nextFrame();
    try {
      const a = await build(P.pages.slice(0, P.cur), { forSubset: true });
      const b = await build(P.pages.slice(P.cur), { forSubset: true });
      V.busy(false);
      const base = V.baseName(P.fileName);
      await V.saveFile(a, `${base}-1-${P.cur}.pdf`, 'application/pdf', 'pdf');
      await V.saveFile(b, `${base}-${P.cur + 1}-${P.pages.length}.pdf`, 'application/pdf', 'pdf');
    } catch (e) { V.toast('Split failed: ' + e.message, 'err'); } finally { V.busy(false); }
  };

  /* ================================================================ side panels */
  const sec = (title, ...kids) => h('div', { class: 'sec' }, h('h4', {}, title), ...kids);
  const NAMES = { text: 'Text', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', highlight: 'Highlight', ink: 'Ink', whiteout: 'White-out', redact: 'Redaction', image: 'Image', sig: 'Signature', svg: 'Drawing' };
  const renderAnnotPane = () => {
    const p = $('#pdfAnnotPane');
    p.textContent = '';
    const pg = P.pages[P.cur];
    if (!pg) { p.append(h('div', { class: 'empty-note' }, 'Open a PDF to start.')); return; }
    const a = pg.annots[P.asel];
    if (a) {
      const s = sec(NAMES[a.type] || a.type);
      const upd = () => { commit(); drawAnnots(); };
      if ('color' in a && a.type !== 'redact' && a.type !== 'whiteout') {
        const c = h('input', { type: 'color', value: V.toHex(a.color) || '#000000' });
        c.addEventListener('input', () => { a.color = c.value; drawAnnots(); });
        c.addEventListener('change', upd);
        s.append(h('div', { class: 'row' }, h('label', {}, 'Colour'), c));
      }
      if ('width' in a && a.type !== 'highlight') {
        const w = h('input', { type: 'number', min: 0, step: 0.25, value: a.width });
        w.addEventListener('change', () => { a.width = Math.max(0, parseFloat(w.value) || 0); upd(); });
        s.append(h('div', { class: 'row' }, h('label', {}, 'Width'), w));
      }
      if (a.type === 'rect' || a.type === 'ellipse') {
        const on = h('input', { type: 'checkbox', checked: !!a.fill });
        const fc = h('input', { type: 'color', value: V.toHex(a.fill || P.style.fill) || '#ffe08a' });
        on.addEventListener('change', () => { a.fill = on.checked ? fc.value : null; upd(); });
        fc.addEventListener('input', () => { if (on.checked) { a.fill = fc.value; drawAnnots(); } });
        fc.addEventListener('change', upd);
        s.append(h('div', { class: 'row' }, h('label', {}, 'Fill'), on, fc));
      }
      if (a.type === 'text') {
        const ta = h('textarea', { rows: 3 }, a.text);
        ta.value = a.text;
        ta.addEventListener('input', () => { a.text = ta.value; drawAnnots(); });
        ta.addEventListener('change', upd);
        const sz = h('input', { type: 'number', min: 2, max: 400, value: a.size });
        sz.addEventListener('change', () => { a.size = V.clamp(parseFloat(sz.value) || 12, 2, 400); upd(); });
        const ff = h('select', {}, ...[['Helvetica', 'Sans (Helvetica)'], ['TimesRoman', 'Serif (Times)'], ['Courier', 'Mono (Courier)']].map(([v, l]) => h('option', { value: v, selected: a.font === v }, l)));
        ff.addEventListener('change', () => { a.font = ff.value; upd(); });
        const b = h('input', { type: 'checkbox', checked: !!a.bold });
        b.addEventListener('change', () => { a.bold = b.checked; upd(); });
        s.append(h('div', { class: 'field' }, ta), h('div', { class: 'row' }, h('label', {}, 'Size'), sz), h('div', { class: 'row' }, h('label', {}, 'Font'), ff), h('div', { class: 'row' }, h('label', { class: 'chk' }, b, 'Bold')),
          h('p', { class: 'muted small' }, 'Double-click the text on the page to edit it in place. Uses the standard PDF fonts, so accented Latin characters work but other scripts do not.'));
      }
      if (['rect', 'ellipse', 'line', 'arrow', 'ink', 'image', 'text', 'svg'].includes(a.type)) {
        const o = h('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: a.opacity ?? 1 });
        o.addEventListener('input', () => { a.opacity = +o.value; drawAnnots(); });
        o.addEventListener('change', upd);
        s.append(h('div', { class: 'row' }, h('label', {}, 'Opacity'), o));
      }
      if (a.type === 'redact') s.append(h('p', { class: 'muted small' }, 'When you save, this page is rendered to an image with the box burnt in, so the text and graphics underneath are genuinely removed (the page will no longer have selectable text).'));
      if (a.type === 'whiteout') s.append(h('p', { class: 'muted small' }, 'White-out only covers content visually — the original text is still in the file. Use Redact to remove it.'));
      s.append(h('div', { class: 'row' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => { pg.annots.push({ ...JSON.parse(JSON.stringify(a)) }); const n = pg.annots[pg.annots.length - 1]; moveAnn(n, JSON.parse(JSON.stringify(a)), 10, 10); P.asel = pg.annots.length - 1; commit(); drawAnnots(); renderAnnotPane(); renderThumbsSoon(); } }, 'Duplicate'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { pg.annots.splice(P.asel, 1); pg.annots.push(a); P.asel = pg.annots.length - 1; commit(); drawAnnots(); } }, 'To front'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: () => deleteAnnot() }, 'Delete')));
      p.append(s);
    }
    const list = h('ul', { class: 'layers' });
    pg.annots.slice().reverse().forEach((an, ri) => {
      const i = pg.annots.length - 1 - ri;
      const li = h('li', { class: i === P.asel ? 'sel' : '' }, h('span', { class: 'nm' }, (NAMES[an.type] || an.type) + (an.type === 'text' ? ' “' + an.text.slice(0, 24) + '”' : '')));
      li.addEventListener('click', () => { P.asel = i; drawAnnots(); renderAnnotPane(); });
      list.append(li);
    });
    p.append(sec(`On this page (${pg.annots.length})`, pg.annots.length ? list : h('p', { class: 'muted small', style: 'margin:0' }, 'Pick a tool above and click or drag on the page.')));
    p.append(sec('Tips', h('p', { class: 'muted small', style: 'margin:0' },
      'Select tool: click to select, drag to move, corner handles to resize (Shift toggles proportions). Arrow keys nudge, Delete removes. ',
      'Pages: drag thumbnails to reorder; Ctrl/Shift-click to select several for rotate, delete, duplicate or extract.')));
  };
  const deleteAnnot = () => {
    const pg = P.pages[P.cur];
    if (!pg || P.asel < 0) return;
    pg.annots.splice(P.asel, 1);
    P.asel = -1;
    commit(); drawAnnots(); renderAnnotPane(); renderThumbsSoon();
  };

  const renderFormPane = () => {
    const p = $('#pdfFormPane');
    p.textContent = '';
    if (!P.form) { p.append(h('div', { class: 'empty-note' }, P.pages.length ? 'This PDF has no fillable form fields. Use the Text tool to type onto the page instead.' : 'Open a PDF with form fields to fill them in here.')); return; }
    const s = sec(`Form fields (${P.form.fields.length})`);
    for (const f of P.form.fields) {
      const cur = f.name in P.formValues ? P.formValues[f.name] : f.value;
      const set = (v) => { P.formValues[f.name] = v; commit(); };
      let input;
      if (f.type === 'PDFTextField') {
        input = f.multiline ? h('textarea', { rows: 3 }) : h('input', { type: 'text', maxlength: f.max || null });
        input.value = cur || '';
        input.addEventListener('change', () => set(input.value));
      } else if (f.type === 'PDFCheckBox') {
        input = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!cur, onchange: (e) => set(e.target.checked) }), 'Checked');
      } else {
        input = h('select', {}, h('option', { value: '' }, '—'), ...(f.options || []).map((o) => h('option', { value: o, selected: o === cur }, o)));
        input.addEventListener('change', () => set(input.value));
      }
      if (f.readOnly && input.tagName !== 'LABEL') input.disabled = true;
      s.append(h('div', { class: 'form-field' }, h('div', { class: 'fname' }, f.name + (f.readOnly ? ' (read-only)' : '')), input));
    }
    const fl = h('input', { type: 'checkbox', checked: P.flatten });
    fl.addEventListener('change', () => { P.flatten = fl.checked; commit(); });
    s.append(h('div', { class: 'row' }, h('label', { class: 'chk' }, fl, 'Flatten on save (fields become plain, non-editable content)')),
      h('p', { class: 'muted small' }, 'Values are written into the PDF when you save. The page preview shows the original values until then.'));
    p.append(s);
  };

  const renderInfoPane = () => {
    const p = $('#pdfInfoPane');
    p.textContent = '';
    if (!P.pages.length) { p.append(h('div', { class: 'empty-note' }, 'No document open.')); return; }
    const field = (label, key) => {
      const i = h('input', { type: 'text', value: P.meta[key] || '' });
      i.addEventListener('change', () => { P.meta[key] = i.value; commit(); });
      return h('div', { class: 'field' }, label, i);
    };
    p.append(sec('Metadata', field('Title', 'title'), field('Author', 'author'), field('Subject', 'subject'), field('Keywords (comma separated)', 'keywords'),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => { P.meta = { title: '', author: '', subject: '', keywords: '' }; commit(); renderInfoPane(); V.toast('Metadata cleared — saved on next save'); } }, 'Clear all'))));
    const totalAnn = P.pages.reduce((a, pg) => a + pg.annots.length, 0);
    const redPages = P.pages.filter((pg) => pg.annots.some((a) => a.type === 'redact')).length;
    p.append(sec('Document', h('dl', { class: 'kv' },
      h('dt', {}, 'File'), h('dd', {}, P.fileName),
      h('dt', {}, 'Pages'), h('dd', {}, String(P.pages.length)),
      h('dt', {}, 'Sources'), h('dd', {}, P.sources.map((s) => s.name + (s.encrypted ? ' (encrypted)' : '')).join(', ') || '—'),
      h('dt', {}, 'Annotations'), h('dd', {}, String(totalAnn)),
      h('dt', {}, 'Redacted pages'), h('dd', {}, String(redPages)))));
    p.append(sec('About saving', h('p', { class: 'muted small', style: 'margin:0' },
      'Saving keeps the original page content as vector/text. Pages with redactions, and pages from encrypted PDFs, are converted to images. Deleted pages are removed from the file. Nothing leaves this computer.')));
  };

  /* ================================================================ chrome */
  const setTool = (t) => {
    if (t === 'image') { P.placeImage(); return; }
    if (t === 'sign') { P.openSignature(); return; }
    if (t === 'svg') { P.placeSvg(V.ed.getText()); return; }
    finishTextEdit();
    P.tool = t;
    $('#pdfStage').dataset.ptool = t;
    $$('#pdfTools [data-ptool]').forEach((b) => b.classList.toggle('on', b.dataset.ptool === t));
  };
  P.setTool = setTool;

  const updateStatus = () => {
    $('#pdfStatus').textContent = P.pages.length ? `${P.fileName}${P.dirty ? ' •' : ''}` : 'No document';
    $('#pdfUndo').disabled = P.undo.length < 2;
    $('#pdfRedo').disabled = !P.redo.length;
    const has = P.pages.length > 0;
    ['pdfSave', 'pdfAdd', 'pgRotL', 'pgRotR', 'pgDup', 'pgDel', 'pgExtract', 'pgSplit'].forEach((id) => { $('#' + id).disabled = !has; });
  };

  const renderAll = () => {
    renderThumbs();
    renderPage();
    renderAnnotPane();
    renderFormPane();
    renderInfoPane();
    updateStatus();
  };
  P.renderAll = renderAll;

  P.receiveSvg = (text) => {
    if (!P.pages.length) {
      // start a new PDF sized to the drawing
      reset();
      let m;
      try { m = V.svg2pdf.mount(text); } catch (e) { V.toast(e.message, 'err'); return; }
      const { w, h: hh } = V.svg2pdf.measure(m.svg);
      m.unmount();
      P.pages.push({ uid: nuid(), kind: 'blank', rot0: 0, rot: 0, view: [0, 0, w * 0.75, hh * 0.75], annots: [{ type: 'svg', svg: text, x: 0, y: 0, w: w * 0.75, h: hh * 0.75, opacity: 1, rot: 0 }] });
      P.fileName = V.baseName(V.ed.fileName || 'drawing') + '.pdf';
      P.undo = []; P.redo = [];
      commit(true);
      P.dirty = true;
      renderAll();
      V.toast('New PDF created from your drawing (vector). Save it, or open another PDF to add more.');
    } else P.placeSvg(text);
  };

  P.key = (e) => {
    if (editing) return false;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const lk = k.toLowerCase();
      if (lk === 'z' && !e.shiftKey) { P.undoOp(); return true; }
      if ((lk === 'z' && e.shiftKey) || lk === 'y') { P.redoOp(); return true; }
      if (lk === 's') { P.save(e.shiftKey); return true; }
      if (lk === 'o') { openDialog(); return true; }
      if (k === '=' || k === '+') { zoomBy(1.2); return true; }
      if (k === '-') { zoomBy(1 / 1.2); return true; }
      if (k === '0') { P.zoom = null; renderPage(); return true; }
      return false;
    }
    if (!P.pages.length) return false;
    if (k === 'Delete' || k === 'Backspace') {
      if (P.asel >= 0) deleteAnnot();
      else if (document.activeElement === $('#thumbs') || P.sel.size) P.deletePages();
      return true;
    }
    if (k === 'Escape') { P.asel = -1; drawAnnots(); renderAnnotPane(); setTool('select'); return true; }
    if (k === 'PageDown' || (k === 'ArrowDown' && P.asel < 0)) { goTo(P.cur + 1); return true; }
    if (k === 'PageUp' || (k === 'ArrowUp' && P.asel < 0)) { goTo(P.cur - 1); return true; }
    if (k === 'Home') { goTo(0); return true; }
    if (k === 'End') { goTo(P.pages.length - 1); return true; }
    if (k.startsWith('Arrow') && P.asel >= 0) {
      const a = P.pages[P.cur].annots[P.asel];
      const st = (e.shiftKey ? 10 : 1);
      const o = JSON.parse(JSON.stringify(a));
      moveAnn(a, o, k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0, k === 'ArrowUp' ? -st : k === 'ArrowDown' ? st : 0);
      commit(); drawAnnots();
      return true;
    }
    if (k === '+' || k === '=') { zoomBy(1.2); return true; }
    if (k === '-') { zoomBy(1 / 1.2); return true; }
    const tools = { v: 'select', t: 'text', h: 'highlight', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', f: 'ink', w: 'whiteout', x: 'redact' };
    if (tools[k.toLowerCase()] && !e.altKey) { setTool(tools[k.toLowerCase()]); return true; }
    return false;
  };
  const zoomBy = (f) => { P.zoom = V.clamp(scale() * f, 0.1, 8); renderPage(); };

  const openDialog = async () => {
    let files = null;
    if (window.showOpenFilePicker) {
      try {
        const [hdl] = await window.showOpenFilePicker({ types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
        const f = await hdl.getFile();
        await P.openFiles([f]);
        P.fileHandle = hdl;
        return;
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    const f = await V.pickFile('filePdf');
    files = f ? [f] : null;
    if (files) await P.openFiles(files);
  };
  P.openDialog = openDialog;

  P.init = () => {
    if (!pdfjs) { V.toast('PDF library failed to load', 'err'); return; }
    // rotation wrapper around the page
    const rot = h('div', { id: 'pdfRot', style: 'position:relative' });
    const pe = $('#pdfPage');
    pe.parentNode.insertBefore(rot, pe);
    rot.appendChild(pe);
    pe.style.position = 'absolute';

    const ov = overlay();
    ov.addEventListener('pointerdown', onDown);
    ov.addEventListener('pointermove', onMove);
    ov.addEventListener('pointerup', onUp);
    ov.addEventListener('pointercancel', onUp);

    $('#pdfOpen').addEventListener('click', openDialog);
    $('#pdfOpen2').addEventListener('click', openDialog);
    $('#pdfNewBlank').addEventListener('click', () => P.newBlank());
    $('#pdfAdd').addEventListener('click', async () => { const fs = await V.pickFile('filePdfAdd'); if (fs && fs.length) P.openFiles(fs, true); });
    $('#pdfSave').addEventListener('click', () => P.save(false));
    $('#pdfUndo').addEventListener('click', () => P.undoOp());
    $('#pdfRedo').addEventListener('click', () => P.redoOp());
    $('#pdfZoomIn').addEventListener('click', () => zoomBy(1.2));
    $('#pdfZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
    $('#pdfZoomLabel').addEventListener('click', () => { P.fitMode = P.zoom == null && P.fitMode === 'width' ? 'page' : 'width'; P.zoom = null; renderPage(); V.toast(P.fitMode === 'page' ? 'Fit page' : 'Fit width'); });
    $('#pgRotL').addEventListener('click', () => P.rotatePages(-90));
    $('#pgRotR').addEventListener('click', () => P.rotatePages(90));
    $('#pgDup').addEventListener('click', () => P.duplicatePages());
    $('#pgDel').addEventListener('click', () => P.deletePages());
    $('#pgBlank').addEventListener('click', () => P.insertBlank());
    $('#pgExtract').addEventListener('click', () => P.extract());
    $('#pgSplit').addEventListener('click', () => P.split());
    $$('#pdfTools [data-ptool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.ptool)));

    // style controls: defaults + apply to the selected annotation
    const st = P.style;
    const bind = (id, key, conv = (v) => v, prop) => {
      const el = $('#' + id);
      if (el.type === 'checkbox') el.checked = !!st[key]; else el.value = st[key];
      el.addEventListener('change', () => {
        st[key] = el.type === 'checkbox' ? el.checked : conv(el.value);
        V.storage.set('pdfStyle', st);
        const pg = P.pages[P.cur];
        const a = pg && pg.annots[P.asel];
        if (a) {
          const pk = prop || key;
          if (key === 'fillOn' || key === 'fill') { if (a.type === 'rect' || a.type === 'ellipse') a.fill = st.fillOn ? st.fill : null; else if (a.type === 'highlight' && st.fillOn) a.color = st.fill; }
          else if (pk in a) a[pk] = st[key];
          commit(); drawAnnots(); renderAnnotPane();
        }
      });
    };
    bind('pColor', 'color', undefined, 'color');
    bind('pWidth', 'width', (v) => Math.max(0, parseFloat(v) || 1));
    bind('pSize', 'size', (v) => V.clamp(parseFloat(v) || 14, 2, 400));
    bind('pFont', 'font');
    bind('pBold', 'bold');
    bind('pFillOn', 'fillOn');
    bind('pFill', 'fill');

    // side tabs
    $$('#pdfMode .ptabs button').forEach((b) => b.addEventListener('click', () => {
      $$('#pdfMode .ptabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      $$('#pdfMode .ppane').forEach((p) => { p.hidden = p.dataset.qpane !== b.dataset.qtab; });
    }));

    // drag & drop files onto the PDF stage
    const stage = $('#pdfStage');
    stage.addEventListener('dragover', (e) => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); stage.classList.add('dragover'); } });
    stage.addEventListener('dragleave', (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('dragover'); });
    stage.addEventListener('drop', (e) => {
      stage.classList.remove('dragover');
      const fs = Array.from(e.dataTransfer.files || []).filter((f) => /pdf|image\//.test(f.type) || /\.pdf$/i.test(f.name));
      if (!fs.length) return;
      e.preventDefault();
      P.openFiles(fs, P.pages.length > 0);
    });
    const thumbs = $('#thumbs');
    thumbs.addEventListener('dragover', (e) => { if (!thumbDrag && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); });
    thumbs.addEventListener('drop', (e) => {
      if (thumbDrag) return;
      const fs = Array.from(e.dataTransfer.files || []);
      if (fs.length) { e.preventDefault(); P.openFiles(fs, P.pages.length > 0); }
    });
    stage.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.002)); } }, { passive: false });

    // signature dialog
    const pad = $('#sigPad');
    const padPt = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
    pad.addEventListener('pointerdown', (e) => { try { pad.setPointerCapture(e.pointerId); } catch (err) {} sig.cur = [padPt(e)]; sigRedraw(); });
    pad.addEventListener('pointermove', (e) => { if (sig.cur) { sig.cur.push(padPt(e)); sigRedraw(); } });
    const padUp = () => { if (sig.cur) { sig.strokes.push(sig.cur); sig.cur = null; sigRedraw(); } };
    pad.addEventListener('pointerup', padUp); pad.addEventListener('pointercancel', padUp);
    $('#sigClear').addEventListener('click', () => { sig.strokes = []; sigRedraw(); });
    $('#sigSaved').addEventListener('click', () => { const s = V.storage.get('signature', null); if (s) { $('#sigDlg').close('cancel'); placeSig(s); } });
    $('#sigDlg').addEventListener('close', () => {
      if ($('#sigDlg').returnValue !== 'ok') return;
      const s = sigToAnn(sig.strokes);
      if (!s) { V.toast('Draw a signature first'); return; }
      if ($('#sigRemember').checked) V.storage.set('signature', s); else V.storage.del('signature');
      placeSig(s);
    });

    new ResizeObserver(V.debounce(() => { if (V.app.mode === 'pdf' && P.zoom == null) renderPage(); }, 120)).observe(stage);
    setTool('select');
    renderAll();
  };
})(window.V);
