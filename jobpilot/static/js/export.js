// jobpilot/static/js/export.js
//
// Phase 4 — Client-side resume exporter (PDF / DOCX / TXT).
//
// Replaces server's `/api/download`. Visual drift vs the server's WeasyPrint
// output is accepted per the Phase 4 plan — the static deploy has no Python
// backend and renders everything in the browser via jsPDF + docx.js.
//
// Exposed on window:
//   downloadResumeText(content, filename)
//   downloadResumePdf(content, filename, opts={fitPages: 1|2|null})
//   downloadResumeDocx(content, filename)
//   downloadResume(content, filename, format='pdf'|'docx'|'txt', opts)
//
// CDNs (loaded via index.html before this script):
//   - jsPDF 2.5.1 (window.jspdf.jsPDF)
//   - docx.js 8.2.2 (window.docx)

(function () {
  "use strict";

  function _saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function _ensureExt(name, ext) {
    if (!name) name = "resume";
    const lower = name.toLowerCase();
    return lower.endsWith(ext) ? name : name + ext;
  }

  // ---- Plain text -----------------------------------------------------------

  function downloadResumeText(content, filename) {
    const blob = new Blob([content || ""], { type: "text/plain;charset=utf-8" });
    _saveBlob(blob, _ensureExt(filename, ".txt"));
  }

  // ---- PDF (jsPDF) ----------------------------------------------------------

  // Simple Markdown-ish line classifier.
  function _classifyLine(raw) {
    const line = (raw || "");
    const t = line.trim();
    if (!t) return { kind: "blank" };
    if (/^#\s/.test(t))      return { kind: "h1", text: t.replace(/^#\s+/, "") };
    if (/^##\s/.test(t))     return { kind: "h2", text: t.replace(/^##\s+/, "") };
    if (/^###\s/.test(t))    return { kind: "h3", text: t.replace(/^###\s+/, "") };
    if (/^[-*•]\s/.test(t))  return { kind: "bullet", text: t.replace(/^[-*•]\s+/, "") };
    // Bold company/job/date line: **Company** | **Title** | Date
    if (/\*\*/.test(t))      return { kind: "bold-mixed", text: t };
    // Italic location line
    if (/^\*[^*].*\*$/.test(t)) return { kind: "italic", text: t.replace(/^\*|\*$/g, "") };
    return { kind: "para", text: t };
  }

  // Render the parsed lines into a jsPDF doc at a given font scale. Returns
  // the number of pages produced.
  function _renderPdf(doc, lines, scale) {
    const MARGIN = 40;
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const usableW = pageW - 2 * MARGIN;
    const baseSize = 10;
    const size = baseSize * scale;
    const leading = size * 1.3;

    let y = MARGIN;
    doc.setFont("times", "normal");
    doc.setFontSize(size);

    function ensureSpace(needed) {
      if (y + needed > pageH - MARGIN) {
        doc.addPage();
        y = MARGIN;
      }
    }

    function writeWrapped(text, opts) {
      opts = opts || {};
      const indent = opts.indent || 0;
      const fontStyle = opts.bold ? "bold" : (opts.italic ? "italic" : "normal");
      const fontSize = opts.size || size;
      doc.setFont(opts.font || "times", fontStyle);
      doc.setFontSize(fontSize);
      const wrapped = doc.splitTextToSize(text, usableW - indent);
      for (const w of wrapped) {
        ensureSpace(fontSize * 1.3);
        doc.text(w, MARGIN + indent, y);
        y += fontSize * 1.3;
      }
    }

    // Render mixed-bold lines (markdown `**bold**` spans) on a single visual line.
    function writeBoldMixed(text) {
      const parts = text.split(/(\*\*[^*]+\*\*)/g);
      let x = MARGIN;
      ensureSpace(size * 1.3);
      for (const p of parts) {
        if (!p) continue;
        if (p.startsWith("**") && p.endsWith("**")) {
          doc.setFont("times", "bold");
          const txt = p.slice(2, -2);
          doc.text(txt, x, y);
          x += doc.getTextWidth(txt);
        } else {
          doc.setFont("times", "normal");
          doc.text(p, x, y);
          x += doc.getTextWidth(p);
        }
      }
      y += size * 1.3;
    }

    for (const ln of lines) {
      switch (ln.kind) {
        case "blank":
          y += leading * 0.4;
          break;
        case "h1":
          y += leading * 0.3;
          writeWrapped(ln.text, { bold: true, size: size * 1.6 });
          break;
        case "h2":
          y += leading * 0.5;
          writeWrapped(ln.text.toUpperCase(), { bold: true, size: size * 1.15 });
          // Underline
          ensureSpace(2);
          doc.setLineWidth(0.5);
          doc.line(MARGIN, y - leading * 0.4, pageW - MARGIN, y - leading * 0.4);
          break;
        case "h3":
          writeWrapped(ln.text, { bold: true, size: size * 1.05 });
          break;
        case "bold-mixed":
          writeBoldMixed(ln.text);
          break;
        case "italic":
          writeWrapped(ln.text, { italic: true });
          break;
        case "bullet":
          ensureSpace(leading);
          doc.setFont("times", "normal");
          doc.setFontSize(size);
          doc.text("•", MARGIN + 6, y);
          writeWrapped(ln.text, { indent: 18 });
          break;
        default:
          writeWrapped(ln.text);
      }
    }
    return doc.internal.getNumberOfPages();
  }

  function downloadResumePdf(content, filename, opts) {
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error("jsPDF failed to load");
    const lines = (content || "").split("\n").map(_classifyLine);
    const fitPages = opts && opts.fitPages;

    let scale = 1.0;
    let doc = new window.jspdf.jsPDF({ unit: "pt", format: "letter" });
    let pages = _renderPdf(doc, lines, scale);

    // Simple shrink-to-fit when caller asks for it.
    if (fitPages && pages > fitPages) {
      for (let i = 0; i < 6 && pages > fitPages; i++) {
        scale = Math.max(0.7, scale - 0.05);
        doc = new window.jspdf.jsPDF({ unit: "pt", format: "letter" });
        pages = _renderPdf(doc, lines, scale);
      }
    }

    doc.save(_ensureExt(filename, ".pdf"));
  }

  // ---- DOCX (docx.js) -------------------------------------------------------

  async function downloadResumeDocx(content, filename) {
    if (!window.docx) throw new Error("docx.js failed to load");
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = window.docx;

    const paragraphs = [];
    for (const raw of (content || "").split("\n")) {
      const cls = _classifyLine(raw);
      switch (cls.kind) {
        case "blank":
          paragraphs.push(new Paragraph(""));
          break;
        case "h1":
          paragraphs.push(new Paragraph({
            text: cls.text,
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
          }));
          break;
        case "h2":
          paragraphs.push(new Paragraph({
            text: cls.text.toUpperCase(),
            heading: HeadingLevel.HEADING_2,
          }));
          break;
        case "h3":
          paragraphs.push(new Paragraph({
            text: cls.text,
            heading: HeadingLevel.HEADING_3,
          }));
          break;
        case "bullet":
          paragraphs.push(new Paragraph({
            text: cls.text,
            bullet: { level: 0 },
          }));
          break;
        case "italic":
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: cls.text, italics: true })],
          }));
          break;
        case "bold-mixed": {
          const parts = cls.text.split(/(\*\*[^*]+\*\*)/g);
          const runs = [];
          for (const p of parts) {
            if (!p) continue;
            if (p.startsWith("**") && p.endsWith("**")) {
              runs.push(new TextRun({ text: p.slice(2, -2), bold: true }));
            } else {
              runs.push(new TextRun({ text: p }));
            }
          }
          paragraphs.push(new Paragraph({ children: runs }));
          break;
        }
        default:
          paragraphs.push(new Paragraph(cls.text));
      }
    }

    const doc = new Document({
      sections: [{
        properties: {
          page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } },
        },
        children: paragraphs,
      }],
    });

    const blob = await Packer.toBlob(doc);
    _saveBlob(blob, _ensureExt(filename, ".docx"));
  }

  // ---- Unified entry point --------------------------------------------------

  async function downloadResume(content, filename, format, opts) {
    format = (format || "pdf").toLowerCase();

    if (format === "txt") return downloadResumeText(content, filename);
    if (format === "pdf") return downloadResumePdf(content, filename, opts);
    if (format === "docx") return await downloadResumeDocx(content, filename);
    throw new Error(`Unknown format: ${format}`);
  }

  window.downloadResumeText = downloadResumeText;
  window.downloadResumePdf = downloadResumePdf;
  window.downloadResumeDocx = downloadResumeDocx;
  // NOTE: We intentionally do NOT expose `downloadResume` on `window` —
  // app.js defines its own top-level `downloadResume(fmt, fitPages)` for
  // legacy onclick handlers and that function dispatches to the helpers
  // above. Exposing both would create a global name collision.
})();
