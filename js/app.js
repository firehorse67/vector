/* App shell: mode switching, theme, global keyboard. */
'use strict';
(function (V) {
  const { $, $$ } = V;
  const app = V.app = { mode: 'svg' };

  app.setMode = (m) => {
    if (m === app.mode) return;
    V.svgUI.finishTextEdit && V.svgUI.finishTextEdit();
    app.mode = m;
    $$('.modes [data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
    $('#svgMode').hidden = m !== 'svg';
    $('#pdfMode').hidden = m !== 'pdf';
    $$('.top-actions').forEach((t) => { t.hidden = t.dataset.for !== m; });
    try { localStorage.setItem('vector:mode', m); } catch (e) {}
    if (m === 'svg') { V.ed.redraw(); V.ed.drawGrid(); } else V.pdf.renderAll();
  };

  app.sendSvgToPdf = () => {
    const text = V.ed.getText();
    if (!V.ed.doc.children.length) { V.toast('The drawing is empty'); return; }
    app.setMode('pdf');
    V.pdf.receiveSvg(text);
  };

  const toggleTheme = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('vector:theme', root.dataset.theme); } catch (e) {}
  };

  document.addEventListener('DOMContentLoaded', () => {
    V.svgUI.init();
    V.pdf.init();

    $$('.modes [data-mode]').forEach((b) => b.addEventListener('click', () => app.setMode(b.dataset.mode)));
    $('#themeBtn').addEventListener('click', toggleTheme);
    $('#helpBtn').addEventListener('click', () => $('#helpDlg').showModal());

    document.addEventListener('keydown', (e) => {
      if (document.querySelector('dialog[open]')) return;
      if (V.isTyping(e)) return;
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) { $('#helpDlg').showModal(); e.preventDefault(); return; }
      const handled = app.mode === 'svg' ? V.svgUI.key(e) : V.pdf.key(e);
      if (handled) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => { if (app.mode === 'svg') V.ed.keyUp(e); });
    // don't let a stray file drop navigate away from the app
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    let m = 'svg';
    try { m = localStorage.getItem('vector:mode') || 'svg'; } catch (e) {}
    if (m === 'pdf') { app.mode = 'svg'; app.setMode('pdf'); }
  });
})(window.V);
