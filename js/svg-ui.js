/* SVG editor UI: panels, tool options, export, files, keyboard. */
'use strict';
(function (V) {
  const { $, $$, h, fmt, icon, ed } = V;
  const UI = V.svgUI = {};
  const FONTS = [
    ['system-ui, sans-serif', 'System sans'], ['Arial, Helvetica, sans-serif', 'Arial / Helvetica'], ['Georgia, serif', 'Georgia'],
    ['"Times New Roman", Times, serif', 'Times'], ['Verdana, sans-serif', 'Verdana'], ['"Trebuchet MS", sans-serif', 'Trebuchet'],
    ['"Courier New", Courier, monospace', 'Courier'], ['ui-monospace, monospace', 'Monospace'], ['Impact, sans-serif', 'Impact'], ['cursive', 'Cursive'],
  ];
  const TAGNAMES = { rect: 'Rectangle', circle: 'Circle', ellipse: 'Ellipse', line: 'Line', polyline: 'Polyline', polygon: 'Polygon', path: 'Path', text: 'Text', image: 'Image', g: 'Group', use: 'Symbol instance', a: 'Link', svg: 'Nested SVG', foreignObject: 'HTML' };

  /* ------------------------------------------------------------ paint helpers */
  const getPaint = (el, prop) => {
    const a = el.style.getPropertyValue(prop) || el.getAttribute(prop);
    if (a) return a.trim();
    return getComputedStyle(el)[prop === 'fill' ? 'fill' : 'stroke'];
  };
  const setAttr = (el, name, val) => {
    if (el.style && el.style.getPropertyValue(name)) el.style.removeProperty(name);
    if (el.getAttribute('style') === '') el.removeAttribute('style');
    if (val == null || val === '') el.removeAttribute(name); else el.setAttribute(name, val);
  };
  const ensureDefs = () => {
    let d = ed.doc.querySelector(':scope > defs');
    if (!d) { d = V.svgEl('defs'); ed.doc.insertBefore(d, ed.doc.firstChild); }
    return d;
  };
  const gradOf = (val) => {
    const m = /^url\(["']?#([^"')]+)["']?\)/.exec(val || '');
    if (!m) return null;
    const g = ed.doc.querySelector('#' + CSS.escape(m[1]));
    return g && /Gradient$/.test(g.localName) ? g : null;
  };
  const makeGradient = (kind, c1, c2, angle = 90) => {
    const id = V.uid('grad-');
    const g = V.svgEl(kind === 'radial' ? 'radialGradient' : 'linearGradient', { id }, ensureDefs());
    if (kind !== 'radial') setGradAngle(g, angle);
    V.svgEl('stop', { offset: '0', 'stop-color': c1 }, g);
    V.svgEl('stop', { offset: '1', 'stop-color': c2 }, g);
    return g;
  };
  const setGradAngle = (g, angle) => {
    const a = (angle - 90) * Math.PI / 180;
    const x = Math.cos(a) / 2, y = Math.sin(a) / 2;
    g.setAttribute('x1', fmt(0.5 - x, 4)); g.setAttribute('y1', fmt(0.5 - y, 4));
    g.setAttribute('x2', fmt(0.5 + x, 4)); g.setAttribute('y2', fmt(0.5 + y, 4));
  };
  const gradAngle = (g) => {
    const n = (a, d) => { const v = parseFloat(g.getAttribute(a)); return isFinite(v) ? v : d; };
    return Math.round(Math.atan2(n('y2', 0) - n('y1', 0), n('x2', 1) - n('x1', 0)) * 180 / Math.PI + 90);
  };

  /* ------------------------------------------------------------ properties panel */
  let refreshers = [];
  const pane = () => $('#propsPane');
  const sec = (title, ...kids) => h('div', { class: 'sec' }, h('h4', {}, title), ...kids);
  const numIn = (get, set, opts = {}) => {
    const i = h('input', { type: 'number', step: opts.step || 'any', min: opts.min, max: opts.max, title: opts.title });
    const r = () => { if (document.activeElement !== i) { const v = get(); i.value = v == null || v === '' ? '' : fmt(v, opts.dp ?? 2); } };
    r(); refreshers.push(r);
    i.addEventListener('change', () => { const v = parseFloat(i.value); if (isFinite(v)) set(v); });
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { i.blur(); } });
    return i;
  };
  const labeled = (lbl, input) => h('label', {}, lbl, input);
  const btn = (ic, title, fn, opts = {}) => {
    const b = h('button', { class: 'icon-btn', title, type: 'button', onclick: fn, disabled: opts.disabled });
    if (ic.startsWith('i-')) b.append(icon(ic)); else b.innerHTML = ic;
    return b;
  };
  const ALIGN_SVG = {
    left: '<svg viewBox="0 0 24 24"><path d="M4 3v18M8 7h10v4H8zM8 14h6v4H8z"/></svg>',
    hcenter: '<svg viewBox="0 0 24 24"><path d="M12 3v18M6 7h12v4H6zM8 14h8v4H8z"/></svg>',
    right: '<svg viewBox="0 0 24 24"><path d="M20 3v18M6 7h10v4H6zM10 14h6v4h-6z"/></svg>',
    top: '<svg viewBox="0 0 24 24"><path d="M3 4h18M7 8v10h4V8zM14 8v6h4V8z"/></svg>',
    vcenter: '<svg viewBox="0 0 24 24"><path d="M3 12h18M7 6v12h4V6zM14 8v8h4V8z"/></svg>',
    bottom: '<svg viewBox="0 0 24 24"><path d="M3 20h18M7 6v10h4V6zM14 10v6h4v-6z"/></svg>',
    disth: '<svg viewBox="0 0 24 24"><path d="M3 4v16M21 4v16M9 8h6v8H9z"/></svg>',
    distv: '<svg viewBox="0 0 24 24"><path d="M4 3h16M4 21h16M8 9v6h8V9z"/></svg>',
    front: '<svg viewBox="0 0 24 24"><path d="M8 8h12v12H8z" fill="currentColor"/><path d="M4 4h10v2M4 4v10h2"/></svg>',
    forward: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    backward: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M4 4h12v12H4z" fill="currentColor"/><path d="M10 20h10V10"/></svg>',
    fliph: '<svg viewBox="0 0 24 24"><path d="M12 3v18M9 6L3 18h6zM15 6l6 12h-6z"/></svg>',
    flipv: '<svg viewBox="0 0 24 24"><path d="M3 12h18M6 9L18 3v6zM6 15l12 6v-6z"/></svg>',
    group: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2"/><rect x="7" y="7" width="5" height="5"/><circle cx="15" cy="15" r="3"/></svg>',
    ungroup: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7"/><circle cx="16.5" cy="16.5" r="3.5"/></svg>',
    topath: '<svg viewBox="0 0 24 24"><path d="M4 18C8 6 16 18 20 6"/><rect x="2.5" y="16.5" width="3" height="3"/><rect x="18.5" y="4.5" width="3" height="3"/></svg>',
  };

  const paintControl = (els, prop) => {
    const el = els[0];
    const wrap = h('div', {});
    const typeSel = h('select', {}, h('option', { value: 'none' }, 'None'), h('option', { value: 'solid' }, 'Colour'),
      ...(prop === 'fill' ? [h('option', { value: 'linear' }, 'Linear'), h('option', { value: 'radial' }, 'Radial')] : []));
    const color = h('input', { type: 'color' });
    const hex = h('input', { type: 'text', spellcheck: false, title: 'Colour (any CSS colour)' });
    const row1 = h('div', { class: 'paint' }, typeSel, color, hex);
    const gradRow = h('div', { class: 'paint' });
    const opIn = h('input', { type: 'range', min: 0, max: 1, step: 0.01 });
    const opNum = h('span', { class: 'muted small' });
    const opRow = h('div', { class: 'paint' }, h('span', { class: 'muted small' }, 'Opacity'), opIn, opNum);
    wrap.append(row1, gradRow, opRow);
    const opAttr = prop + '-opacity';

    const state = () => {
      const v = getPaint(el, prop);
      const g = gradOf(v);
      if (g) return { type: g.localName === 'radialGradient' ? 'radial' : 'linear', g };
      if (!v || v === 'none') return { type: 'none' };
      return { type: 'solid', color: v };
    };
    const refresh = () => {
      const s = state();
      if (document.activeElement !== typeSel) typeSel.value = s.type;
      color.hidden = hex.hidden = s.type !== 'solid';
      if (s.type === 'solid') {
        const hx = V.toHex(s.color) || '#000000';
        if (document.activeElement !== color) color.value = hx;
        if (document.activeElement !== hex) hex.value = s.color.startsWith('rgb') ? hx : s.color;
      }
      gradRow.hidden = !s.g;
      if (s.g && !gradRow.contains(document.activeElement)) {
        gradRow.textContent = '';
        const stops = $$('stop', s.g);
        const s1 = stops[0], s2 = stops[stops.length - 1];
        const mk = (stop) => {
          const c = h('input', { type: 'color', value: V.toHex(stop.getAttribute('stop-color') || getComputedStyle(stop).stopColor) || '#000000', title: 'Stop colour' });
          c.addEventListener('input', () => { stop.setAttribute('stop-color', c.value); stop.style.removeProperty('stop-color'); });
          c.addEventListener('change', () => ed.commit());
          return c;
        };
        gradRow.append(h('span', { class: 'muted small' }, 'Stops'), s1 ? mk(s1) : '', s2 && s2 !== s1 ? mk(s2) : '');
        if (s.type === 'linear') {
          const ang = h('input', { type: 'number', value: gradAngle(s.g), step: 15, title: 'Angle (°)', style: 'width:56px' });
          ang.addEventListener('change', () => { setGradAngle(s.g, parseFloat(ang.value) || 0); s.g.removeAttribute('gradientTransform'); ed.commit(); });
          gradRow.append(h('span', { class: 'muted small' }, '∠'), ang);
        }
      }
      const op = parseFloat(el.getAttribute(opAttr) ?? getComputedStyle(el)[prop === 'fill' ? 'fillOpacity' : 'strokeOpacity']);
      if (document.activeElement !== opIn) opIn.value = isFinite(op) ? op : 1;
      opNum.textContent = Math.round((isFinite(op) ? op : 1) * 100) + '%';
      opRow.hidden = s.type === 'none';
    };
    refresh(); refreshers.push(refresh);

    typeSel.addEventListener('change', () => {
      const t = typeSel.value;
      const cur = state();
      const base = cur.type === 'solid' ? (V.toHex(cur.color) || '#4f8cff') : (prop === 'fill' ? ed.defFill : ed.defStroke);
      for (const e of els) {
        if (t === 'none') setAttr(e, prop, 'none');
        else if (t === 'solid') setAttr(e, prop, base);
        else {
          const g = makeGradient(t, base, '#ffffff');
          setAttr(e, prop, `url(#${g.id})`);
        }
        if (prop === 'stroke' && t !== 'none' && !e.getAttribute('stroke-width')) e.setAttribute('stroke-width', ed.opts.strokeWidth || 2);
      }
      ed.commit();
    });
    color.addEventListener('input', () => { for (const e of els) setAttr(e, prop, color.value); hex.value = color.value; });
    color.addEventListener('change', () => ed.commit());
    hex.addEventListener('change', () => {
      const v = hex.value.trim();
      if (!v) return;
      if (!V.parseColor(v) && v !== 'currentColor') { V.toast('Not a colour: ' + v, 'err'); return; }
      for (const e of els) setAttr(e, prop, v);
      ed.commit();
    });
    opIn.addEventListener('input', () => { for (const e of els) setAttr(e, opAttr, +opIn.value >= 1 ? null : opIn.value); opNum.textContent = Math.round(opIn.value * 100) + '%'; });
    opIn.addEventListener('change', () => ed.commit());
    return wrap;
  };

  const selectIn = (options, get, set) => {
    const s = h('select', {}, ...options.map(([v, l]) => h('option', { value: v }, l)));
    const r = () => { if (document.activeElement !== s) { const v = get(); s.value = options.some(([o]) => o === v) ? v : options[0][0]; } };
    r(); refreshers.push(r);
    s.addEventListener('change', () => set(s.value));
    return s;
  };
  const attrSetter = (els, name, transform) => (v) => { for (const e of els) setAttr(e, name, transform ? transform(v, e) : v); ed.commit(); };

  UI.renderProps = () => {
    const p = pane();
    refreshers = [];
    p.textContent = '';
    if (ed.node) return renderNodeProps(p);
    const sel = ed.sel.filter((e) => ed.doc.contains(e));
    if (!sel.length) return renderDocProps(p);
    const el = sel[0];
    const multi = sel.length > 1;
    const tag = el.localName;

    // header
    const idIn = h('input', { type: 'text', placeholder: 'id', value: el.getAttribute('id') || '', disabled: multi, spellcheck: false });
    idIn.addEventListener('change', () => {
      const v = idIn.value.trim().replace(/\s+/g, '-');
      if (v && ed.doc.querySelector('#' + CSS.escape(v)) && ed.doc.querySelector('#' + CSS.escape(v)) !== el) { V.toast('That id is already used', 'err'); return; }
      setAttr(el, 'id', v || null); ed.commit();
    });
    p.append(h('div', { class: 'sec' }, h('h4', {}, multi ? `${sel.length} objects` : (TAGNAMES[tag] || '<' + tag + '>'), h('span', { class: 'spacer' }),
      ed.ctx !== ed.doc ? h('button', { class: 'btn sm', type: 'button', onclick: () => ed.escape() }, 'Leave group') : ''), multi ? '' : h('div', { class: 'row' }, h('label', {}, 'ID'), idIn)));

    // geometry
    const bb = () => ed.unionBBox(sel) || { x: 0, y: 0, width: 0, height: 0 };
    const g2 = h('div', { class: 'grid2' },
      labeled('X', numIn(() => bb().x, (v) => { const b = bb(); ed.setBBox(v, b.y, b.width, b.height); })),
      labeled('Y', numIn(() => bb().y, (v) => { const b = bb(); ed.setBBox(b.x, v, b.width, b.height); })),
      labeled('W', numIn(() => bb().width, (v) => { const b = bb(); ed.setBBox(b.x, b.y, Math.max(v, 0.01), lock.checked ? b.height * (v / (b.width || 1)) : b.height); }, { min: 0 })),
      labeled('H', numIn(() => bb().height, (v) => { const b = bb(); ed.setBBox(b.x, b.y, lock.checked ? b.width * (v / (b.height || 1)) : b.width, Math.max(v, 0.01)); }, { min: 0 })),
    );
    const lock = h('input', { type: 'checkbox', checked: V.storage.get('lockRatio', false) });
    lock.addEventListener('change', () => V.storage.set('lockRatio', lock.checked));
    const geo = sec('Position & size', g2, h('div', { class: 'row' }, h('label', { class: 'chk' }, lock, 'Keep proportions')));
    if (!multi) {
      const rot = numIn(() => { const m = ed.localToDoc(el); return m ? V.mDecompose(m).angle : 0; }, (v) => ed.setRotation(v), { step: 1, dp: 1, title: 'Rotation (°)' });
      geo.append(h('div', { class: 'row' }, h('label', {}, 'Rotate'), rot, h('span', { class: 'muted' }, '°'),
        btn('i-rotl', 'Rotate −90°', () => ed.rotateSel(-90)), btn('i-rotr', 'Rotate +90°', () => ed.rotateSel(90)),
        btn(ALIGN_SVG.fliph, 'Flip horizontally', () => ed.flip('h')), btn(ALIGN_SVG.flipv, 'Flip vertically', () => ed.flip('v'))));
    } else {
      geo.append(h('div', { class: 'row' }, btn('i-rotl', 'Rotate −90°', () => ed.rotateSel(-90)), btn('i-rotr', 'Rotate +90°', () => ed.rotateSel(90)),
        btn(ALIGN_SVG.fliph, 'Flip horizontally', () => ed.flip('h')), btn(ALIGN_SVG.flipv, 'Flip vertically', () => ed.flip('v'))));
    }
    if (tag === 'rect' && !multi) {
      geo.append(h('div', { class: 'row' }, h('label', {}, 'Corner'), numIn(() => parseFloat(el.getAttribute('rx')) || 0, (v) => { setAttr(el, 'rx', v > 0 ? fmt(v) : null); setAttr(el, 'ry', null); ed.commit(); }, { min: 0 })));
    }
    p.append(geo);

    // text
    if (tag === 'text' && !multi) {
      const ta = h('textarea', { rows: 3, spellcheck: true });
      const rt = () => { if (document.activeElement !== ta) ta.value = ed.getTextLines(el); };
      rt(); refreshers.push(rt);
      ta.addEventListener('input', () => { ed.setTextLines(el, ta.value); ed.redraw(); });
      ta.addEventListener('change', () => ed.commit());
      const fam = h('input', { type: 'text', list: 'fontList', spellcheck: false });
      const rf = () => { if (document.activeElement !== fam) fam.value = el.getAttribute('font-family') || getComputedStyle(el).fontFamily; };
      rf(); refreshers.push(rf);
      fam.addEventListener('change', () => { setAttr(el, 'font-family', fam.value); ed.commit(); });
      const bold = h('input', { type: 'checkbox' }), ital = h('input', { type: 'checkbox' });
      const rb = () => { const cs = getComputedStyle(el); bold.checked = parseInt(cs.fontWeight, 10) >= 600; ital.checked = /italic/.test(cs.fontStyle); };
      rb(); refreshers.push(rb);
      bold.addEventListener('change', () => { setAttr(el, 'font-weight', bold.checked ? 'bold' : null); ed.commit(); });
      ital.addEventListener('change', () => { setAttr(el, 'font-style', ital.checked ? 'italic' : null); ed.commit(); });
      p.append(sec('Text',
        h('div', { class: 'field' }, ta),
        h('div', { class: 'field' }, 'Font', fam),
        h('div', { class: 'grid2' },
          labeled('Size', numIn(() => parseFloat(getComputedStyle(el).fontSize), (v) => { setAttr(el, 'font-size', fmt(v)); ed.commit(); }, { min: 1 })),
          labeled('Spacing', numIn(() => parseFloat(el.getAttribute('letter-spacing')) || 0, (v) => { setAttr(el, 'letter-spacing', v ? fmt(v) : null); ed.commit(); }))),
        h('div', { class: 'row' },
          selectIn([['start', 'Left'], ['middle', 'Centre'], ['end', 'Right']], () => el.getAttribute('text-anchor') || 'start', attrSetter([el], 'text-anchor', (v) => (v === 'start' ? null : v))),
          h('label', { class: 'chk' }, bold, 'Bold'), h('label', { class: 'chk' }, ital, 'Italic'))));
    }
    if (tag === 'image' && !multi) {
      p.append(sec('Image',
        h('div', { class: 'row' }, h('label', {}, 'Fit'), selectIn([['xMidYMid meet', 'Contain'], ['xMidYMid slice', 'Cover'], ['none', 'Stretch']], () => el.getAttribute('preserveAspectRatio') || 'xMidYMid meet', attrSetter([el], 'preserveAspectRatio'))),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: async () => {
          const f = await V.pickFile('fileImg'); if (!f) return;
          setAttr(el, 'href', await V.readAs(f, 'dataurl')); el.removeAttributeNS(V.XLINK, 'href'); ed.commit();
        } }, 'Replace image…'))));
    }

    // fill & stroke
    if (!['image', 'use'].includes(tag) || multi) {
      p.append(sec('Fill', paintControl(sel, 'fill')));
      const st = sec('Stroke', paintControl(sel, 'stroke'));
      st.append(h('div', { class: 'grid2' },
        labeled('Width', numIn(() => parseFloat(el.getAttribute('stroke-width') ?? getComputedStyle(el).strokeWidth), (v) => { for (const e of sel) setAttr(e, 'stroke-width', fmt(v)); ed.commit(); }, { min: 0, step: 0.5 })),
        labeled('Dash', selectIn([['', 'Solid'], ['dash', 'Dashed'], ['dot', 'Dotted'], ['dashdot', 'Dash-dot']], () => {
          const d = el.getAttribute('stroke-dasharray');
          if (!d || d === 'none') return '';
          const n = d.split(/[\s,]+/).length;
          return n >= 4 ? 'dashdot' : (parseFloat(d) <= (parseFloat(el.getAttribute('stroke-width')) || 1) * 1.01 ? 'dot' : 'dash');
        }, (v) => {
          for (const e of sel) {
            const w = parseFloat(e.getAttribute('stroke-width')) || 1;
            setAttr(e, 'stroke-dasharray', v === 'dash' ? `${fmt(w * 4)} ${fmt(w * 3)}` : v === 'dot' ? `${fmt(w)} ${fmt(w * 2)}` : v === 'dashdot' ? `${fmt(w * 4)} ${fmt(w * 2)} ${fmt(w)} ${fmt(w * 2)}` : null);
            if (v === 'dot') setAttr(e, 'stroke-linecap', 'round');
          }
          ed.commit();
        }))));
      st.append(h('div', { class: 'grid2' },
        labeled('Ends', selectIn([['butt', 'Flat'], ['round', 'Round'], ['square', 'Square']], () => el.getAttribute('stroke-linecap') || 'butt', attrSetter(sel, 'stroke-linecap', (v) => (v === 'butt' ? null : v)))),
        labeled('Joins', selectIn([['miter', 'Sharp'], ['round', 'Round'], ['bevel', 'Bevel']], () => el.getAttribute('stroke-linejoin') || 'miter', attrSetter(sel, 'stroke-linejoin', (v) => (v === 'miter' ? null : v))))));
      p.append(st);
    }
    // layer opacity
    const op = h('input', { type: 'range', min: 0, max: 1, step: 0.01 });
    const opl = h('span', { class: 'muted small' });
    const ro = () => { const v = parseFloat(el.getAttribute('opacity') ?? getComputedStyle(el).opacity); if (document.activeElement !== op) op.value = isFinite(v) ? v : 1; opl.textContent = Math.round(op.value * 100) + '%'; };
    ro(); refreshers.push(ro);
    op.addEventListener('input', () => { for (const e of sel) setAttr(e, 'opacity', +op.value >= 1 ? null : op.value); opl.textContent = Math.round(op.value * 100) + '%'; });
    op.addEventListener('change', () => ed.commit());
    p.append(sec('Object opacity', h('div', { class: 'paint' }, op, opl)));

    // arrange
    const A = ALIGN_SVG;
    p.append(sec(multi ? 'Align selection' : 'Align to page',
      h('div', { class: 'iconrow' }, btn(A.left, 'Align left', () => ed.align('left')), btn(A.hcenter, 'Centre horizontally', () => ed.align('hcenter')), btn(A.right, 'Align right', () => ed.align('right')),
        btn(A.top, 'Align top', () => ed.align('top')), btn(A.vcenter, 'Centre vertically', () => ed.align('vcenter')), btn(A.bottom, 'Align bottom', () => ed.align('bottom')),
        btn(A.disth, 'Distribute horizontally', () => ed.distribute('h'), { disabled: sel.length < 3 }), btn(A.distv, 'Distribute vertically', () => ed.distribute('v'), { disabled: sel.length < 3 }))));
    const canPath = sel.some((e) => ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(e.localName));
    p.append(sec('Arrange',
      h('div', { class: 'iconrow' }, btn(A.front, 'Bring to front (Ctrl+Shift+])', () => ed.order('front')), btn(A.forward, 'Bring forward (Ctrl+])', () => ed.order('forward')),
        btn(A.backward, 'Send backward (Ctrl+[)', () => ed.order('backward')), btn(A.back, 'Send to back (Ctrl+Shift+[)', () => ed.order('back')),
        btn(A.group, 'Group (Ctrl+G)', () => ed.group()), btn(A.ungroup, 'Ungroup (Ctrl+Shift+G)', () => ed.ungroup(), { disabled: !sel.some((e) => e.localName === 'g') }),
        btn(A.topath, 'Convert to path', () => ed.toPath(), { disabled: !canPath }),
        btn('i-copy', 'Duplicate (Ctrl+D)', () => ed.duplicate()), btn('i-trash', 'Delete', () => ed.deleteSel())),
      tag === 'path' && !multi ? h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => ed.enterNodeMode(el) }, 'Edit nodes'), h('span', { class: 'muted small' }, 'or double-click the path')) : ''));
  };

  const renderNodeProps = (p) => {
    const n = ed.node.selNodes.size;
    p.append(sec('Node editing',
      h('p', { class: 'muted small', style: 'margin:0 0 8px' }, n ? `${n} node${n > 1 ? 's' : ''} selected` : 'Click a node to select it, Shift-click or drag a box to select several. Double-click the path to add a node.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => ed.nodeAdd() }, 'Add after'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => ed.nodeDelete() }, 'Delete')),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => ed.nodeType('curve') }, 'To curve'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => ed.nodeType('line') }, 'To line'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => ed.nodeType('smooth') }, 'Smooth')),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => ed.nodeToggleClose() }, 'Close / open path'),
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => ed.escape() }, 'Done')),
      h('p', { class: 'muted small' }, 'Dragging a handle keeps smooth curves smooth; hold Alt to break the curve. Arrow keys nudge selected nodes.')));
  };

  const renderDocProps = (p) => {
    const vb = ed.vb();
    const wIn = numIn(() => V.toPx(ed.meta.width, ed.vb()[2]), (v) => ed.setDocSize(v, V.toPx(ed.meta.height, ed.vb()[3])), { min: 1 });
    const hIn = numIn(() => V.toPx(ed.meta.height, ed.vb()[3]), (v) => ed.setDocSize(V.toPx(ed.meta.width, ed.vb()[2]), v), { min: 1 });
    const vbIn = h('input', { type: 'text', value: vb.map((n) => fmt(n)).join(' '), spellcheck: false });
    vbIn.addEventListener('change', () => {
      const v = vbIn.value.trim().split(/[\s,]+/).map(parseFloat);
      if (v.length !== 4 || !v.every(isFinite) || v[2] <= 0 || v[3] <= 0) { V.toast('viewBox needs four numbers: x y width height', 'err'); return; }
      ed.doc.setAttribute('viewBox', v.map((n) => fmt(n)).join(' '));
      ed.layoutDoc(); ed.commit(); ed.fit();
    });
    const bgSel = selectIn([['', 'Checkerboard'], ['#ffffff', 'White'], ['#000000', 'Black'], ['#808080', 'Grey']],
      () => ed.doc.getAttribute('data-vector-bg') || '', (v) => { if (v) ed.doc.setAttribute('data-vector-bg', v); else ed.doc.removeAttribute('data-vector-bg'); ed.layoutDoc(); ed.commit(); });
    const presets = h('select', {}, h('option', { value: '' }, 'Presets…'),
      ...[['16 16', 'Icon 16'], ['24 24', 'Icon 24'], ['48 48', 'Icon 48'], ['512 512', 'App icon 512'], ['1200 630', 'Social card 1200×630'], ['1920 1080', 'HD 1920×1080'], ['794 1123', 'A4 portrait (96 dpi)'], ['1123 794', 'A4 landscape (96 dpi)'], ['816 1056', 'US Letter (96 dpi)']]
        .map(([v, l]) => h('option', { value: v }, l)));
    presets.addEventListener('change', () => { const [w, hh] = presets.value.split(' ').map(Number); if (w) { ed.setDocSize(w, hh); ed.fit(); } presets.value = ''; });
    const text = ed.getText({ pretty: false });
    const count = ed.doc.querySelectorAll('*').length;
    p.append(sec('Document',
      h('div', { class: 'grid2' }, labeled('W', wIn), labeled('H', hIn)),
      h('div', { class: 'field' }, 'viewBox', vbIn),
      h('div', { class: 'row' }, presets),
      h('div', { class: 'row' }, h('label', {}, 'Backdrop'), bgSel),
      h('p', { class: 'muted small' }, 'Backdrop is only for viewing — it is not saved. Units in the original file (mm, in…) are kept unless you change the size.')));
    p.append(sec('Info', h('dl', { class: 'kv' },
      h('dt', {}, 'File'), h('dd', {}, ed.fileName || 'untitled.svg'),
      h('dt', {}, 'Size'), h('dd', {}, (new Blob([text]).size / 1024).toFixed(1) + ' KB'),
      h('dt', {}, 'Elements'), h('dd', {}, String(count)))));
    p.append(h('div', { class: 'empty-note' }, 'Select an object to edit it. Draw with the tools on the left, drop an SVG or image here, or paste SVG code (Ctrl+V).'));
  };

  UI.refreshProps = () => { for (const r of refreshers) try { r(); } catch (e) {} };

  /* ------------------------------------------------------------ layers panel */
  let collapsed = new WeakSet();
  let dragEl = null;
  UI.renderLayers = () => {
    const p = $('#layersPane');
    if (p.hidden) return;
    const keep = p.scrollTop;
    p.textContent = '';
    const ul = h('ul', { class: 'layers' });
    let rows = 0;
    const label = (el) => {
      if (el.getAttribute('id')) return el.getAttribute('id');
      const lbl = el.getAttribute('inkscape:label') || el.getAttribute('aria-label');
      if (lbl) return lbl;
      if (el.localName === 'text') return '“' + (el.textContent || '').trim().slice(0, 24) + '”';
      return TAGNAMES[el.localName] || el.localName;
    };
    const walk = (parent, depth) => {
      const kids = Array.from(parent.children).filter((k) => !['defs', 'style', 'title', 'desc', 'metadata', 'script'].includes(k.localName) && !k.localName.includes(':') && k.namespaceURI === V.NS).reverse();
      for (const el of kids) {
        if (rows++ > 1500) return;
        const isG = el.localName === 'g' || el.localName === 'a' || el.localName === 'svg';
        const hidden = el.getAttribute('display') === 'none';
        const locked = el.hasAttribute('data-vector-locked');
        const li = h('li', { class: (ed.sel.includes(el) ? 'sel ' : '') + (ed.ctx === el ? 'ctx ' : '') + (hidden ? 'hiddenel' : ''), style: `--depth:${depth}`, draggable: 'true' });
        const tw = h('span', { class: 'tw' }, isG && el.children.length ? (collapsed.has(el) ? '▸' : '▾') : '');
        tw.addEventListener('click', (e) => { e.stopPropagation(); if (collapsed.has(el)) collapsed.delete(el); else collapsed.add(el); UI.renderLayers(); });
        const eye = h('button', { type: 'button', title: hidden ? 'Show' : 'Hide' }, icon(hidden ? 'i-eye-off' : 'i-eye'));
        eye.addEventListener('click', (e) => { e.stopPropagation(); ed.toggleHidden(el); });
        const lk = h('button', { type: 'button', title: locked ? 'Unlock' : 'Lock' }, icon(locked ? 'i-lock' : 'i-unlock'));
        if (!locked) lk.style.opacity = '.35';
        lk.addEventListener('click', (e) => { e.stopPropagation(); ed.toggleLock(el); });
        const nm = h('span', { class: 'nm', title: 'Double-click to rename' }, label(el));
        li.append(tw, nm, h('span', { class: 'tag' }, el.localName), eye, lk);
        li.addEventListener('click', (e) => {
          if (locked) return;
          const container = el.parentNode;
          if (container !== ed.ctx) ed.ctx = container === ed.doc || container.localName !== 'g' ? (container === ed.doc ? ed.doc : container) : container;
          ed.select([el], e.shiftKey || e.ctrlKey || e.metaKey);
        });
        li.addEventListener('dblclick', async () => {
          const v = await V.prompt('Rename', 'Sets the element id (letters, digits, - and _).', el.getAttribute('id') || '');
          if (v == null) return;
          const id = v.trim().replace(/\s+/g, '-');
          if (id && ed.doc.querySelector('#' + CSS.escape(id)) && ed.doc.querySelector('#' + CSS.escape(id)) !== el) { V.toast('That id is already used', 'err'); return; }
          if (id) el.setAttribute('id', id); else el.removeAttribute('id');
          ed.commit();
        });
        li.addEventListener('dragstart', (e) => { dragEl = el; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'layer'); });
        li.addEventListener('dragover', (e) => {
          if (!dragEl || dragEl === el || dragEl.contains(el)) return;
          e.preventDefault();
          const r = li.getBoundingClientRect();
          li.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
          li.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
        });
        li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
        li.addEventListener('drop', (e) => {
          e.preventDefault();
          const before = li.classList.contains('drop-before');
          li.classList.remove('drop-before', 'drop-after');
          if (!dragEl || dragEl === el || dragEl.contains(el)) return;
          const m = ed.localToDoc(dragEl);
          // list is reversed (top of list = front), so "before" in the list means after in the DOM
          if (before) el.parentNode.insertBefore(dragEl, el.nextSibling); else el.parentNode.insertBefore(dragEl, el);
          const pm = ed.localToDoc(dragEl.parentNode);
          if (m && pm) { V.setTransform(dragEl, pm.inverse().multiply(m)); ed.bake(dragEl); }
          dragEl = null;
          ed.commit();
        });
        ul.append(li);
        if (isG && !collapsed.has(el)) walk(el, depth + 1);
      }
    };
    walk(ed.doc, 0);
    if (!rows) p.append(h('div', { class: 'empty-note' }, 'No objects yet.'));
    else p.append(ul, h('div', { class: 'empty-note' }, 'Top of the list is in front. Drag to reorder · double-click to rename.'));
    p.scrollTop = keep;
  };

  /* ------------------------------------------------------------ code panel */
  let codeDirty = false;
  UI.syncCode = (force) => {
    const ta = $('#codeText');
    if (ta.closest('.ppane').hidden && !force) return;
    if (document.activeElement === ta && !force) return;
    ta.value = ed.getText({ pretty: true });
    codeDirty = false;
    setCodeState('In sync');
  };
  const setCodeState = (msg, err) => { const s = $('#codeState'); s.textContent = msg; s.classList.toggle('err', !!err); };
  const applyCode = V.debounce(() => {
    const ta = $('#codeText');
    try {
      const { svg, warnings } = V.parseSvgText(ta.value);
      const vb = V.svg2pdf.parseViewBox(svg);
      const wA = svg.getAttribute('width'), hA = svg.getAttribute('height');
      if (!vb) svg.setAttribute('viewBox', `0 0 ${fmt(V.toPx(wA, 300))} ${fmt(V.toPx(hA, 150))}`);
      const oldVb = ed.vb().join(' ');
      ed.meta = { width: wA && !/%$/.test(wA) ? wA : null, height: hA && !/%$/.test(hA) ? hA : null };
      UI._fromCode = true;
      ed.installDoc(svg);
      ed.commit({ fromCode: true });
      UI._fromCode = false;
      if (ed.vb().join(' ') !== oldVb) ed.fit();
      codeDirty = false;
      setCodeState(warnings.length ? 'Applied — ' + warnings.join(', ') : 'Applied');
    } catch (e) {
      setCodeState('Error: ' + e.message, true);
    }
  }, 500);

  /* ------------------------------------------------------------ optimiser */
  V.optimize = (text, o = {}) => {
    const prec = o.precision ?? 2;
    const { svg } = V.parseSvgText(text);
    const r = (s) => String(s).replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (m) => fmt(parseFloat(m), prec));
    // editor / app-specific namespaces
    const junkNs = /^(sodipodi|inkscape|sketch|serif|figma|illustrator|i|x|a|graph|dc|cc|rdf)$/;
    const walkAll = (el, fn) => { fn(el); for (const k of Array.from(el.children)) walkAll(k, fn); };
    walkAll(svg, (el) => {
      if (el !== svg && (el.localName === 'metadata' || (el.prefix && junkNs.test(el.prefix)) || (el.tagName.includes(':') && junkNs.test(el.tagName.split(':')[0])))) { el.remove(); return; }
      for (const a of Array.from(el.attributes)) {
        const pre = a.name.includes(':') ? a.name.split(':')[0] : '';
        if ((pre && pre !== 'xlink' && pre !== 'xml' && pre !== 'xmlns') || a.name.startsWith('data-vector') || (a.name.startsWith('xmlns:') && junkNs.test(a.name.slice(6)))) el.removeAttribute(a.name);
      }
    });
    // ids in use
    const used = new Set();
    walkAll(svg, (el) => {
      for (const a of el.attributes) {
        for (const m of a.value.matchAll(/url\(\s*["']?#([^"')\s]+)/g)) used.add(m[1]);
        if ((a.name === 'href' || a.name === 'xlink:href') && a.value.startsWith('#')) used.add(a.value.slice(1));
        if (/^aria-/.test(a.name) || a.name === 'begin' || a.name === 'end') a.value.split(/[\s;]+/).forEach((v) => used.add(v.split('.')[0]));
      }
      if (el.localName === 'style') for (const m of el.textContent.matchAll(/#([\w-]+)/g)) used.add(m[1]);
    });
    const DEFAULTS = { 'fill-opacity': '1', 'stroke-opacity': '1', opacity: '1', 'fill-rule': 'nonzero', 'stroke-dasharray': 'none', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'stroke-miterlimit': '4', 'stroke-dashoffset': '0', visibility: 'visible', display: 'inline', 'clip-rule': 'nonzero', 'font-style': 'normal', 'font-weight': 'normal' };
    walkAll(svg, (el) => {
      if (o.removeIds !== false && el.hasAttribute('id') && !used.has(el.getAttribute('id')) && el !== svg) el.removeAttribute('id');
      for (const [k, v] of Object.entries(DEFAULTS)) if (el.getAttribute(k) === v) el.removeAttribute(k);
      if (el.getAttribute('stroke') === 'none' && el.parentNode === svg) el.removeAttribute('stroke');
      if (['rect', 'image', 'use'].includes(el.localName)) for (const a of ['x', 'y']) if (parseFloat(el.getAttribute(a)) === 0) el.removeAttribute(a);
      for (const a of ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'stroke-width', 'points', 'transform', 'viewBox', 'font-size', 'offset', 'dx', 'dy', 'stroke-dasharray']) {
        if (el.hasAttribute(a) && !/%/.test(el.getAttribute(a))) el.setAttribute(a, r(el.getAttribute(a)));
      }
      if (el.localName === 'path' && el.hasAttribute('d')) el.setAttribute('d', V.Path.serialize(V.Path.parse(el.getAttribute('d')), prec));
      if (el.getAttribute('style') === '') el.removeAttribute('style');
      if (el.getAttribute('transform') === '') el.removeAttribute('transform');
    });
    // unwrap attribute-less groups, drop empty groups/defs
    let changed = true;
    while (changed) {
      changed = false;
      for (const g of Array.from(svg.querySelectorAll('g, defs'))) {
        if (!g.children.length && !g.textContent.trim()) { g.remove(); changed = true; continue; }
        if (g.localName === 'g' && !g.attributes.length && g.parentNode) {
          while (g.firstChild) g.parentNode.insertBefore(g.firstChild, g);
          g.remove(); changed = true;
        }
      }
    }
    // round colours: #aabbcc -> #abc
    walkAll(svg, (el) => {
      for (const a of ['fill', 'stroke', 'stop-color', 'color', 'flood-color']) {
        const v = el.getAttribute(a);
        if (v && /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/i.test(v)) el.setAttribute(a, '#' + v[1] + v[3] + v[5]);
      }
    });
    return V.serialize(svg, !!o.pretty);
  };

  /* ------------------------------------------------------------ tool options bar */
  const TOOL_HINTS = {
    select: 'Click to select · Shift-click adds · drag empty space to box-select · Alt-drag duplicates · double-click edits text, nodes or enters a group',
    hand: 'Drag to pan · scroll to pan · Ctrl+scroll to zoom',
    pen: 'Click for corners, drag for curves · click the first point to close · Enter or double-click to finish · Alt while dragging makes a cusp',
    pencil: 'Draw freehand — the line is smoothed when you let go. Ending near the start closes the shape.',
    image: 'Click where the image should go (or drop / paste an image onto the canvas)',
    eyedrop: 'Click a shape to copy its colours to the selection (or to the defaults for new shapes)',
    node: 'Drag nodes and handles · Shift-click / box-select several · double-click the path to add a node · Delete removes · Esc finishes',
  };
  UI.renderToolOpts = () => {
    const bar = $('#toolOpts');
    bar.textContent = '';
    const t = ed.tool;
    const o = ed.opts;
    const save = () => V.storage.set('toolOpts', ed.opts);
    const num = (label, key, opts = {}) => {
      const i = h('input', { type: 'number', value: o[key], min: opts.min, max: opts.max, step: opts.step || 1 });
      i.addEventListener('change', () => { const v = parseFloat(i.value); if (isFinite(v)) { o[key] = v; save(); } });
      return h('label', {}, label, i);
    };
    const chk = (label, key) => {
      const i = h('input', { type: 'checkbox', checked: o[key] !== false && !!o[key] });
      i.addEventListener('change', () => { o[key] = i.checked; save(); });
      return h('label', { class: 'chk' }, i, label);
    };
    const name = h('b', { style: 'color:var(--text)' }, { select: 'Select', node: 'Nodes', hand: 'Pan', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', polygon: 'Polygon', star: 'Star', pen: 'Pen', pencil: 'Freehand', text: 'Text', image: 'Image', eyedrop: 'Eyedropper' }[t] || t);
    bar.append(name);
    if (['rect', 'ellipse', 'polygon', 'star'].includes(t)) bar.append(chk('Fill', 'fillOn'), chk('Stroke', 'strokeOn'));
    if (['rect', 'ellipse', 'line', 'polygon', 'star', 'pen', 'pencil'].includes(t)) bar.append(num('Stroke width', 'strokeWidth', { min: 0, step: 0.5 }));
    if (t === 'rect') bar.append(num('Corner radius', 'radius', { min: 0 }));
    if (t === 'polygon') bar.append(num('Sides', 'sides', { min: 3, max: 64 }));
    if (t === 'star') bar.append(num('Points', 'points', { min: 3, max: 64 }), num('Inner ratio', 'inner', { min: 0.05, max: 0.95, step: 0.05 }));
    if (['rect', 'ellipse', 'polygon', 'star', 'line'].includes(t)) bar.append(h('span', { class: 'hint' }, 'Shift: keep proportions · Alt: from centre · click without dragging for a default size'));
    if (t === 'text') {
      const fam = h('select', {}, ...FONTS.map(([v, l]) => h('option', { value: v, selected: v === o.fontFamily }, l)));
      fam.addEventListener('change', () => { o.fontFamily = fam.value; save(); });
      bar.append(h('label', {}, 'Font', fam), num('Size', 'fontSize', { min: 1 }), h('span', { class: 'hint' }, 'Click to add text, or click existing text to edit it'));
    }
    if (t === 'node') {
      bar.append(
        h('button', { class: 'btn', type: 'button', onclick: () => ed.nodeAdd() }, 'Add node'),
        h('button', { class: 'btn', type: 'button', onclick: () => ed.nodeDelete() }, 'Delete'),
        h('button', { class: 'btn', type: 'button', onclick: () => ed.nodeType('curve') }, 'Curve'),
        h('button', { class: 'btn', type: 'button', onclick: () => ed.nodeType('line') }, 'Line'),
        h('button', { class: 'btn', type: 'button', onclick: () => ed.nodeType('smooth') }, 'Smooth'),
        h('button', { class: 'btn', type: 'button', onclick: () => ed.nodeToggleClose() }, 'Close/Open'));
      if (!ed.node) bar.append(h('span', { class: 'hint' }, 'Click a path (or shape) to edit its nodes'));
    }
    if (TOOL_HINTS[t] && t !== 'node') bar.append(h('span', { class: 'hint' }, TOOL_HINTS[t]));
    else if (t === 'node' && ed.node) bar.append(h('span', { class: 'hint' }, TOOL_HINTS.node));
    $$('.toolbox [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  };

  const updateSwatches = () => {
    $('#defFill').value = V.toHex(ed.defFill) || '#4f8cff';
    $('#defStroke').value = V.toHex(ed.defStroke) || '#1d2b4f';
    $('.sw.fill span').style.background = ed.defFill;
    $('.sw.stroke span').style.setProperty('--c', ed.defStroke);
  };

  /* ------------------------------------------------------------ inline text editing */
  let textEd = null;
  const editText = (el, isNew) => {
    finishTextEdit();
    if (!ed.doc.contains(el)) return;
    const stage = $('#stage');
    const cs = getComputedStyle(el);
    const ctm = el.getScreenCTM();
    const scale = Math.hypot(ctm.a, ctm.b);
    const ta = h('textarea', { class: 'pdf-text-edit', spellcheck: true, wrap: 'off' });
    ta.value = ed.getTextLines(el);
    Object.assign(ta.style, {
      fontFamily: cs.fontFamily, fontSize: (parseFloat(cs.fontSize) * scale) + 'px', fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
      color: V.toHex(cs.fill) || '#000', letterSpacing: (parseFloat(cs.letterSpacing) || 0) * scale + 'px',
    });
    const angle = Math.atan2(ctm.b, ctm.a) * 180 / Math.PI;
    const place = () => {
      const r = el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      ta.style.left = (r.left - sr.left - 2) + 'px';
      ta.style.top = (r.top - sr.top - 2) + 'px';
      ta.style.width = Math.max(ta.scrollWidth, r.width + 20, 60) + 'px';
      ta.style.height = 'auto';
      ta.style.height = Math.max(ta.scrollHeight, r.height + 4) + 'px';
      ta.style.transform = Math.abs(angle) > 0.5 ? `rotate(${angle}deg)` : '';
    };
    el.setAttribute('data-vector-editing', '');
    el.style.visibility = 'hidden';
    stage.appendChild(ta);
    place();
    ta.focus();
    if (isNew) ta.select(); else ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener('input', () => { ed.setTextLines(el, ta.value); place(); ed.redraw(); });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finishTextEdit(); }
    });
    ta.addEventListener('blur', () => finishTextEdit());
    textEd = { el, ta };
  };
  const finishTextEdit = () => {
    if (!textEd) return;
    const { el, ta } = textEd;
    textEd = null;
    ta.remove();
    el.removeAttribute('data-vector-editing');
    el.style.removeProperty('visibility');
    if (!el.getAttribute('style')) el.removeAttribute('style');
    if (!el.textContent.trim()) { el.remove(); ed.sel = ed.sel.filter((e) => e !== el); ed.emit('select'); }
    ed.commit();
  };
  UI.finishTextEdit = finishTextEdit;

  /* ------------------------------------------------------------ files */
  const SVG_TYPES = [{ description: 'SVG or image', accept: { 'image/svg+xml': ['.svg'], 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/gif': ['.gif'] } }];
  UI.openFile = async () => {
    let file, handle = null;
    if (window.showOpenFilePicker) {
      try {
        [handle] = await window.showOpenFilePicker({ types: SVG_TYPES, multiple: false });
        file = await handle.getFile();
      } catch (e) { if (e.name === 'AbortError') return; handle = null; }
    }
    if (!file) file = await V.pickFile('fileSvg');
    if (!file) return;
    await UI.openBlob(file, handle);
  };
  UI.openBlob = async (file, handle) => {
    const isSvg = /svg/.test(file.type) || /\.svg$/i.test(file.name);
    try {
      if (isSvg) {
        const text = await V.readAs(file, 'text');
        const warn = ed.loadText(text, file.name);
        ed.fileHandle = handle || null;
        ed.savedText = ed.getText();
        V.toast('Opened ' + file.name + (warn.length ? ' — ' + warn.join(', ') : ''));
      } else if (/^image\//.test(file.type)) {
        // raster image: start a document of the image's size containing it
        const url = await V.readAs(file, 'dataurl');
        const img = await V.loadImage(url);
        ed.newDoc(img.naturalWidth || 800, img.naturalHeight || 600);
        const el = V.svgEl('image', { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight, href: url });
        ed.doc.appendChild(el);
        ed.fileName = V.baseName(file.name) + '.svg';
        ed.resetHistory();
        V.toast('Opened ' + file.name + ' as an image layer — draw over it or trace it with the pen');
      } else { V.toast('Unsupported file: ' + file.name, 'err'); return; }
    } catch (e) {
      console.error(e);
      V.toast('Could not open ' + file.name + ': ' + e.message, 'err');
    }
  };
  UI.save = async (saveAs) => {
    const text = ed.getText();
    const h0 = saveAs ? null : ed.fileHandle;
    const res = await V.saveFile(text, ed.fileName || 'drawing.svg', 'image/svg+xml', 'svg', h0);
    if (res === undefined) return;
    if (res) { ed.fileHandle = res; if (res.name) ed.fileName = res.name; }
    ed.savedText = text;
    V.toast('Saved ' + (ed.fileName || 'drawing.svg'));
    UI.renderStatus();
  };
  UI.newDoc = async () => {
    if (ed.doc.children.length && ed.getText() !== ed.savedText && !confirm('Start a new drawing? Unsaved changes to the current one will be lost (it stays in Undo until you reload).')) return;
    const v = await V.prompt('New drawing', 'Size in px (width × height)', '800 × 600');
    if (v == null) return;
    const m = v.match(/([\d.]+)\D+([\d.]+)/);
    const w = m ? parseFloat(m[1]) : 800, hh = m ? parseFloat(m[2]) : 600;
    ed.newDoc(w || 800, hh || 600);
    ed.savedText = ed.getText();
  };

  /* ------------------------------------------------------------ export */
  const rasterize = async (text, w, h2, bg) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    try {
      const img = await V.loadImage(url);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h2));
      if (c.width * c.height > 268e6) throw new Error('Image too large');
      const ctx = c.getContext('2d');
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c;
    } finally { URL.revokeObjectURL(url); }
  };
  UI.rasterize = rasterize;
  const docPx = () => ({ w: V.toPx(ed.meta.width, ed.vb()[2]), h: V.toPx(ed.meta.height, ed.vb()[3]) });

  const jsxName = (n) => (V.baseName(n).replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^\d/, '_$&').replace(/^./, (c) => c.toUpperCase()) || 'Icon');
  const toJsx = (text, name) => {
    const { svg } = V.parseSvgText(text);
    const camel = (s) => s.replace(/[-:]([a-z])/g, (_, c) => c.toUpperCase());
    const keepHyphen = /^(data-|aria-)/;
    const attrJsx = (el, isRoot) => {
      let out = '';
      for (const a of el.attributes) {
        let n = a.name;
        if (n === 'xmlns:xlink') continue;
        if (n === 'class') n = 'className';
        else if (n === 'style') {
          const obj = a.value.split(';').map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.indexOf(':'); return [camel(s.slice(0, i).trim()), s.slice(i + 1).trim()]; });
          out += ` style={{${obj.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}}}`;
          continue;
        } else if (!keepHyphen.test(n)) n = camel(n);
        out += ` ${n}=${JSON.stringify(a.value)}`;
      }
      if (isRoot) out += ' {...props}';
      return out;
    };
    const esc = (s) => s.replace(/[{}<>]/g, (c) => `{"${c}"}`);
    const walk = (el, d, isRoot) => {
      const ind = '  '.repeat(d);
      const kids = Array.from(el.childNodes).filter((k) => k.nodeType === 1 || (k.nodeType === 3 && k.data.trim()));
      if (!kids.length) return `${ind}<${el.tagName}${attrJsx(el, isRoot)} />`;
      if (el.localName === 'style') return `${ind}<style>{${JSON.stringify(el.textContent)}}</style>`;
      const inner = kids.map((k) => (k.nodeType === 3 ? ind + '  ' + esc(k.data.trim()) : walk(k, d + 1, false))).join('\n');
      return `${ind}<${el.tagName}${attrJsx(el, isRoot)}>\n${inner}\n${ind}</${el.tagName}>`;
    };
    return `import * as React from "react";\n\nconst ${name} = (props) => (\n${walk(svg, 1, true)}\n);\n\nexport default ${name};\n`;
  };

  const ico = async (text) => {
    // ICO containing 16/32/48 PNGs
    const sizes = [16, 32, 48];
    const pngs = [];
    for (const s of sizes) {
      const c = await rasterize(text, s, s);
      pngs.push(new Uint8Array(await (await V.canvasToBlob(c, 'image/png')).arrayBuffer()));
    }
    const headerLen = 6 + 16 * sizes.length;
    const total = headerLen + pngs.reduce((a, p) => a + p.length, 0);
    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, 0, true); dv.setUint16(2, 1, true); dv.setUint16(4, sizes.length, true);
    let off = headerLen;
    sizes.forEach((s, i) => {
      const e = 6 + i * 16;
      buf[e] = s; buf[e + 1] = s; buf[e + 2] = 0; buf[e + 3] = 0;
      dv.setUint16(e + 4, 1, true); dv.setUint16(e + 6, 32, true);
      dv.setUint32(e + 8, pngs[i].length, true); dv.setUint32(e + 12, off, true);
      buf.set(pngs[i], off); off += pngs[i].length;
    });
    return buf;
  };

  const expState = V.storage.get('export', { fmt: 'svg', scale: 2, quality: 0.9, bg: '#ffffff', bgOn: false, precision: 2, removeIds: true, dpi: 300 });
  const renderExportOpts = () => {
    const f = expState.fmt;
    const box = $('#exportOpts');
    box.textContent = '';
    const { w, h: hh } = docPx();
    const save = () => { V.storage.set('export', expState); updateExportInfo(); };
    const num = (label, key, o = {}) => { const i = h('input', { type: 'number', value: expState[key], min: o.min, max: o.max, step: o.step || 'any' }); i.addEventListener('input', () => { const v = parseFloat(i.value); if (isFinite(v)) { expState[key] = v; save(); } }); return h('label', {}, label, i, o.suffix ? h('span', { class: 'muted' }, o.suffix) : ''); };
    const chk = (label, key) => { const i = h('input', { type: 'checkbox', checked: !!expState[key] }); i.addEventListener('change', () => { expState[key] = i.checked; save(); }); return h('label', {}, i, label); };
    if (f === 'svgo') box.append(num('Decimal places', 'precision', { min: 0, max: 6, step: 1 }), chk('Remove unused IDs', 'removeIds'));
    if (['png', 'jpeg', 'webp'].includes(f)) {
      box.append(num('Scale', 'scale', { min: 0.05, max: 32, step: 0.25, suffix: '×' }));
      const wl = h('span', { class: 'muted', id: 'expDims' });
      box.append(wl);
      if (f !== 'jpeg') box.append(chk('Background', 'bgOn'));
      const c = h('input', { type: 'color', value: expState.bg });
      c.addEventListener('input', () => { expState.bg = c.value; save(); });
      box.append(c);
      if (f !== 'png') box.append(num('Quality', 'quality', { min: 0.1, max: 1, step: 0.05 }));
    }
    if (f === 'pdfr') box.append(num('Resolution', 'dpi', { min: 72, max: 1200, step: 1, suffix: 'dpi' }));
    if (f === 'pdf') box.append(h('span', { class: 'muted' }, `Page ${fmt(w * 0.75, 1)} × ${fmt(hh * 0.75, 1)} pt. Shapes, paths, images and text stay vector; gradients become a flat colour, filters/masks are skipped.`));
    if (f === 'ico') box.append(h('span', { class: 'muted' }, 'Creates favicon.ico (16, 32, 48), apple-touch-icon.png (180) and icon-192/512.png. You pick a folder to save them into.'));
    updateExportInfo();
  };
  const updateExportInfo = () => {
    const f = expState.fmt;
    const info = $('#exportInfo');
    const { w, h: hh } = docPx();
    const dims = $('#expDims');
    if (dims) dims.textContent = `${Math.round(w * expState.scale)} × ${Math.round(hh * expState.scale)} px`;
    info.textContent = '';
    const text = ed.getText();
    if (f === 'svg') info.append(`${(new Blob([text]).size / 1024).toFixed(1)} KB`);
    if (f === 'svgo') {
      try {
        const o = V.optimize(text, { precision: expState.precision, removeIds: expState.removeIds });
        const a = new Blob([text]).size, b = new Blob([o]).size;
        info.append(`${(a / 1024).toFixed(1)} KB → ${(b / 1024).toFixed(1)} KB (${a ? Math.round((1 - b / a) * 100) : 0}% smaller)`);
      } catch (e) { info.append('Could not optimise: ' + e.message); }
    }
    if (f === 'jsx') info.append(h('pre', {}, toJsx(text, jsxName($('#exportName').value)).slice(0, 4000)));
    if (f === 'datauri') {
      const enc = 'data:image/svg+xml,' + encodeURIComponent(V.optimize(text, { precision: 3 })).replace(/%20/g, ' ').replace(/%3D/g, '=').replace(/%3A/g, ':').replace(/%2F/g, '/').replace(/%22/g, "'");
      info.append(h('pre', {}, enc.length > 6000 ? enc.slice(0, 6000) + '…' : enc), `${(enc.length / 1024).toFixed(1)} KB · Export copies it to the clipboard (CSS: background-image: url("…"))`);
    }
  };
  UI.openExport = () => {
    const dlg = $('#exportDlg');
    $('#exportName').value = V.baseName(ed.fileName || 'drawing');
    $$('#exportFormats input').forEach((i) => { i.checked = i.value === expState.fmt; });
    renderExportOpts();
    dlg.showModal();
  };
  const doExport = async () => {
    const f = expState.fmt;
    const name = ($('#exportName').value || 'drawing').trim();
    const text = ed.getText();
    const { w, h: hh } = docPx();
    V.busy('Exporting…');
    await V.nextFrame();
    try {
      if (f === 'svg') await V.saveFile(text, name + '.svg', 'image/svg+xml', 'svg');
      else if (f === 'svgo') await V.saveFile(V.optimize(text, { precision: expState.precision, removeIds: expState.removeIds }), name + '.svg', 'image/svg+xml', 'svg');
      else if (['png', 'jpeg', 'webp'].includes(f)) {
        const bg = f === 'jpeg' ? expState.bg : (expState.bgOn ? expState.bg : null);
        const c = await rasterize(text, w * expState.scale, hh * expState.scale, bg);
        const blob = await V.canvasToBlob(c, 'image/' + f, f === 'png' ? undefined : expState.quality);
        const ext = f === 'jpeg' ? 'jpg' : f;
        await V.saveFile(blob, name + '.' + ext, 'image/' + f, ext);
      } else if (f === 'pdf') {
        const { bytes, warnings } = await V.svg2pdf.svgToPdf(text, { title: name });
        await V.saveFile(bytes, name + '.pdf', 'application/pdf', 'pdf');
        if (warnings.length) V.toast('PDF saved. Note: ' + warnings.join('; '));
      } else if (f === 'pdfr') {
        const k = expState.dpi / 96;
        const c = await rasterize(text, w * k, hh * k, null);
        const png = new Uint8Array(await (await V.canvasToBlob(c, 'image/png')).arrayBuffer());
        const doc = await PDFLib.PDFDocument.create();
        const img = await doc.embedPng(png);
        const page = doc.addPage([w * 0.75, hh * 0.75]);
        page.drawImage(img, { x: 0, y: 0, width: w * 0.75, height: hh * 0.75 });
        doc.setTitle(name); doc.setCreator('Vector');
        await V.saveFile(await doc.save(), name + '.pdf', 'application/pdf', 'pdf');
      } else if (f === 'jsx') {
        const code = toJsx(V.optimize(text, { precision: 3, removeIds: false, pretty: true }), jsxName(name));
        await V.saveFile(code, jsxName(name) + '.jsx', 'text/javascript', 'jsx');
      } else if (f === 'datauri') {
        const enc = 'data:image/svg+xml,' + encodeURIComponent(V.optimize(text, { precision: 3 })).replace(/%20/g, ' ').replace(/%3D/g, '=').replace(/%3A/g, ':').replace(/%2F/g, '/').replace(/%22/g, "'");
        await navigator.clipboard.writeText(enc);
        V.toast('Data URI copied to the clipboard');
      } else if (f === 'ico') {
        const files = [['favicon.ico', await ico(text), 'image/x-icon']];
        for (const [n, s] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
          const c = await rasterize(text, s, s);
          files.push([n, await V.canvasToBlob(c, 'image/png'), 'image/png']);
        }
        let dir = null;
        if (window.showDirectoryPicker) { try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { if (e.name === 'AbortError') { V.busy(false); return; } } }
        for (const [n, data, mime] of files) {
          if (dir) { const fh = await dir.getFileHandle(n, { create: true }); const wr = await fh.createWritable(); await wr.write(data instanceof Blob ? data : new Blob([data], { type: mime })); await wr.close(); }
          else V.download(data, n, mime);
        }
        V.toast(`Saved ${files.length} icon files` + (dir ? ' to ' + dir.name : ''));
      }
    } catch (e) {
      console.error(e);
      V.toast('Export failed: ' + e.message, 'err');
    } finally { V.busy(false); }
  };

  /* ------------------------------------------------------------ status */
  UI.renderStatus = () => {
    const vb = ed.vb();
    $('#svgDocSize').textContent = `${ed.meta.width || fmt(vb[2])} × ${ed.meta.height || fmt(vb[3])}`;
    $('#svgZoomLabel').textContent = Math.round(ed.zoom * 100) + '%';
    const n = ed.sel.length;
    const dirty = ed.savedText != null && ed.getText() !== ed.savedText;
    $('#svgStatus').textContent = (ed.fileName || 'untitled.svg') + (dirty ? ' •' : '') + (n ? ` — ${n} selected` : '') + (ed.ctx !== ed.doc ? ' — inside group' : '');
    $('#svgUndo').disabled = ed.undoStack.length < 2;
    $('#svgRedo').disabled = !ed.redoStack.length;
  };

  /* ------------------------------------------------------------ keyboard */
  UI.key = (e) => {
    if (textEd) return false;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (ed.keyDown(e)) return true;
    if (mod && !e.altKey) {
      const lk = k.toLowerCase();
      if (lk === 'z' && !e.shiftKey) { ed.undo(); return true; }
      if ((lk === 'z' && e.shiftKey) || lk === 'y') { ed.redo(); return true; }
      if (lk === 'c') { ed.copy(); return true; }
      if (lk === 'x') { ed.copy(true); return true; }
      if (lk === 'd') { ed.duplicate(); return true; }
      if (lk === 'a') { ed.selectAll(); return true; }
      if (lk === 'g' && !e.shiftKey) { ed.group(); return true; }
      if (lk === 'g' && e.shiftKey) { ed.ungroup(); return true; }
      if (lk === 's') { UI.save(e.shiftKey); return true; }
      if (lk === 'o') { UI.openFile(); return true; }
      if (lk === 'e') { UI.openExport(); return true; }
      if (k === "'") { $('#svgGrid').click(); return true; }
      if (k === ']' || k === '}') { ed.order(e.shiftKey ? 'front' : 'forward'); return true; }
      if (k === '[' || k === '{') { ed.order(e.shiftKey ? 'back' : 'backward'); return true; }
      if (k === '0') { ed.fit(); return true; }
      if (k === '=' || k === '+') { ed.zoomBy(1.25); return true; }
      if (k === '-') { ed.zoomBy(0.8); return true; }
      return false;
    }
    if (mod && e.altKey && k.toLowerCase() === 'n') { UI.newDoc(); return true; }
    if (k === 'Delete' || k === 'Backspace') { ed.deleteSel(); return true; }
    if (k === 'Escape') { ed.escape(); return true; }
    if (k === 'Enter') { ed.enter(); return true; }
    if (k.startsWith('Arrow')) {
      const s = e.shiftKey ? 10 : (ed.snap ? ed.gridSize : 1);
      const step = s / (e.altKey ? ed.zoom : 1);
      ed.nudge(k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0);
      return true;
    }
    if (k === '+' || k === '=') { ed.zoomBy(1.25); return true; }
    if (k === '-' || k === '_') { ed.zoomBy(0.8); return true; }
    if (k === '!' || (k === '1' && e.shiftKey)) { ed.fit(); return true; }
    if (k === '1') { ed.setZoom(1); return true; }
    if (k === '2') { ed.fitSelection(); return true; }
    const tools = { v: 'select', a: 'node', h: 'hand', r: 'rect', e: 'ellipse', l: 'line', g: 'polygon', s: 'star', p: 'pen', f: 'pencil', t: 'text', i: 'image', k: 'eyedrop' };
    if (!e.altKey && tools[k.toLowerCase()] && !e.shiftKey) { ed.setTool(tools[k.toLowerCase()]); return true; }
    return false;
  };

  /* ------------------------------------------------------------ init */
  UI.init = () => {
    ed.init();
    // datalist for fonts
    document.body.append(h('datalist', { id: 'fontList' }, ...FONTS.map(([v, l]) => h('option', { value: v }, l))));

    const panelRefresh = V.debounce(() => {
      if (!$('#propsPane').hidden) UI.refreshProps();
    }, 30);
    ed.on('select', () => { UI.renderProps(); UI.renderLayers(); UI.renderStatus(); UI.renderToolOpts(); });
    ed.on('nodesel', () => { UI.renderProps(); });
    ed.on('live', () => panelRefresh());
    ed.on('zoom', () => UI.renderStatus());
    ed.on('tool', () => UI.renderToolOpts());
    ed.on('defaults', updateSwatches);
    ed.on('history', () => UI.renderStatus());
    const autosave = V.debounce(() => { const t = ed.getText({ raw: true }); if (t.length < 4e6) V.storage.set('svg', { text: t, name: ed.fileName, meta: ed.meta }); }, 800);
    ed.on('change', (o = {}) => {
      if ($('#propsPane').contains(document.activeElement)) UI.refreshProps(); else UI.renderProps();
      UI.renderLayers();
      UI.renderStatus();
      if (!o.fromCode) UI.syncCode();
      autosave();
    });
    ed.on('edit-text', (el, isNew) => setTimeout(() => editText(el, isNew), 0));
    ed.on('pick-image', async (pt) => {
      const f = await V.pickFile('fileImg');
      if (!f) return;
      if (/svg/.test(f.type) || /\.svg$/i.test(f.name)) {
        const w = ed.importSnippet(await V.readAs(f, 'text'));
        if (w.length) V.toast('Imported — ' + w.join(', '));
        return;
      }
      const m = ed.localToDoc(ed.ctx) || new DOMMatrix();
      const d = V.apply(m, pt.x, pt.y);
      await ed.insertImage(f, d);
    });
    ed.on('cursor', (d) => { $('#svgCursor').textContent = `${fmt(d.x, 1)}, ${fmt(d.y, 1)}`; });

    // toolbox
    $$('.toolbox [data-tool]').forEach((b) => b.addEventListener('click', () => ed.setTool(b.dataset.tool)));
    $('#defFill').addEventListener('input', (e) => { ed.defFill = e.target.value; V.storage.set('defFill', ed.defFill); updateSwatches(); });
    $('#defStroke').addEventListener('input', (e) => { ed.defStroke = e.target.value; V.storage.set('defStroke', ed.defStroke); updateSwatches(); });
    updateSwatches();

    // top bar
    $('#svgNew').addEventListener('click', UI.newDoc);
    $('#svgOpen').addEventListener('click', UI.openFile);
    $('#svgSave').addEventListener('click', () => UI.save(false));
    $('#svgExport').addEventListener('click', UI.openExport);
    $('#svgUndo').addEventListener('click', () => ed.undo());
    $('#svgRedo').addEventListener('click', () => ed.redo());
    $('#svgZoomIn').addEventListener('click', () => ed.zoomBy(1.25));
    $('#svgZoomOut').addEventListener('click', () => ed.zoomBy(0.8));
    $('#svgZoomLabel').addEventListener('click', () => ed.setZoom(1));
    $('#svgFit').addEventListener('click', () => ed.fit());
    const gridBtn = $('#svgGrid'), snapBtn = $('#svgSnap'), gs = $('#svgGridSize');
    const syncGrid = () => { gridBtn.classList.toggle('on', ed.grid); snapBtn.classList.toggle('on', ed.snap); gs.value = ed.gridSize; };
    gridBtn.addEventListener('click', () => { ed.grid = !ed.grid; V.storage.set('grid', ed.grid); syncGrid(); ed.drawGrid(); });
    snapBtn.addEventListener('click', () => { ed.snap = !ed.snap; V.storage.set('snap', ed.snap); syncGrid(); });
    gs.addEventListener('change', () => { const v = parseFloat(gs.value); if (v > 0) { ed.gridSize = v; V.storage.set('gridSize', v); ed.drawGrid(); } });
    syncGrid();
    $('#svgToPdf').addEventListener('click', () => V.app.sendSvgToPdf());

    // panel tabs
    $$('#svgMode .ptabs button').forEach((b) => b.addEventListener('click', () => {
      $$('#svgMode .ptabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      $$('#svgMode .ppane').forEach((p) => { p.hidden = p.dataset.ppane !== b.dataset.ptab; });
      V.storage.set('ptab', b.dataset.ptab);
      if (b.dataset.ptab === 'layers') UI.renderLayers();
      if (b.dataset.ptab === 'code') UI.syncCode(true);
      if (b.dataset.ptab === 'props') UI.renderProps();
    }));

    // code
    const ta = $('#codeText');
    ta.addEventListener('input', () => { codeDirty = true; setCodeState('Editing…'); applyCode(); });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
    });
    ta.addEventListener('blur', () => { if (codeDirty) applyCode.flush(); });
    $('#codeFormat').addEventListener('click', () => UI.syncCode(true));
    $('#codeOptimize').addEventListener('click', () => {
      try {
        const o = V.optimize(ed.getText(), { precision: 2, pretty: true });
        const a = new Blob([ed.getText()]).size, b = new Blob([o]).size;
        ta.value = o;
        codeDirty = true;
        applyCode.flush();
        V.toast(`Optimised: ${(a / 1024).toFixed(1)} KB → ${(b / 1024).toFixed(1)} KB (Ctrl+Z to undo)`);
      } catch (e) { V.toast(e.message, 'err'); }
    });
    $('#codeCopy').addEventListener('click', async () => { await navigator.clipboard.writeText(ta.value); V.toast('SVG code copied'); });

    // export dialog
    $('#exportFormats').addEventListener('change', (e) => { expState.fmt = e.target.value; V.storage.set('export', expState); renderExportOpts(); });
    $('#exportName').addEventListener('input', V.debounce(updateExportInfo, 300));
    $('#exportDlg').addEventListener('close', () => { if ($('#exportDlg').returnValue === 'default') doExport(); });

    // drag & drop
    const stage = $('#stage');
    stage.addEventListener('dragover', (e) => { if (V.app.mode !== 'svg') return; if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); stage.classList.add('dragover'); } });
    stage.addEventListener('dragleave', (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('dragover'); });
    stage.addEventListener('drop', async (e) => {
      stage.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) {
        const isSvg = /svg/.test(f.type) || /\.svg$/i.test(f.name);
        if (/pdf/.test(f.type) || /\.pdf$/i.test(f.name)) { V.app.setMode('pdf'); V.pdf.openFiles([f]); return; }
        const empty = !Array.from(ed.doc.children).some((k) => !['defs', 'style', 'title', 'desc', 'metadata'].includes(k.localName));
        if (empty && files.length === 1) { await UI.openBlob(f); return; }
        if (isSvg) { const w = ed.importSnippet(await V.readAs(f, 'text')); V.toast('Imported ' + f.name + ' as a group' + (w.length ? ' — ' + w.join(', ') : '')); }
        else if (/^image\//.test(f.type)) { const d = ed.clientToDoc(e.clientX, e.clientY); await ed.insertImage(f, d); }
      }
    });

    // paste (SVG markup or images from other apps)
    document.addEventListener('paste', async (e) => {
      if (V.app.mode !== 'svg' || V.isTyping(e)) return;
      const dt = e.clipboardData;
      const file = Array.from(dt.files || []).find((f) => /^image\//.test(f.type));
      const txt = dt.getData('text/plain');
      e.preventDefault();
      try {
        if (file) {
          if (/svg/.test(file.type)) ed.importSnippet(await V.readAs(file, 'text'));
          else await ed.insertImage(file);
          return;
        }
        if (txt && /<svg[\s>]/i.test(txt) && txt !== ed._lastCopiedText) {
          const w = ed.importSnippet(txt.slice(txt.search(/<svg[\s>]/i)));
          V.toast('Pasted SVG' + (w.length ? ' — ' + w.join(', ') : ''));
          return;
        }
        if (!ed.pasteInternal() && txt && txt.trim()) {
          // plain text -> text object
          const vb = ed.vb();
          const el = V.svgEl('text', { x: fmt(vb[0] + vb[2] / 2), y: fmt(vb[1] + vb[3] / 2), 'font-family': ed.opts.fontFamily, 'font-size': ed.opts.fontSize, fill: ed.defFill, 'text-anchor': 'middle' });
          ed.setTextLines(el, txt.trim().slice(0, 2000));
          ed.ctx.appendChild(el);
          ed.select([el]); ed.commit();
        }
      } catch (err) { V.toast('Paste failed: ' + err.message, 'err'); }
    });

    // restore autosave
    const saved = V.storage.get('svg', null);
    let restored = false;
    if (saved && saved.text) {
      try {
        ed.loadText(saved.text, saved.name || 'drawing.svg');
        if (saved.meta) { ed.meta = saved.meta; ed.layoutDoc(); ed.resetHistory(); }
        restored = true;
      } catch (e) { console.warn('autosave restore failed', e); }
    }
    if (!restored) ed.newDoc(800, 600);
    ed.savedText = restored ? null : ed.getText();
    UI.renderToolOpts();
    UI.renderStatus();
    const pt = V.storage.get('ptab', 'props');
    const tb = $(`#svgMode .ptabs [data-ptab="${pt}"]`);
    if (tb) tb.click(); else UI.renderProps();
  };
})(window.V);
