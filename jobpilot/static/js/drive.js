// jobpilot/static/js/drive.js
// ── Google Drive client-side resume storage (Phase 3) ─────────────────────
// All resume reads/writes go directly browser → Google Drive API (no Flask
// proxy). The user's resumes live in their own Drive `appDataFolder` — a
// hidden per-app folder that's invisible in the normal Drive UI and only
// accessible by JobPilot. The user can revoke access at any time from
// https://myaccount.google.com/permissions.
//
// Architecture:
//   • Real users (Google sign-in) → Drive appDataFolder via REST v3.
//   • Demo users (no Google token) → in-browser localStorage (jp_demo_library).
//   • Active-resume pointer:        localStorage.jp_active_resume_id.
//
// Token handling: getGoogleToken() (defined in app.js) silently re-mints
// expired tokens via Google Identity Services. Every Drive call goes through
// _driveFetch() which retries once on 401 with a forced fresh token.
//
// Drive file shape (resumes):
//   • mimeType:       text/plain (resume body)
//   • parents:        ["appDataFolder"]
//   • appProperties:  { kind: "resume",
//                        source: "upload"|"tailored"|"generated",
//                        updated: ISO8601 }
//   • name:           the user-facing display name.
//
// Drive file shape (settings):
//   • A single jobpilot-settings.json with appProperties.kind = "settings".
//     Used for optional cross-device BYOK key sync (encrypted blob; the
//     encryption is audited in Phase 7).
//
// IMPORTANT: This file MUST be loaded BEFORE app.js — app.js calls
// window.saveResumeToDrive() etc. at user-action time, but the symbols
// must already exist on `window`.

const DRIVE_API_BASE     = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD       = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_APP_FOLDER   = "appDataFolder";
const SETTINGS_FILE_NAME = "jobpilot-settings.json";
const DEMO_LIBRARY_KEY   = "jp_demo_library";
const ACTIVE_RESUME_KEY  = "jp_active_resume_id";

function _isDemoUser() {
  try { return localStorage.getItem("jp_demo") === "1"; }
  catch (_) { return false; }
}

// ── Internal: authenticated Drive REST call with one silent-refresh retry ──
async function _driveFetch(url, opts, _retried) {
  // getGoogleToken() (in app.js) checks the cached jp_gtoken first and
  // silently re-mints if expired. We trust it for the first attempt; on 401
  // we drop the cache and force a fresh fetch.
  let tok;
  try {
    tok = await getGoogleToken();
  } catch (e) {
    throw new Error("Google Drive sign-in required: " + (e.message || e));
  }
  const headers = Object.assign({}, opts && opts.headers, {
    "Authorization": "Bearer " + tok,
  });
  const r = await fetch(url, Object.assign({}, opts || {}, { headers }));
  if (r.status === 401 && !_retried) {
    try {
      localStorage.removeItem("jp_gtoken");
      localStorage.removeItem("jp_gtoken_expiry");
    } catch (_) {}
    return _driveFetch(url, opts, true);
  }
  if (!r.ok) {
    let detail = "Drive API " + r.status;
    try {
      const e = await r.json();
      detail = (e && e.error && e.error.message) || detail;
    } catch (_) {}
    throw new Error(detail);
  }
  return r;
}

// ── Internal: build a multipart/related body for Drive uploads ─────────────
// Drive's multipart upload protocol is: boundary, metadata-JSON, boundary,
// data, end-boundary. We hand-roll it because pulling in the official
// googleapis JS client is 200+ KB for what amounts to four endpoints.
function _multipartBody(metadata, content, contentType) {
  const boundary = "jp_drive_" + Math.random().toString(36).slice(2);
  const delim    = "\r\n--" + boundary + "\r\n";
  const close    = "\r\n--" + boundary + "--";
  const body =
    delim +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    delim +
    "Content-Type: " + (contentType || "text/plain") + "; charset=UTF-8\r\n\r\n" +
    (content || "") +
    close;
  return {
    body,
    headers: { "Content-Type": "multipart/related; boundary=" + boundary },
  };
}

