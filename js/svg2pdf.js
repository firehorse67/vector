/* Draw a live SVG element tree onto a pdf-lib page as vector graphics.
   Supports shapes, paths, text (standard PDF fonts), images, groups, <use>, nested <svg>,
   fill/stroke colours and opacity, dashes, caps/joins, transforms.
   Approximates gradients (average colour); ignores filters, masks, clip paths and markers. */
'use strict';
(function (V) {
  const L = () => window.PDFLib;
  const S = V.svg2pdf = {};

  S.viewBoxMatrix = (vb, w, h, par) => {
    // maps viewBox user space -> viewport (w × h)
    if (!vb || !(vb[2] > 0) || !(vb[3] > 0)) return new DOMMatrix();
    const p = String(par || 'xMidYMid meet').trim().split(/\s+/);
    const align = p[0], slice = p[1] === 'slice';
    let sx = w / vb[2], sy = h / vb[3];
    if (align !== 'none') {
      const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
      sx = sy = s;
    }
    let tx = -vb[0] * sx, ty = -vb[1] * sy;
    if (align !== 'none') {
      const ex = w - vb[2] * sx, ey = h - vb[3] * sy;
      if (/xMid/.test(align)) tx += ex / 2; else if (/xMax/.test(align)) tx += ex;
      if (/YMid/.test(align)) ty += ey / 2; else if (/YMax/.test(align)) ty += ey;
    }
    return new DOMMatrix([sx, 0, 0, sy, tx, ty]);
  };
  S.parseViewBox = (el) => {
    const v = (el.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(parseFloat);
    return v.length === 4 && v.every(isFinite) ? v : null;
  };

  const SKIP = new Set(['defs', 'clipPath', 'mask', 'marker', 'pattern', 'linearGradient', 'radialGradient', 'symbol', 'style', 'title', 'desc', 'metadata', 'script', 'filter']);

  const pf = (v, d) => { const x = parseFloat(v); return isFinite(x) ? x : d; };

  S.draw = async (pdfDoc, page, svgRoot, base, opts = {}) => {
    const PL = L();
    const ops = [];
    const warnings = new Set();
    const fonts = opts.fontCache || {};
    const images = new Map();

    const n = (el, a, d = 0) => { const v = parseFloat(el.getAttribute(a)); return isFinite(v) ? v : d; };
    const lenAttr = (el, a, ref, d = 0) => {
      const s = el.getAttribute(a);
      if (s == null) return d;
      if (/%$/.test(s)) return parseFloat(s) / 100 * ref;
      return V.toPx(s, d);
    };

    const getFont = async (family, weight, style) => {
      const fam = String(family || '').toLowerCase();
      let kind = 'Helvetica';
      if (/mono|courier|consolas|menlo|code/.test(fam)) kind = 'Courier';
      else if (/(^|[\s,"'])(serif|times|georgia|garamond|cambria|palatino|book)/.test(fam) && !/sans/.test(fam.split(',')[0])) kind = 'Times';
      const bold = parseInt(weight, 10) >= 600 || weight === 'bold';
      const ital = /italic|oblique/.test(style || '');
      const SF = PL.StandardFonts;
      const map = {
        Helvetica: [SF.Helvetica, SF.HelveticaBold, SF.HelveticaOblique, SF.HelveticaBoldOblique],
        Times: [SF.TimesRoman, SF.TimesRomanBold, SF.TimesRomanItalic, SF.TimesRomanBoldItalic],
        Courier: [SF.Courier, SF.CourierBold, SF.CourierOblique, SF.CourierBoldOblique],
      };
      const name = map[kind][(bold ? 1 : 0) + (ital ? 2 : 0)];
      if (!fonts[name]) {
        const font = await pdfDoc.embedFont(name);
        fonts[name] = { font, set: new Set(font.getCharacterSet()) };
      }
      const f = fonts[name];
      f.keys = f.keys || new Map();
      if (!f.keys.has(page)) f.keys.set(page, page.node.newFontDictionary(f.font.name, f.font.ref));
      return { font: f.font, set: f.set, key: f.keys.get(page) };
    };

    const gsCache = new Map();
    const gs = (fillA, strokeA) => {
      if (fillA >= 0.999 && strokeA >= 0.999) return null;
      const k = fillA.toFixed(3) + '|' + strokeA.toFixed(3);
      if (!gsCache.has(k)) gsCache.set(k, page.maybeEmbedGraphicsState({ opacity: fillA, borderOpacity: strokeA }));
      return gsCache.get(k);
    };

    const paintColor = (val, el) => {
      if (!val || val === 'none') return null;
      const m = /^url\(["']?#([^"')]+)["']?\)/.exec(val);
      if (m) {
        const g = svgRoot.querySelector('#' + CSS.escape(m[1])) || (el.ownerDocument && el.ownerDocument.getElementById(m[1]));
        if (g && /Gradient$/.test(g.localName)) {
          let stops = V.$$('stop', g);
          if (!stops.length) {
            const href = g.getAttribute('href') || g.getAttributeNS(V.XLINK, 'href');
            const g2 = href && svgRoot.querySelector(href);
            if (g2) stops = V.$$('stop', g2);
          }
          if (stops.length) {
            warnings.add('gradients are drawn as a flat average colour');
            const cols = stops.map((s) => V.parseColor(getComputedStyle(s).stopColor || s.getAttribute('stop-color') || '#000')).filter(Boolean);
            if (cols.length) {
              const avg = cols.reduce((a, c) => ({ r: a.r + c.r / cols.length, g: a.g + c.g / cols.length, b: a.b + c.b / cols.length, a: 1 }), { r: 0, g: 0, b: 0 });
              return avg;
            }
          }
        }
        warnings.add('patterns are not supported in vector PDF');
        const fb = /\)\s*(.+)$/.exec(val);
        return fb ? V.parseColor(fb[1]) : null;
      }
      return V.parseColor(val);
    };

    const styleOps = (cs, opacity) => {
      const fill = paintColor(cs.fill);
      const stroke = paintColor(cs.stroke);
      const sw = parseFloat(cs.strokeWidth) || 0;
      const fo = pf(cs.fillOpacity, 1) * (fill ? fill.a : 1) * opacity;
      const so = pf(cs.strokeOpacity, 1) * (stroke ? stroke.a : 1) * opacity;
      const o = [];
      const doFill = !!fill && fo > 0;
      const doStroke = !!stroke && sw > 0 && so > 0;
      const g = gs(doFill ? fo : 1, doStroke ? so : 1);
      if (g) o.push(PL.setGraphicsState(g));
      if (doFill) o.push(PL.setFillingRgbColor(fill.r, fill.g, fill.b));
      if (doStroke) {
        o.push(PL.setStrokingRgbColor(stroke.r, stroke.g, stroke.b), PL.setLineWidth(sw));
        const cap = { butt: 0, round: 1, square: 2 }[cs.strokeLinecap] ?? 0;
        const join = { miter: 0, round: 1, bevel: 2 }[cs.strokeLinejoin] ?? 0;
        o.push(PL.setLineCap(cap), PL.setLineJoin(join));
        const ml = parseFloat(cs.strokeMiterlimit);
        if (isFinite(ml) && ml >= 1) o.push(PL.PDFOperator.of('M', [PL.PDFNumber.of(ml)]));
        if (cs.strokeDasharray && cs.strokeDasharray !== 'none') {
          const arr = cs.strokeDasharray.split(/[\s,]+/).map((x) => parseFloat(x)).filter((x) => isFinite(x) && x >= 0);
          if (arr.length && arr.some((x) => x > 0)) o.push(PL.setDashPattern(arr.length % 2 ? arr.concat(arr) : arr, parseFloat(cs.strokeDashoffset) || 0));
        }
      }
      return { ops: o, doFill, doStroke, evenodd: cs.fillRule === 'evenodd' };
    };

    const pathOps = (segs) => {
      const o = [];
      const flat = V.Path.flattenArcs(segs);
      for (const s of flat) {
        const p = s.p;
        if (s.c === 'M') o.push(PL.moveTo(p[0], p[1]));
        else if (s.c === 'L') o.push(PL.lineTo(p[0], p[1]));
        else if (s.c === 'C') o.push(PL.appendBezierCurve(p[0], p[1], p[2], p[3], p[4], p[5]));
        else if (s.c === 'Q') o.push(PL.appendQuadraticCurve(p[0], p[1], p[2], p[3]));
        else if (s.c === 'Z') o.push(PL.closePath());
      }
      return o;
    };

    const paintOp = (st) => {
      const PO = PL.PDFOperator;
      if (st.doFill && st.doStroke) return st.evenodd ? PO.of('B*') : PL.fillAndStroke();
      if (st.doFill) return st.evenodd ? PO.of('f*') : PL.fill();
      if (st.doStroke) return PL.stroke();
      return PL.endPath();
    };

    const embedImage = async (href) => {
      if (images.has(href)) return images.get(href);
      let img = null;
      try {
        if (/^data:image\/png/i.test(href)) img = await pdfDoc.embedPng(V.dataUrlToBytes(href).bytes);
        else if (/^data:image\/jpe?g/i.test(href)) img = await pdfDoc.embedJpg(V.dataUrlToBytes(href).bytes);
        else if (/^(data:|blob:)/i.test(href)) {
          const im = await V.loadImage(href);
          const c = document.createElement('canvas');
          const sc = Math.min(1, 4096 / Math.max(im.naturalWidth || 1, im.naturalHeight || 1));
          const w = Math.max(1, Math.round((im.naturalWidth || 300) * sc * (/svg/i.test(href.slice(0, 30)) ? 3 : 1)));
          const h = Math.max(1, Math.round((im.naturalHeight || 150) * sc * (/svg/i.test(href.slice(0, 30)) ? 3 : 1)));
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(im, 0, 0, w, h);
          const blob = await V.canvasToBlob(c, 'image/png');
          img = await pdfDoc.embedPng(new Uint8Array(await blob.arrayBuffer()));
        }
      } catch (e) { console.warn(e); }
      if (!img) warnings.add('some images could not be embedded');
      images.set(href, img);
      return img;
    };

    const textChars = (textEl) => {
      // Rendered characters after default whitespace collapsing, each tagged with its parent element.
      const raw = [];
      const preserve = (textEl.getAttribute('xml:space') || textEl.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space')) === 'preserve' ||
        /pre/.test(getComputedStyle(textEl).whiteSpace || '');
      const walk = (node) => {
        for (const k of node.childNodes) {
          if (k.nodeType === 3) for (const ch of k.data) raw.push({ ch, el: node });
          else if (k.nodeType === 1 && (k.localName === 'tspan' || k.localName === 'a' || k.localName === 'textPath')) {
            if (getComputedStyle(k).display === 'none') continue;
            walk(k);
          }
        }
      };
      walk(textEl);
      if (preserve) return raw.map((r) => ({ ch: /\s/.test(r.ch) ? ' ' : r.ch, el: r.el })).filter((r) => r.ch !== '\n');
      const out = [];
      for (const r of raw) {
        if (r.ch === '\n' || r.ch === '\r') continue; // newlines are removed, not spaced, in SVG default mode
        const c = /\s/.test(r.ch) ? ' ' : r.ch;
        if (c === ' ' && (!out.length || out[out.length - 1].ch === ' ')) continue;
        out.push({ ch: c, el: r.el });
      }
      while (out.length && out[out.length - 1].ch === ' ') out.pop();
      return out;
    };

    const drawText = async (el, opacity) => {
      let count = 0;
      try { count = el.getNumberOfChars(); } catch (e) { return; }
      if (!count) return;
      const chars = textChars(el);
      // Astral characters count as two in SVG's char index; expand our list accordingly.
      const units = [];
      for (const c of chars) { units.push(c); if (c.ch.length > 1) units.push(null); }
      const aligned = units.length === count;
      if (!aligned) warnings.add('some text spacing may differ');
      const runs = [];
      for (let i = 0; i < Math.min(count, units.length); i++) {
        const u = units[i];
        if (!u || u.ch === ' ') continue;
        let pos, rot = 0;
        try { pos = el.getStartPositionOfChar(i); rot = el.getRotationOfChar(i) || 0; } catch (e) { continue; }
        runs.push({ ch: u.ch, el: u.el, x: pos.x, y: pos.y, rot });
      }
      if (!aligned && !runs.length) return;
      const o = [PL.beginText()];
      let lastKey = null, lastFill = null, lastGs = null;
      for (const r of runs) {
        const cs = getComputedStyle(r.el);
        const size = parseFloat(cs.fontSize) || 16;
        const f = await getFont(cs.fontFamily, cs.fontWeight, cs.fontStyle);
        const fill = paintColor(cs.fill);
        if (!fill) continue;
        const a = pf(cs.fillOpacity, 1) * fill.a * opacity;
        const g = gs(a, 1);
        if (g !== lastGs && g) { o.push(PL.setGraphicsState(g)); lastGs = g; }
        const fk = fill.r + ',' + fill.g + ',' + fill.b;
        if (fk !== lastFill) { o.push(PL.setFillingRgbColor(fill.r, fill.g, fill.b)); lastFill = fk; }
        const key = f.key + '@' + size;
        if (key !== lastKey) { o.push(PL.setFontAndSize(f.key, size)); lastKey = key; }
        let ch = r.ch;
        if (!f.set.has(ch.codePointAt(0))) { warnings.add('characters outside the standard PDF fonts were replaced with "?"'); ch = '?'; }
        const rad = r.rot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        o.push(PL.setTextMatrix(cos, sin, sin, -cos, r.x, r.y));
        o.push(PL.showText(f.font.encodeText(ch)));
      }
      o.push(PL.endText());
      ops.push(...o);
      warnings.add('text uses standard PDF fonts (Helvetica / Times / Courier)');
    };

    const drawEl = async (el, opacity, depth) => {
      if (depth > 40) return;
      if (el.nodeType !== 1 || el.namespaceURI !== V.NS) return;
      const tag = el.localName;
      if (SKIP.has(tag)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      if (tag === 'foreignObject') { warnings.add('HTML content (foreignObject) is skipped'); return; }
      if (el.getAttribute('clip-path') || (cs.clipPath && cs.clipPath !== 'none')) warnings.add('clip paths are ignored');
      if (el.getAttribute('mask') || (cs.mask && cs.mask !== 'none' && cs.mask !== '')) warnings.add('masks are ignored');
      if (el.getAttribute('filter') || (cs.filter && cs.filter !== 'none')) warnings.add('filters (blur, shadow…) are ignored');
      if (el.getAttribute('marker-start') || el.getAttribute('marker-end') || el.getAttribute('marker-mid')) warnings.add('markers (arrowheads) are ignored');
      const op = opacity * pf(cs.opacity, 1);
      if (op <= 0) return;
      const visible = cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
      ops.push(PL.pushGraphicsState());
      const t = V.elTransform(el);
      if (!V.mIsIdentity(t)) ops.push(PL.concatTransformationMatrix(t.a, t.b, t.c, t.d, t.e, t.f));
      try {
        if (tag === 'g' || tag === 'a' || tag === 'switch') {
          for (const k of el.children) await drawEl(k, op, depth + 1);
          if (tag === 'switch') warnings.add('<switch> drew every branch');
        } else if (tag === 'svg') {
          const x = n(el, 'x'), y = n(el, 'y');
          const w = lenAttr(el, 'width', 100, 100), h = lenAttr(el, 'height', 100, 100);
          const vb = S.parseViewBox(el);
          const m = new DOMMatrix().translate(x, y).multiply(S.viewBoxMatrix(vb, w, h, el.getAttribute('preserveAspectRatio')));
          ops.push(PL.concatTransformationMatrix(m.a, m.b, m.c, m.d, m.e, m.f));
          for (const k of el.children) await drawEl(k, op, depth + 1);
        } else if (tag === 'use') {
          const href = el.getAttribute('href') || el.getAttributeNS(V.XLINK, 'href');
          const ref = href && href.startsWith('#') ? svgRoot.querySelector('#' + CSS.escape(href.slice(1))) : null;
          if (ref) {
            ops.push(PL.concatTransformationMatrix(1, 0, 0, 1, n(el, 'x'), n(el, 'y')));
            if (ref.localName === 'symbol') {
              const vb = S.parseViewBox(ref);
              const w = lenAttr(el, 'width', 100, vb ? vb[2] : 100), h = lenAttr(el, 'height', 100, vb ? vb[3] : 100);
              const m = S.viewBoxMatrix(vb, w, h, ref.getAttribute('preserveAspectRatio'));
              ops.push(PL.concatTransformationMatrix(m.a, m.b, m.c, m.d, m.e, m.f));
              for (const k of ref.children) await drawEl(k, op, depth + 1);
            } else {
              await drawEl(ref, op, depth + 1);
            }
          }
        } else if (tag === 'text') {
          if (visible) await drawText(el, op);
        } else if (tag === 'image') {
          if (visible) {
            const href = el.getAttribute('href') || el.getAttributeNS(V.XLINK, 'href');
            if (href) {
              const img = await embedImage(href);
              if (img) {
                const x = n(el, 'x'), y = n(el, 'y');
                const w = lenAttr(el, 'width', 0, img.width), h = lenAttr(el, 'height', 0, img.height);
                const m = new DOMMatrix().translate(x, y).multiply(S.viewBoxMatrix([0, 0, img.width, img.height], w, h, el.getAttribute('preserveAspectRatio')));
                const name = page.node.newXObject('Image', img.ref);
                const g = gs(op, 1);
                if (g) ops.push(PL.setGraphicsState(g));
                // image space: unit square, y-up -> our y-down user space
                ops.push(PL.concatTransformationMatrix(m.a, m.b, m.c, m.d, m.e, m.f));
                ops.push(PL.concatTransformationMatrix(img.width, 0, 0, -img.height, 0, img.height));
                ops.push(PL.drawObject(name));
              }
            }
          }
        } else {
          const segs = V.Path.fromElement(el);
          if (segs && segs.length && visible) {
            const st = styleOps(cs, op);
            if (tag === 'line' || tag === 'polyline') st.doFill = st.doFill && tag === 'polyline';
            if (st.doFill || st.doStroke) {
              ops.push(...st.ops, ...pathOps(segs), paintOp(st));
            }
          }
        }
      } finally {
        ops.push(PL.popGraphicsState());
      }
    };

    ops.push(PL.pushGraphicsState(), PL.concatTransformationMatrix(base.a, base.b, base.c, base.d, base.e, base.f));
    for (const k of svgRoot.children) await drawEl(k, 1, 0);
    ops.push(PL.popGraphicsState());
    page.pushOperators(...ops);
    return { warnings: Array.from(warnings) };
  };

  /* Mount SVG markup off-screen so computed styles and text metrics are available. */
  S.mount = (svgText) => {
    const { svg, warnings } = V.parseSvgText(svgText);
    const host = V.h('div', { style: 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;opacity:0;pointer-events:none' });
    host.appendChild(svg);
    document.body.appendChild(host);
    return { svg, warnings, unmount: () => host.remove() };
  };

  /* Size of an SVG in px and its viewBox. */
  S.measure = (svg) => {
    const vb = S.parseViewBox(svg);
    const w = V.toPx(svg.getAttribute('width'), vb ? vb[2] : 300);
    const h = V.toPx(svg.getAttribute('height'), vb ? vb[3] : 150);
    return { w, h, vb: vb || [0, 0, w, h] };
  };

  /* Whole SVG text -> PDF bytes (one page at the drawing's physical size). */
  S.svgToPdf = async (svgText, meta = {}) => {
    const PL = L();
    const m = S.mount(svgText);
    try {
      const { w, h, vb } = S.measure(m.svg);
      const pw = w * 0.75, ph = h * 0.75; // px -> pt
      const doc = await PL.PDFDocument.create();
      const page = doc.addPage([pw, ph]);
      const base = new DOMMatrix([1, 0, 0, -1, 0, ph]).scale(0.75, 0.75).multiply(S.viewBoxMatrix(vb, w, h, m.svg.getAttribute('preserveAspectRatio')));
      const res = await S.draw(doc, page, m.svg, base);
      if (meta.title) doc.setTitle(meta.title);
      doc.setCreator('Vector');
      doc.setProducer('Vector (pdf-lib)');
      return { bytes: await doc.save(), warnings: res.warnings };
    } finally { m.unmount(); }
  };
})(window.V);
