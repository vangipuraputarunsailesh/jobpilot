// jobpilot/static/js/drive.js
// ── Google Drive client-side resume storage (Phase 3) ─────────────────────
// Remote resume reads/writes go directly browser → Google Drive API (no Flask
// proxy), falling back to this browser when Drive is unavailable.
// Remote resumes live in the user's own Drive `appDataFolder` — a
// hidden per-app folder that's invisible in the normal Drive UI and only
// accessible by JobsPilot. The user can revoke access at any time from
// https://myaccount.google.com/permissions.
//
// Architecture:
//   • Real users → Drive, with an account-scoped localStorage fallback.
//   • Demo users → in-browser localStorage (jp_demo_library).
//   • Local-only resumes are never automatically uploaded to Drive.
//   • Browser libraries are capped at 1000 decimal KB (1,000,000 UTF-8 bytes).
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
const LOCAL_LIBRARY_PREFIX = "jp_resume_library_v1:";
const RESUME_STORAGE_LIMIT = 1000000;
let _resumeStorageStatus = null;

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
    const error = new Error("Google Drive sign-in required: " + (e.message || e));
    error.driveUnavailable = true;
    error.storageReason = "Google Drive sign-in is unavailable";
    throw error;
  }
  const headers = Object.assign({}, opts && opts.headers, {
    "Authorization": "Bearer " + tok,
  });
  let r;
  try {
    r = await fetch(url, Object.assign({}, opts || {}, { headers }));
  } catch (_) {
    const error = new Error("Google Drive could not be reached");
    error.driveUnavailable = true;
    error.storageReason = error.message;
    error.writeUncertain = opts && /^(POST|PATCH|PUT)$/i.test(opts.method || "");
    throw error;
  }
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
    const error = new Error(detail);
    error.driveUnavailable = [401, 403, 404, 408, 429].includes(r.status) || r.status >= 500;
    error.storageReason = "Google Drive is unavailable (HTTP " + r.status + ")";
    error.writeUncertain = r.status >= 500 || r.status === 408;
    throw error;
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

// ── Public: save a resume to Drive or browser-local fallback ────────────────
// `source` is one of "upload" | "tailored" | "generated". Returns a
// normalized item object matching the library UI's expected shape.
async function saveResumeToDrive(name, content, source) {
  const safeName   = (name || "resume").toString().slice(0, 200);
  const safeSource = (source || "upload").toString().slice(0, 32);
  const safeText   = (content || "").toString();
  if (_isDemoUser()) {
    return _demoSaveResume(safeName, safeText, safeSource);
  }
  const context = _resumeStorageContext();
  const local = _readLocalLib(context);
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
  try {
    const r = await _driveFetch(url, { method: "POST", body, headers });
    let file;
    try {
      file = await r.json();
      if (!file || !file.id) throw new Error("Missing file ID");
    } catch (_) {
      const error = new Error("Google Drive did not confirm the saved resume");
      error.driveUnavailable = true;
      error.writeUncertain = true;
      error.storageReason = error.message;
      throw error;
    }
    _setResumeStorageStatus(context, local.length ? "mixed" : "drive");
    return _mapDriveFile(file);
  } catch (error) {
    if (!error.driveUnavailable) throw error;
    const reason = _fallbackReason(error);
    _setResumeStorageStatus(context, "local", reason);
    return _saveLocalResume(context, safeName, safeText, safeSource, reason);
  }
}

// ── Public: list Drive resumes together with browser-only resumes ──────────
async function listResumesFromDrive() {
  if (_isDemoUser()) return _demoListResumes();
  const context = _resumeStorageContext();
  const local = _readLocalLib(context).slice().reverse().map(_mapDemoItem);
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
  try {
    const r = await _driveFetch(url, { method: "GET" });
    const d = await r.json();
    const files = (d && d.files) || [];
    _setResumeStorageStatus(context, local.length ? "mixed" : "drive");
    return local.concat(files.map(_mapDriveFile))
      .sort((a, b) => (b.created || "").localeCompare(a.created || ""));
  } catch (error) {
    if (!error.driveUnavailable && !(error instanceof SyntaxError) &&
        !(error instanceof TypeError) && error.name !== "AbortError") throw error;
    _setResumeStorageStatus(context, "local", _fallbackReason(error));
    return local;
  }
}