// ── Public: save a resume to Drive (or demo localStorage) ──────────────────
// `source` is one of "upload" | "tailored" | "generated". Returns a
// normalized item object matching the library UI's expected shape.
async function saveResumeToDrive(name, content, source) {
  const safeName   = (name || "resume").toString().slice(0, 200);
  const safeSource = (source || "upload").toString().slice(0, 32);
  const safeText   = (content || "").toString();
  if (_isDemoUser()) {
    return _demoSaveResume(safeName, safeText, safeSource);
  }
  const metadata = {
    name: safeName,
    mimeType: "text/plain",
    parents: [DRIVE_APP_FOLDER],
    appProperties: {
      kind: "resume",
      source: safeSource,
      updated: new Date().toISOString(),
    },
  };
  const { body, headers } = _multipartBody(metadata, safeText, "text/plain");
  const url = DRIVE_UPLOAD +
              "/files?uploadType=multipart" +
              "&fields=id,name,createdTime,size,appProperties";
  const r = await _driveFetch(url, { method: "POST", body, headers });
  const file = await r.json();
  return _mapDriveFile(file);
}

// ── Public: list every resume this app has saved in the user's Drive ───────
async function listResumesFromDrive() {
  if (_isDemoUser()) return _demoListResumes();
  const q = encodeURIComponent(
    "appProperties has { key='kind' and value='resume' } and trashed=false"
  );
  const fields = encodeURIComponent("files(id,name,createdTime,size,appProperties)");
  const url = DRIVE_API_BASE + "/files" +
              "?spaces=" + DRIVE_APP_FOLDER +
              "&q=" + q +
              "&fields=" + fields +
              "&pageSize=50" +
              "&orderBy=createdTime desc";
  const r = await _driveFetch(url, { method: "GET" });
  const d = await r.json();
  const files = (d && d.files) || [];
  return files.map(_mapDriveFile);
}

// ── Public: fetch a single resume's body by file id ────────────────────────
async function getResumeFromDrive(fileId) {
  if (_isDemoUser()) return _demoGetResume(fileId);
  const url = DRIVE_API_BASE + "/files/" + encodeURIComponent(fileId) + "?alt=media";
  const r = await _driveFetch(url, { method: "GET" });
  return await r.text();
}

// ── Public: delete a resume by file id ─────────────────────────────────────
async function deleteResumeFromDrive(fileId) {
  if (_isDemoUser()) return _demoDeleteResume(fileId);
  const url = DRIVE_API_BASE + "/files/" + encodeURIComponent(fileId);
  await _driveFetch(url, { method: "DELETE" });
  if (getActiveResumeId() === fileId) setActiveResumeId("");
  return true;
}

// ── Public: settings file (single jobpilot-settings.json) ──────────────────
// Used for optional cross-device BYOK key sync. The value is opaque to
// drive.js — pass in any JSON-serializable object (encryption happens in
// the BYOK module).
async function saveSettingsToDrive(settingsJson) {
  if (_isDemoUser()) throw new Error("Settings sync requires Google sign-in");
  const json = typeof settingsJson === "string"
    ? settingsJson
    : JSON.stringify(settingsJson);
  const existing = await _findSettingsFileId();
  const metadata = {
    name: SETTINGS_FILE_NAME,
    mimeType: "application/json",
    appProperties: { kind: "settings", updated: new Date().toISOString() },
  };
  if (!existing) metadata.parents = [DRIVE_APP_FOLDER];
  const { body, headers } = _multipartBody(metadata, json, "application/json");
  const method = existing ? "PATCH" : "POST";
  const url = DRIVE_UPLOAD + "/files" +
              (existing ? "/" + encodeURIComponent(existing) : "") +
              "?uploadType=multipart&fields=id";
  const r = await _driveFetch(url, { method, body, headers });
  const file = await r.json();
  return file.id;
}

