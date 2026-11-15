# Vector — SVG & PDF editor

A local-only vector drawing and PDF editing tool. It's a static page with no server, build step or account, and it makes no network requests. Open `index.html` in Chrome (or use the **Vector** launcher) and everything runs on this computer.

**Nothing is uploaded. No analytics, no ads, no tracking.**

---

## SVG editor

**Drawing tools:** select, edit nodes, pan, rectangle (with corner radius), ellipse, line, polygon, star, pen (Bézier), freehand (auto-smoothed), text, image, eyedropper.

**Editing**
- Move, resize (Shift keeps proportions, Alt resizes from the centre) and rotate (Shift snaps to 15°). Alt-drag duplicates.
- Resizing writes clean geometry (`x`/`width`, `d`, `points`…) instead of piling up `transform` attributes, whenever that's possible.
- Node editing: drag anchors and handles (smooth curves stay smooth; Alt breaks them). You can add and delete nodes, switch a segment between curve and line, and close or open a path. Double-click a path to add a node.
- Group and ungroup (inherited styles are carried over), double-click to edit inside a group, z-order, align and distribute, flip, rotate 90°, convert shapes to paths.
- Fill: none, solid, linear or radial gradient (stop colours and angle). Stroke: colour, width, dash style, caps, joins, opacity.
- Inline text editing: multi-line, font, size, weight, italic, alignment, letter spacing.
- Grid with snapping, zoom (Ctrl+scroll at the pointer), unlimited undo/redo.
- **Layers panel:** tree view with hide, lock, rename and drag-to-reorder.
- **Code panel:** live two-way SVG source. Edits apply as you type; invalid markup is reported, not applied.

**Files**
- Open SVG, PNG, JPEG, WebP or GIF; drag-and-drop; paste SVG markup or images from other apps.
- Ctrl+S saves back to the same file (File System Access API).
- Your work is autosaved in this browser and restored the next time you open the app.
- Imported SVGs are **sanitised**: scripts, event handlers, `javascript:` links and external resources are removed.

**Export:** SVG · optimised SVG (strips editor junk and unused IDs, rounds numbers, shortens colours) · PNG / JPEG / WebP at any scale · **vector PDF** · raster PDF (exact appearance) · React component · data URI · favicon set (`favicon.ico` + 180/192/512 PNGs saved into a folder you pick).

## PDF editor

**Pages:** open, merge (add PDFs or images as pages), drag to reorder, rotate, delete, duplicate, insert a blank page, extract selected pages, split in two.

**On the page:** text (Helvetica / Times / Courier, bold, multi-line, edited in place), highlight, rectangle, ellipse, line, arrow, freehand ink, white-out, **redaction**, images, a drawn signature (stored as vector strokes; can be remembered on this computer), and the current SVG drawing placed as **vector graphics**.

**Forms:** fill text fields, checkboxes, dropdowns and radio groups, optionally flattening them on save.

**Document:** edit or clear the title, author, subject and keywords.

**Bridging the two editors:** the SVG editor's **To PDF** button places your drawing on the current PDF page, or starts a new PDF at the drawing's size.

### How redaction works
White-out only *covers* content; the text underneath is still in the file. **Redact** is the real thing: when you save, each page with a redaction box is rendered to an image with the box burnt in, so the covered text and graphics are gone. That page then has no selectable text.

### Saving notes
- Normal pages keep their original vector content and text. Deleted pages are removed, and their content streams are dropped from the file.
- Pages from **encrypted** PDFs are saved as images, because pdf-lib can't re-encrypt them. Password-protected PDFs open after you enter the password.
- Text you add uses the 14 standard PDF fonts, so Western European characters work but other scripts (CJK, Arabic, emoji…) are replaced with `?`.

## Vector-PDF export limits (SVG → PDF)
Shapes, paths, arcs, `<use>`/symbols, nested SVGs, images, dashes, caps, joins and opacity are exact. Gradients become a flat average colour. Filters, masks, clip paths and markers are skipped. Text is set in the nearest standard PDF font, glyph by glyph, at the browser's layout positions. If something looks off, use **PDF raster** for an exact image.

## Keyboard
Press **?** in the app for the full list. Highlights: `V A H R E L G S P F T I K` tools · Ctrl+Z / Ctrl+Shift+Z · Ctrl+C X V D · Ctrl+G / Ctrl+Shift+G · Ctrl+] / [ · arrows nudge (Shift ×10) · Enter / double-click edits · Esc finishes · Shift+1 fit, 1 = 100%.

## Files
```
index.html            app shell, icons, dialogs
css/app.css           styles (light/dark)
js/util.js            helpers, SVG sanitiser, file saving
js/path.js            path parsing, arcs→Béziers, transforms, simplification
js/svg2pdf.js         live SVG → vector PDF drawing (pdf-lib operators)
js/svg-editor.js      editor engine: view, selection, tools, transforms, undo
js/svg-ui.js          panels, export, optimiser, files, keyboard
js/pdf-editor.js      PDF editor (pdf.js rendering, pdf-lib writing)
js/app.js             mode switching, theme
vendor/               pdf.js 3.11.174, pdf-lib 1.17.1 (see vendor/LICENSES.md)
Vector.desktop        launcher (copied to ~/.local/share/applications)
```

## Security
- A strict Content-Security-Policy allows only local scripts, with no `eval` and no network connections.
- Imported SVG is sanitised before it touches the page. PDFs are parsed by pdf.js with `isEvalSupported: false`.
- The only persistent storage is this browser's localStorage: the autosaved drawing, preferences and (if you tick the box) your signature.

## Licence
MIT — see [LICENSE](LICENSE). Bundled libraries keep their own licences (see [vendor/LICENSES.md](vendor/LICENSES.md)).