// ── Public: fetch a single resume's body by file id ────────────────────────
async function getResumeFromDrive(fileId) {
  if (_isDemoUser() || String(fileId).startsWith("local_")) return _demoGetResume(fileId);
  const url = DRIVE_API_BASE + "/files/" + encodeURIComponent(fileId) + "?alt=media";
  const r = await _driveFetch(url, { method: "GET" });
  return await r.text();
}

// ── Public: delete a resume by file id ─────────────────────────────────────
async function deleteResumeFromDrive(fileId) {
  if (_isDemoUser() || String(fileId).startsWith("local_")) return _demoDeleteResume(fileId);
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
    storage:   "drive",
  };
}

// ── Account-scoped browser library; legacy demo data keeps its existing key ─
function _resumeStorageContext() {
  if (_isDemoUser()) return { key: DEMO_LIBRARY_KEY, activeKey: ACTIVE_RESUME_KEY };
  let email;
  try {
    email = (localStorage.getItem("jp_email") || "").trim().toLowerCase();
  } catch (_) {
    throw new Error("Browser resume storage is unavailable. Allow site storage and try again.");
  }
  if (!email) throw new Error("Sign in before using browser resume storage.");
  const account = encodeURIComponent(email);
  return { key: LOCAL_LIBRARY_PREFIX + account, activeKey: ACTIVE_RESUME_KEY + ":" + account };
}

function _readLocalLib(context) {
  let raw;
  try { raw = localStorage.getItem(context.key); }
  catch (_) {
    throw new Error("Browser resume storage cannot be read. Allow site storage and try again.");
  }
  if (raw === null) return [];
  try {
    const library = JSON.parse(raw);
    if (!Array.isArray(library) || library.some(item =>
      !item || typeof item.id !== "string" || typeof item.name !== "string" ||
      typeof item.content !== "string" ||
      (item.createdTime !== undefined && typeof item.createdTime !== "string") ||
      (context.key !== DEMO_LIBRARY_KEY && !item.id.startsWith("local_"))
    ) || new Set(library.map(item => item.id)).size !== library.length) {
      throw new Error("Invalid library");
    }
    return library;
  } catch (_) {
    throw new Error("Browser resume cache is malformed. Existing data was not changed. Export or recover site data before trying again.");
  }
}

function _libraryBytes(library) {
  return new TextEncoder().encode(JSON.stringify(library)).byteLength;
}

function _setResumeStorageStatus(context, mode, reason) {
  const message = (reason ? reason + ". " : "") +
    (mode === "drive" ? "Resumes saved to Google Drive." :
      mode === "mixed" ? "Google Drive and browser-only resumes are shown. Browser-only resumes are not automatically uploaded." :
        "Browser-only resume storage for this site and account; not synced to Google Drive.") +
    " Browser limit: 1000 KB (1,000,000 UTF-8 bytes, including metadata). Clearing site data removes browser-only resumes.";
  _resumeStorageStatus = { key: context.key, mode, message };
  if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("jobspilot:resume-storage", { detail: getResumeStorageStatus() }));
  }
}

function getResumeStorageStatus() {
  const context = _resumeStorageContext();
  const status = _resumeStorageStatus && _resumeStorageStatus.key === context.key
    ? _resumeStorageStatus
    : { mode: "local", message: "Browser-only resumes remain on this site. Drive availability has not been checked. Browser limit: 1000 KB (1,000,000 UTF-8 bytes, including metadata)." };
  return {
    mode: status.mode,
    message: status.message,
    usedBytes: _libraryBytes(_readLocalLib(context)),
    limitBytes: RESUME_STORAGE_LIMIT,
  };
}

