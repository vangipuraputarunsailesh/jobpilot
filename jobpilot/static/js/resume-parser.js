// jobpilot/static/js/resume-parser.js
//
// Phase 4 — Client-side resume file parser (.pdf / .docx / .txt).
//
// Replaces server's `/api/upload-resume` (which used pypdf + pdfplumber +
// python-docx) for non-demo users. Demo users still hit the server so the
// shared demo flow works without forcing them to load 1 MB of PDF.js.
//
// Exposed on `window.parseResumeFile(file)` → Promise<{text, filename, source}>.
//
// CDNs (loaded via index.html before this script):
//   - pdf.js 3.11.174 (window.pdfjsLib)
//   - mammoth.js 1.6.0 (window.mammoth)

(function () {
  "use strict";

  const MAX_BYTES = 5 * 1024 * 1024; // matches server RESUME_MAX_BYTES default

  function _isDemo() {
    try { return localStorage.getItem("jp_demo") === "1"; }
    catch (_) { return false; }
  }

  function _sanitizeFilename(name) {
    if (!name) return "resume";
    // Strip any path components.
    const base = String(name).split(/[\\/]/).pop() || "resume";
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    const safeStem = stem.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "resume";
    const safeExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, "");
    return safeStem + safeExt;
  }

  async function _serverParse(file) {
    const fd = new FormData();
    fd.append("file", file);
    // Reuse authHeaders() but strip Content-Type so the browser sets the
    // multipart boundary itself.
    const headers = window.authHeaders ? window.authHeaders() : {};
    delete headers["Content-Type"];
    const r = await fetch(`${window.API || ""}/api/upload-resume`, {
      method: "POST",
      headers: headers,
      body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    return { text: j.text || "", filename: j.filename || file.name, source: "server" };
  }

  async function _parseTxt(file) {
    const text = await file.text();
    return { text: text || "", filename: _sanitizeFilename(file.name), source: "client" };
  }

  async function _parsePdf(file) {
    if (!window.pdfjsLib) throw new Error("pdf.js failed to load");
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      // Reconstruct lines using Y coordinate from each item's transform.
      const items = tc.items || [];
      const lines = new Map();
      for (const it of items) {
        const y = it.transform ? Math.round(it.transform[5]) : 0;
        if (!lines.has(y)) lines.set(y, []);
        lines.get(y).push({ x: it.transform ? it.transform[4] : 0, s: it.str || "" });
      }
      const ys = Array.from(lines.keys()).sort((a, b) => b - a);
      const out = [];
      for (const y of ys) {
        const row = lines.get(y).sort((a, b) => a.x - b.x).map(p => p.s).join(" ").trim();
        if (row) out.push(row);
      }
      pages.push(out.join("\n"));
    }
    return { text: pages.join("\n\n"), filename: _sanitizeFilename(file.name), source: "client" };
  }

  async function _parseDocx(file) {
    if (!window.mammoth) throw new Error("mammoth.js failed to load");
    const buf = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return {
      text: (result && result.value) || "",
      filename: _sanitizeFilename(file.name),
      source: "client",
    };
  }

  async function parseResumeFile(file) {
    if (!file) throw new Error("No file provided");
    if (file.size > MAX_BYTES) {
      throw new Error(`File too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB)`);
    }

    // Demo users go through server — keeps demo flow & quota intact.
    if (_isDemo()) {
      return _serverParse(file);
    }

    const name = (file.name || "").toLowerCase();
    try {
      if (name.endsWith(".txt"))  return await _parseTxt(file);
      if (name.endsWith(".pdf"))  return await _parsePdf(file);
      if (name.endsWith(".docx")) return await _parseDocx(file);
    } catch (e) {
      console.warn("[resume-parser] Client parse failed, falling back to server:", e);
      // Fall through to server as last resort.
      return _serverParse(file);
    }
    throw new Error("Unsupported file type. Use .pdf, .docx, or .txt");
  }

  window.parseResumeFile = parseResumeFile;
})();