async function getSettingsFromDrive() {
  if (_isDemoUser()) return null;
  const id = await _findSettingsFileId();
  if (!id) return null;
  const url = DRIVE_API_BASE + "/files/" + encodeURIComponent(id) + "?alt=media";
  const r = await _driveFetch(url, { method: "GET" });
  try { return await r.json(); } catch (_) { return null; }
}

async function _findSettingsFileId() {
  const q = encodeURIComponent(
    "appProperties has { key='kind' and value='settings' } and trashed=false"
  );
  const url = DRIVE_API_BASE + "/files" +
              "?spaces=" + DRIVE_APP_FOLDER +
              "&q=" + q +
              "&fields=files(id,name)" +
              "&pageSize=5";
  const r = await _driveFetch(url, { method: "GET" });
  const d = await r.json();
  const files = (d && d.files) || [];
  return files.length ? files[0].id : null;
}

// ── Internal: normalize Drive file shape to the UI's existing item shape ───
// The library UI expects: {id, name, source, created, chars, preview, is_active}
// Preview stays empty for Drive items because fetching each file body just to
// build a preview would be 1+N requests per list call.
function _mapDriveFile(file) {
  const props = (file && file.appProperties) || {};
  const size  = parseInt(file.size || "0", 10) || 0;
  return {
    id:        String(file.id),
    name:      file.name || "resume",
    source:    props.source || "upload",
    created:   file.createdTime || "",
    chars:     size,
    preview:   "",
    is_active: getActiveResumeId() === String(file.id),
  };
}

// ── Demo-mode localStorage fallback (no Drive) ─────────────────────────────
function _readDemoLib() {
  try {
    const raw = localStorage.getItem(DEMO_LIBRARY_KEY) || "[]";
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
function _writeDemoLib(arr) {
  try { localStorage.setItem(DEMO_LIBRARY_KEY, JSON.stringify(arr)); }
  catch (_) {}
}
function _demoSaveResume(name, content, source) {
  const lib = _readDemoLib();
  // Cap at 20 to match the legacy server-side library limit.
  if (lib.length >= 20) lib.shift();
  const id = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : ("demo_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
  const item = {
    id,
    name,
    source,
    content,
    createdTime: new Date().toISOString(),
    size: content.length,
  };
  lib.push(item);
  _writeDemoLib(lib);
  return _mapDemoItem(item);
}
function _demoListResumes() {
  // Newest first, matching Drive's orderBy=createdTime desc.
  return _readDemoLib().slice().reverse().map(_mapDemoItem);
}
function _demoGetResume(id) {
  const it = _readDemoLib().find(x => x.id === id);
  if (!it) throw new Error("Resume not found");
  return it.content;
}
function _demoDeleteResume(id) {
  const lib = _readDemoLib().filter(x => x.id !== id);
  _writeDemoLib(lib);
  if (getActiveResumeId() === id) setActiveResumeId("");
  return true;
}
function _mapDemoItem(it) {
  return {
    id:        it.id,
    name:      it.name,
    source:    it.source || "upload",
    created:   it.createdTime,
    chars:     it.size || (it.content ? it.content.length : 0),
    preview:   (it.content || "").slice(0, 200),
    is_active: getActiveResumeId() === it.id,
  };
}

// ── Active-resume pointer (client-side, survives refresh) ──────────────────
function setActiveResumeId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_RESUME_KEY, String(id));
    else    localStorage.removeItem(ACTIVE_RESUME_KEY);
  } catch (_) {}
}
function getActiveResumeId() {
  try { return localStorage.getItem(ACTIVE_RESUME_KEY) || ""; }
  catch (_) { return ""; }
}

// Expose to window so app.js (loaded after this file) can call them.
window.saveResumeToDrive     = saveResumeToDrive;
window.listResumesFromDrive  = listResumesFromDrive;
window.getResumeFromDrive    = getResumeFromDrive;
window.deleteResumeFromDrive = deleteResumeFromDrive;
window.saveSettingsToDrive   = saveSettingsToDrive;
window.getSettingsFromDrive  = getSettingsFromDrive;
window.setActiveResumeId     = setActiveResumeId;
window.getActiveResumeId     = getActiveResumeId;