function _fallbackReason(error) {
  const reason = (error.storageReason || "Google Drive could not be read") +
    (error.writeUncertain ? ". Drive save could not be confirmed; a copy may also exist in Drive. Check Drive before retrying" : "");
  console.warn("[Resume storage] " + reason);
  return reason;
}

function _writeLocalLib(context, library) {
  const serialized = JSON.stringify(library);
  if (new TextEncoder().encode(serialized).byteLength > RESUME_STORAGE_LIMIT) {
    throw new Error("Browser resume storage limit is 1000 KB (1,000,000 UTF-8 bytes, including metadata). Delete a saved browser resume or shorten this resume, then try again. No existing resumes were removed.");
  }
  try { localStorage.setItem(context.key, serialized); }
  catch (cause) {
    const error = new Error(cause && cause.name === "QuotaExceededError"
      ? "Browser storage is full. Free space for this site or delete a saved browser resume, then try again. This resume was not saved locally."
      : "Browser storage could not save this resume. Allow site storage and try again. This resume was not saved locally.");
    error.name = cause && cause.name === "QuotaExceededError" ? "QuotaExceededError" : "Error";
    throw error;
  }
}

function _saveLocalResume(context, name, content, source, reason) {
  const lib = _readLocalLib(context);
  const id = "local_" + ((typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : (Date.now() + "_" + Math.random().toString(36).slice(2, 8)));
  const item = {
    id,
    name,
    source,
    content,
    createdTime: new Date().toISOString(),
    size: content.length,
  };
  lib.push(item);
  _writeLocalLib(context, lib);
  _setResumeStorageStatus(context, "local", reason);
  return _mapDemoItem(item);
}
function _demoSaveResume(name, content, source) {
  return _saveLocalResume(_resumeStorageContext(), name, content, source);
}
function _demoListResumes() {
  const context = _resumeStorageContext();
  const items = _readLocalLib(context).slice().reverse().map(_mapDemoItem);
  _setResumeStorageStatus(context, "local");
  return items;
}
function _demoGetResume(id) {
  const it = _readLocalLib(_resumeStorageContext()).find(x => x.id === id);
  if (!it) throw new Error("Resume not found");
  return it.content;
}
function _demoDeleteResume(id) {
  const context = _resumeStorageContext();
  const lib = _readLocalLib(context).filter(x => x.id !== id);
  _writeLocalLib(context, lib);
  if (getActiveResumeId() === id) setActiveResumeId("");
  const previous = _resumeStorageStatus && _resumeStorageStatus.key === context.key ? _resumeStorageStatus.mode : "local";
  _setResumeStorageStatus(context, previous === "mixed" && !lib.length ? "drive" : previous);
  return true;
}

// Call only for an explicit clear-library action, never during sign-out.
function clearLocalResumeLibrary() {
  const context = _resumeStorageContext();
  try {
    const activeId = localStorage.getItem(context.activeKey) || "";
    localStorage.removeItem(context.key);
    if (context.key === DEMO_LIBRARY_KEY || activeId.startsWith("local_")) {
      localStorage.removeItem(context.activeKey);
    }
  } catch (_) {
    throw new Error("Browser resume library could not be completely cleared. Allow site storage and try again.");
  }
  const previous = _resumeStorageStatus && _resumeStorageStatus.key === context.key
    ? _resumeStorageStatus.mode : "local";
  _setResumeStorageStatus(context, previous === "mixed" ? "drive" : previous,
    "Browser-only resume library cleared for this account; Google Drive resumes were not deleted");
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
    storage:   "local",
  };
}

// ── Active-resume pointer (client-side, survives refresh) ──────────────────
function setActiveResumeId(id) {
  try {
    const key = _resumeStorageContext().activeKey;
    if (id) localStorage.setItem(key, String(id));
    else    localStorage.removeItem(key);
  } catch (_) {}
}
function getActiveResumeId() {
  try { return localStorage.getItem(_resumeStorageContext().activeKey) || ""; }
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
window.getResumeStorageStatus = getResumeStorageStatus;
window.clearLocalResumeLibrary = clearLocalResumeLibrary;
