/* Path data: parse to absolute segments, transform, serialise, convert shapes to paths. */
'use strict';
(function (V) {
  const P = V.Path = {};
  const ARGC = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

  /* Tokenise + parse into raw commands (relative/absolute as written). */
  P.parseRaw = (d) => {
    const out = [];
    const s = String(d || '');
    let i = 0;
    const n = s.length;
    const isWs = (c) => c === ' ' || c === ',' || c === '\n' || c === '\r' || c === '\t' || c === '\f';
    const skip = () => { while (i < n && isWs(s[i])) i++; };
    const num = () => {
      skip();
      const start = i;
      if (s[i] === '+' || s[i] === '-') i++;
      let digits = false;
      while (i < n && s[i] >= '0' && s[i] <= '9') { i++; digits = true; }
      if (s[i] === '.') { i++; while (i < n && s[i] >= '0' && s[i] <= '9') { i++; digits = true; } }
      if (!digits) { i = start; return null; }
      if (s[i] === 'e' || s[i] === 'E') {
        const save = i;
        i++;
        if (s[i] === '+' || s[i] === '-') i++;
        let ed = false;
        while (i < n && s[i] >= '0' && s[i] <= '9') { i++; ed = true; }
        if (!ed) i = save;
      }
      return parseFloat(s.slice(start, i));
    };
    const flag = () => {
      skip();
      if (s[i] === '0' || s[i] === '1') return s[i++] === '1' ? 1 : 0;
      return null;
    };
    let cmd = null;
    while (true) {
      skip();
      if (i >= n) break;
      const ch = s[i];
      if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) { cmd = ch; i++; }
      else if (cmd == null) break; // garbage
      const up = cmd.toUpperCase();
      if (up === 'Z') { out.push({ c: cmd, p: [] }); cmd = null; continue; }
      const argc = ARGC[up];
      const args = [];
      for (let k = 0; k < argc; k++) {
        const v = (up === 'A' && (k === 3 || k === 4)) ? flag() : num();
        if (v == null) return out; // malformed: stop (SVG renders up to the error)
        args.push(v);
      }
      out.push({ c: cmd, p: args });
      // implicit repeat: M -> L
      if (cmd === 'M') cmd = 'L'; else if (cmd === 'm') cmd = 'l';
    }
    return out;
  };

  /* Convert to absolute M, L, C, Q, A, Z only. */
  P.parse = (d) => {
    const raw = P.parseRaw(d);
    const out = [];
    let cx = 0, cy = 0, sx = 0, sy = 0;
    let lastC = null, lastQ = null; // reflected control points
    for (const { c, p } of raw) {
      const rel = c === c.toLowerCase();
      const up = c.toUpperCase();
      const ox = rel ? cx : 0, oy = rel ? cy : 0;
      let seg;
      switch (up) {
        case 'M': cx = p[0] + ox; cy = p[1] + oy; sx = cx; sy = cy; seg = { c: 'M', p: [cx, cy] }; lastC = lastQ = null; break;
        case 'L': cx = p[0] + ox; cy = p[1] + oy; seg = { c: 'L', p: [cx, cy] }; lastC = lastQ = null; break;
        case 'H': cx = p[0] + (rel ? cx : 0); seg = { c: 'L', p: [cx, cy] }; lastC = lastQ = null; break;
        case 'V': cy = p[0] + (rel ? cy : 0); seg = { c: 'L', p: [cx, cy] }; lastC = lastQ = null; break;
        case 'C': {
          const a = [p[0] + ox, p[1] + oy, p[2] + ox, p[3] + oy, p[4] + ox, p[5] + oy];
          seg = { c: 'C', p: a }; lastC = [a[2], a[3]]; lastQ = null; cx = a[4]; cy = a[5]; break;
        }
        case 'S': {
          const r = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy];
          const a = [r[0], r[1], p[0] + ox, p[1] + oy, p[2] + ox, p[3] + oy];
          seg = { c: 'C', p: a }; lastC = [a[2], a[3]]; lastQ = null; cx = a[4]; cy = a[5]; break;
        }
        case 'Q': {
          const a = [p[0] + ox, p[1] + oy, p[2] + ox, p[3] + oy];
          seg = { c: 'Q', p: a }; lastQ = [a[0], a[1]]; lastC = null; cx = a[2]; cy = a[3]; break;
        }
        case 'T': {
          const r = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
          const a = [r[0], r[1], p[0] + ox, p[1] + oy];
          seg = { c: 'Q', p: a }; lastQ = [a[0], a[1]]; lastC = null; cx = a[2]; cy = a[3]; break;
        }
        case 'A': {
          const a = [Math.abs(p[0]), Math.abs(p[1]), p[2], p[3], p[4], p[5] + ox, p[6] + oy];
          seg = { c: 'A', p: a }; lastC = lastQ = null; cx = a[5]; cy = a[6]; break;
        }
        case 'Z': seg = { c: 'Z', p: [] }; cx = sx; cy = sy; lastC = lastQ = null; break;
      }
      out.push(seg);
    }
    return out;
  };

  P.endPoint = (seg) => {
    const p = seg.p;
    switch (seg.c) {
      case 'M': case 'L': return [p[0], p[1]];
      case 'C': return [p[4], p[5]];
      case 'Q': return [p[2], p[3]];
      case 'A': return [p[5], p[6]];
      default: return null;
    }
  };

  P.serialize = (segs, dp = 3) => {
    const f = (n) => V.fmt(n, dp);
    let out = '';
    let prev = null;
    for (const s of segs) {
      if (s.c === 'Z') { out += 'Z'; prev = 'Z'; continue; }
      const nums = s.c === 'A'
        ? [f(s.p[0]), f(s.p[1]), f(s.p[2]), s.p[3] ? 1 : 0, s.p[4] ? 1 : 0, f(s.p[5]), f(s.p[6])]
        : s.p.map(f);
      const body = nums.join(' ').replace(/ -/g, '-');
      if (prev === s.c && s.c !== 'M') out += (body[0] === '-' ? '' : ' ') + body;
      else out += s.c + body;
      prev = s.c;
    }
    return out;
  };

  /* Arc to cubic beziers (endpoint parameterisation, SVG spec F.6). */
  P.arcToCubics = (x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) => {
    if (x1 === x2 && y1 === y2) return [];
    if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
    const phi = phiDeg * Math.PI / 180;
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
    rx = Math.abs(rx); ry = Math.abs(ry);
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
    const rx2 = rx * rx, ry2 = ry * ry;
    let num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
    if (num < 0) num = 0;
    let coef = Math.sqrt(num / (rx2 * y1p * y1p + ry2 * x1p * x1p));
    if (fa === fs) coef = -coef;
    const cxp = coef * (rx * y1p / ry), cyp = coef * (-ry * x1p / rx);
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
    const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => {
      const dot = ux * vx + uy * vy, len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      let a = Math.acos(V.clamp(dot / len, -1, 1));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    };
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI;
    if (fs && dt < 0) dt += 2 * Math.PI;
    const nseg = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
    const d = dt / nseg;
    const k = 4 / 3 * Math.tan(d / 4);
    const res = [];
    let t = t1;
    const pt = (a) => {
      const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
      return [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy];
    };
    const der = (a) => {
      const ex = -rx * Math.sin(a), ey = ry * Math.cos(a);
      return [cos * ex - sin * ey, sin * ex + cos * ey];
    };
    for (let i = 0; i < nseg; i++) {
      const p0 = pt(t), p3 = pt(t + d), d0 = der(t), d3 = der(t + d);
      res.push([p0[0] + k * d0[0], p0[1] + k * d0[1], p3[0] - k * d3[0], p3[1] - k * d3[1], p3[0], p3[1]]);
      t += d;
    }
    if (res.length) { res[res.length - 1][4] = x2; res[res.length - 1][5] = y2; }
    return res;
  };

  /* Replace arcs by cubics so the path can take any affine transform. */
  P.flattenArcs = (segs) => {
    const out = [];
    let cx = 0, cy = 0, sx = 0, sy = 0;
    for (const s of segs) {
      if (s.c === 'A') {
        const [rx, ry, rot, fa, fs, x, y] = s.p;
        for (const c of P.arcToCubics(cx, cy, rx, ry, rot, fa, fs, x, y)) out.push({ c: 'C', p: c });
        cx = x; cy = y;
        continue;
      }
      out.push({ c: s.c, p: s.p.slice() });
      if (s.c === 'M') { cx = s.p[0]; cy = s.p[1]; sx = cx; sy = cy; }
      else if (s.c === 'Z') { cx = sx; cy = sy; }
      else { const e = P.endPoint(s); cx = e[0]; cy = e[1]; }
    }
    return out;
  };

  P.hasArcs = (segs) => segs.some((s) => s.c === 'A');

  P.transform = (segs, m) => {
    const src = P.hasArcs(segs) ? P.flattenArcs(segs) : segs;
    return src.map((s) => {
      if (s.c === 'Z') return { c: 'Z', p: [] };
      const p = s.p.slice();
      for (let i = 0; i < p.length; i += 2) {
        const q = V.apply(m, p[i], p[i + 1]);
        p[i] = q.x; p[i + 1] = q.y;
      }
      return { c: s.c, p };
    });
  };

  /* Shape element -> absolute path segments in the element's own coordinates. */
  P.fromElement = (el) => {
    const n = (a, d = 0) => { const v = parseFloat(el.getAttribute(a)); return isFinite(v) ? v : d; };
    switch (el.localName) {
      case 'path': return P.parse(el.getAttribute('d'));
      case 'rect': {
        const x = n('x'), y = n('y'), w = n('width'), h = n('height');
        let rx = el.hasAttribute('rx') ? n('rx') : NaN, ry = el.hasAttribute('ry') ? n('ry') : NaN;
        if (isNaN(rx)) rx = isNaN(ry) ? 0 : ry;
        if (isNaN(ry)) ry = rx;
        rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
        if (!rx || !ry) return P.parse(`M${x} ${y}H${x + w}V${y + h}H${x}Z`);
        return P.parse(`M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`);
      }
      case 'circle': case 'ellipse': {
        const cx = n('cx'), cy = n('cy');
        const rx = el.localName === 'circle' ? n('r') : n('rx'), ry = el.localName === 'circle' ? n('r') : n('ry');
        return P.ellipse(cx, cy, rx, ry);
      }
      case 'line': return P.parse(`M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`);
      case 'polyline': case 'polygon': {
        const pts = P.parsePoints(el.getAttribute('points'));
        if (!pts.length) return [];
        let d = 'M' + pts.map((q) => q.join(' ')).join('L');
        if (el.localName === 'polygon') d += 'Z';
        return P.parse(d);
      }
    }
    return null;
  };

  /* Ellipse as 4 cubic beziers (exactly transformable, editable). */
  P.ellipse = (cx, cy, rx, ry) => {
    const k = 0.5522847498;
    const ox = rx * k, oy = ry * k;
    return [
      { c: 'M', p: [cx + rx, cy] },
      { c: 'C', p: [cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry] },
      { c: 'C', p: [cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy] },
      { c: 'C', p: [cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry] },
      { c: 'C', p: [cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy] },
      { c: 'Z', p: [] },
    ];
  };

  P.parsePoints = (s) => {
    const nums = String(s || '').trim().split(/[\s,]+/).map(parseFloat).filter((v) => isFinite(v));
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    return pts;
  };
  P.pointsToString = (pts, dp = 3) => pts.map((p) => V.fmt(p[0], dp) + ',' + V.fmt(p[1], dp)).join(' ');

  /* Regular polygon / star points inside a box. */
  P.polygonPoints = (cx, cy, rx, ry, sides) => {
    const pts = [];
    for (let i = 0; i < sides; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
      pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
    return pts;
  };
  P.starPoints = (cx, cy, rx, ry, points, inner) => {
    const pts = [];
    for (let i = 0; i < points * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      const r = i % 2 ? inner : 1;
      pts.push([cx + rx * r * Math.cos(a), cy + ry * r * Math.sin(a)]);
    }
    return pts;
  };

  /* Ramer–Douglas–Peucker simplification. */
  P.simplify = (pts, tol) => {
    if (pts.length < 3) return pts.slice();
    const sq = tol * tol;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0, idx = -1;
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i++) {
        const [px, py] = pts[i];
        let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = V.clamp(t, 0, 1);
        const ex = ax + t * dx - px, ey = ay + t * dy - py;
        const d = ex * ex + ey * ey;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > sq && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  };

  /* Smooth polyline -> cubic path (Catmull-Rom). */
  P.smoothPath = (pts, closed = false) => {
    if (pts.length < 2) return [];
    const segs = [{ c: 'M', p: [pts[0][0], pts[0][1]] }];
    if (pts.length === 2) { segs.push({ c: 'L', p: [pts[1][0], pts[1][1]] }); return segs; }
    const n = pts.length;
    const get = (i) => closed ? pts[(i + n) % n] : pts[V.clamp(i, 0, n - 1)];
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      segs.push({ c: 'C', p: [
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1],
      ] });
    }
    if (closed) segs.push({ c: 'Z', p: [] });
    return segs;
  };

  /* Split cubic at t (de Casteljau). */
  P.splitCubic = (x0, y0, c, t) => {
    const [x1, y1, x2, y2, x3, y3] = c;
    const l = (a, b) => a + (b - a) * t;
    const ax = l(x0, x1), ay = l(y0, y1), bx = l(x1, x2), by = l(y1, y2), cx = l(x2, x3), cy = l(y2, y3);
    const dx = l(ax, bx), dy = l(ay, by), ex = l(bx, cx), ey = l(by, cy);
    const fx = l(dx, ex), fy = l(dy, ey);
    return [[ax, ay, dx, dy, fx, fy], [ex, ey, cx, cy, x3, y3]];
  };
  P.splitQuad = (x0, y0, q, t) => {
    const [x1, y1, x2, y2] = q;
    const l = (a, b) => a + (b - a) * t;
    const ax = l(x0, x1), ay = l(y0, y1), bx = l(x1, x2), by = l(y1, y2);
    const cx = l(ax, bx), cy = l(ay, by);
    return [[ax, ay, cx, cy], [bx, by, x2, y2]];
  };
})(window.V);
