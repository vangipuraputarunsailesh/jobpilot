/**
 * app.js  —  JobPilot static-site frontend (Phase 1–5)
 *
 * JobPilot is a static GitHub Pages app. There is no backend, no `/api/*`
 * surface, and no server-side state. All sensitive work happens in the
 * browser, against the user's own provider credentials.
 *
 * Subsystems handled in this file:
 *   - Auth: Google Identity Services only. The ID token is decoded
 *     client-side for display name + email; we never call a backend to
 *     verify it (we have no backend to verify it against).
 *   - BYOK vault wiring. The actual AES-GCM crypto lives in byok.js;
 *     this file binds it to the Settings UI and the per-provider key tests.
 *   - Settings UI: providers, key tests, API Usage panel
 *     (reads localStorage.jp_usage_v1, written by ai.js + jobs.js).
 *   - Job-search orchestration. The Cloudflare Worker URL (saved in the
 *     BYOK vault as `cf_worker_url`) is the sole remote endpoint; the
 *     actual fetch + results rendering lives in jobs.js.
 *   - Tailor / Score / Chat plumbing. The real Anthropic calls live in
 *     ai.js; this file only wires the buttons.
 *   - Drive resume import/export (delegated to drive.js).
 *   - Resume parsing (delegated to resume-parser.js, pdf.js + mammoth.js).
 *   - Export to PDF/DOCX (delegated to export.js, jsPDF + docx.js).
 *   - Toasts, modals, hash-route handling, theme.
 */
const LAYOUT_STORAGE_KEY = "jobpilot-layout-widths";

// ── Auth ──────────────────────────────────────────────────────────────────────
//
// All login / register / Google flows live on the landing page (templates/landing.html).
// app.js only runs on /app, where users are already authenticated, so we
// intentionally do NOT duplicate the auth form, `_authTab` state, or the
// `switchAuthTab`/`submitAuth` handlers here (Issues #41, #42). Keep this
// module focused on the in-app experience.

function getToken() { return localStorage.getItem("jp_token"); }
function getEmail()  { return localStorage.getItem("jp_email"); }

// ── Sliding-TTL login session helpers ───────────────────────────────────
// localStorage-only so the session survives tab close / browser restart;
// `jp_session_expiry` (ms-since-epoch) drives auto-logout. Real accounts
// get 7 days, demo accounts 24 hours. Mirrored in templates/landing.html
// and templates/index.html — keep all three in sync.
const SESSION_TTL_MS      = 7 * 24 * 60 * 60 * 1000;
const DEMO_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
function _sessionTtl() {
  return localStorage.getItem("jp_demo") === "1" ? DEMO_SESSION_TTL_MS : SESSION_TTL_MS;
}
function setLoginSession(token, email, opts) {
  localStorage.setItem("jp_token", token);
  localStorage.setItem("jp_email", email);
  if (opts && opts.demo) localStorage.setItem("jp_demo", "1");
  localStorage.setItem("jp_session_expiry", String(Date.now() + _sessionTtl()));
  sessionStorage.removeItem("jp_session_active"); // legacy key
}
function clearLoginSession() {
  localStorage.removeItem("jp_token");
  localStorage.removeItem("jp_email");
  localStorage.removeItem("jp_demo");
  localStorage.removeItem("jp_session_expiry");
  // Phase 1: drop the Google access_token + expiry alongside the JobPilot
  // session. We never want a stale Drive token surviving sign-out.
  localStorage.removeItem("jp_gtoken");
  localStorage.removeItem("jp_gtoken_expiry");
  // Phase 2 BYOK: drop the user's encrypted keys + in-memory cache so a
  // shared browser can't leak the previous user's keys into the next
  // sign-in. The seed (their email) changes on the next login anyway,
  // but we belt-and-suspender it.
  try { byokClear(); } catch (_) {}
  // Phase 3: drop the client-side Drive state (active-resume pointer + demo
  // library). The Drive files themselves stay in the user's account.
  localStorage.removeItem("jp_active_resume_id");
  localStorage.removeItem("jp_demo_library");
  sessionStorage.removeItem("jp_session_active");
  sessionStorage.removeItem("jp_session_history");
}
function isLoginSessionValid() {
  if (!getToken()) return false;
  const expiry = parseInt(localStorage.getItem("jp_session_expiry") || "0", 10);
  return !!expiry && Date.now() < expiry;
}

function authHeaders() {
  const t = getToken();
  const base = t ? { "Content-Type": "application/json", "Authorization": `Bearer ${t}` }
                 : { "Content-Type": "application/json" };
  // Phase 2 BYOK: every authenticated request also carries the user's
  // per-provider API keys so the server can call Anthropic / RapidAPI /
  // Adzuna / USAJobs on their behalf without a server-side env var.
  // `_byokHeaders()` returns an empty object if the user hasn't saved
  // any keys yet (in which case Claude routes will respond 400 with
  // `byok_required` and the frontend surfaces a "open Settings" toast).
  Object.assign(base, _byokHeaders());
  return base;
}

// ── BYOK (Bring Your Own Key) — client-side encrypted key vault ──────────────
//
// Phase 2 of the refactor. User pastes their Anthropic / RapidAPI / Adzuna /
// USAJobs keys into the Settings modal; we encrypt the JSON blob with
// AES-GCM using a key derived from their signed-in email (PBKDF2-SHA-256,
// 200k iterations) and persist the ciphertext under `jp_byok_v1`. On every
// app load we decrypt back into the in-memory `_byokPlain` cache so
// `authHeaders()` can inject the headers synchronously.
//
// IMPORTANT: this is *not* zero-knowledge security — anyone with the user's
// email + access to their localStorage can decrypt. The point is to (a)
// keep the keys off our server entirely and (b) make casual localStorage
// inspection (devtools, browser extensions) show ciphertext instead of
// plaintext API keys. For the real threat model see Phase 5.
const BYOK_STORAGE_KEY = "jp_byok_v1";
const BYOK_PBKDF2_ITERS = 200_000;
const BYOK_SALT_BYTES = new TextEncoder().encode("jobpilot-byok-v1");

// In-memory plaintext cache. Keys: anthropic, claude_model, rapidapi,
// adzuna_id, adzuna_key, usajobs_email, usajobs_key, cf_worker_url
// (Phase 5 — Cloudflare Worker URL for client-side job search). Empty
// object when no keys have ever been saved (or after `byokClear()`).
let _byokPlain = {};
let _byokLoaded = false;

function _byokHeaders() {
  const out = {};
  if (!_byokLoaded) return out;
  const p = _byokPlain || {};
  if (p.anthropic)     out["X-Anthropic-Key"]  = p.anthropic;
  if (p.claude_model)  out["X-Claude-Model"]   = p.claude_model;
  if (p.rapidapi)      out["X-RapidAPI-Key"]   = p.rapidapi;
  if (p.adzuna_id)     out["X-Adzuna-App-Id"]  = p.adzuna_id;
  if (p.adzuna_key)    out["X-Adzuna-App-Key"] = p.adzuna_key;
  if (p.usajobs_email) out["X-USAJobs-Email"]  = p.usajobs_email;
  if (p.usajobs_key)   out["X-USAJobs-Key"]    = p.usajobs_key;
  return out;
}

async function _byokDeriveKey(seed) {
  if (!seed) throw new Error("byok: missing seed");
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey(
    "raw", enc.encode(seed), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: BYOK_SALT_BYTES, iterations: BYOK_PBKDF2_ITERS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function _b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function _b64decode(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function _byokEncrypt(plain, seed) {
  const key = await _byokDeriveKey(seed);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(plain));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return JSON.stringify({ v: 1, iv: _b64encode(iv), ct: _b64encode(ct) });
}

async function _byokDecrypt(blob, seed) {
  const obj = JSON.parse(blob);
  if (!obj || obj.v !== 1 || !obj.iv || !obj.ct) throw new Error("byok: bad blob");
  const key = await _byokDeriveKey(seed);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: _b64decode(obj.iv) }, key, _b64decode(obj.ct)
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

// Called once during initApp() on every page load. Loads encrypted keys
// from localStorage into the in-memory `_byokPlain` cache. Silently no-ops
// if the user hasn't saved any keys yet, isn't signed in, or the blob is
// corrupted (the Settings modal will let them re-enter their keys).
async function byokInit() {
  _byokLoaded = true;  // mark loaded even on empty, so headers() returns {}
  const blob = localStorage.getItem(BYOK_STORAGE_KEY);
  const seed = getEmail();
  if (!blob || !seed) return;
  try {
    _byokPlain = await _byokDecrypt(blob, seed) || {};
  } catch (e) {
    console.warn("byok: failed to decrypt stored keys; clearing", e);
    localStorage.removeItem(BYOK_STORAGE_KEY);
    _byokPlain = {};
  }
}

async function byokSave(plain) {
  const seed = getEmail();
  if (!seed) throw new Error("byok: not signed in");
  const cleaned = {};
  Object.keys(plain || {}).forEach(k => {
    const v = (plain[k] || "").trim();
    if (v) cleaned[k] = v;
  });
  if (Object.keys(cleaned).length === 0) {
    localStorage.removeItem(BYOK_STORAGE_KEY);
    _byokPlain = {};
    return;
  }
  const blob = await _byokEncrypt(cleaned, seed);
  localStorage.setItem(BYOK_STORAGE_KEY, blob);
  _byokPlain = cleaned;
}

function byokClear() {
  localStorage.removeItem(BYOK_STORAGE_KEY);
  _byokPlain = {};
}

// Tests a candidate API key directly against the provider so the Settings
// modal "Test" buttons can validate a key BEFORE saving. All probes run
// in the browser — the static site has no backend to proxy through.
async function byokTestProvider(provider, candidateHeaders) {
  const h = candidateHeaders || {};
  try {
    if (provider === "anthropic") {
      const key = h["X-Anthropic-Key"];
      const model = h["X-Claude-Model"] || "claude-sonnet-4-5";
      if (!key) return { ok: false, detail: "Missing key", status: 0 };
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      let body = {};
      try { body = await r.json(); } catch (_) {}
      const detail = r.ok
        ? "OK"
        : (body && body.error && body.error.message) || `HTTP ${r.status}`;
      return { ok: r.ok, detail, status: r.status };
    }
    if (provider === "jsearch") {
      const key = h["X-RapidAPI-Key"];
      if (!key) return { ok: false, detail: "Missing key", status: 0 };
      const r = await fetch(
        "https://jsearch.p.rapidapi.com/search?query=test&page=1&num_pages=1",
        { headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": "jsearch.p.rapidapi.com" } },
      );
      return { ok: r.ok, detail: r.ok ? "OK" : `HTTP ${r.status}`, status: r.status };
    }
    if (provider === "adzuna") {
      const id = h["X-Adzuna-App-Id"];
      const key = h["X-Adzuna-App-Key"];
      if (!id || !key) return { ok: false, detail: "Missing id/key", status: 0 };
      const r = await fetch(
        `https://api.adzuna.com/v1/api/jobs/us/categories?app_id=${encodeURIComponent(id)}&app_key=${encodeURIComponent(key)}`,
      );
      return { ok: r.ok, detail: r.ok ? "OK" : `HTTP ${r.status}`, status: r.status };
    }
    if (provider === "usajobs") {
      const email = h["X-USAJobs-Email"];
      const key = h["X-USAJobs-Key"];
      if (!email || !key) return { ok: false, detail: "Missing email/key", status: 0 };
      const r = await fetch(
        "https://data.usajobs.gov/api/codelist/agencysubelements",
        {
          headers: {
            "Host": "data.usajobs.gov",
            "User-Agent": email,
            "Authorization-Key": key,
          },
        },
      );
      return { ok: r.ok, detail: r.ok ? "OK" : `HTTP ${r.status}`, status: r.status };
    }
    return { ok: false, detail: "Unknown provider", status: 0 };
  } catch (e) {
    return { ok: false, detail: "Network: " + ((e && e.message) || e), status: 0 };
  }
}

// ── Settings modal (Phase 2 BYOK) ────────────────────────────────────────
// The modal HTML lives in templates/index.html (#byok-overlay). These
// handlers populate the form from the in-memory `_byokPlain` cache, run
// per-provider Test probes, and persist via `byokSave()`.

function _byokFormRead() {
  const v = (id) => (document.getElementById(id) || {}).value || "";
  return {
    anthropic:     v("byok-anthropic").trim(),
    claude_model:  v("byok-claude-model").trim(),
    rapidapi:      v("byok-rapidapi").trim(),
    adzuna_id:     v("byok-adzuna-id").trim(),
    adzuna_key:    v("byok-adzuna-key").trim(),
    usajobs_email: v("byok-usajobs-email").trim(),
    usajobs_key:   v("byok-usajobs-key").trim(),
    // Phase 5: optional Cloudflare Worker URL for client-side job search.
    cf_worker_url: v("byok-cf-worker-url").trim(),
  };
}

function _byokFormWrite(p) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
  set("byok-anthropic",     p.anthropic);
  set("byok-claude-model",  p.claude_model);
  set("byok-rapidapi",      p.rapidapi);
  set("byok-adzuna-id",     p.adzuna_id);
  set("byok-adzuna-key",    p.adzuna_key);
  set("byok-usajobs-email", p.usajobs_email);
  set("byok-usajobs-key",   p.usajobs_key);
  set("byok-cf-worker-url", p.cf_worker_url);
}

function openSettingsModal() {
  const ov = document.getElementById("byok-overlay");
  if (!ov) return;
  _byokFormWrite(_byokPlain || {});
  // Reset every probe status pill.
  document.querySelectorAll(".byok-status").forEach(el => { el.textContent = ""; el.className = "byok-status"; });
  const st = document.getElementById("byok-save-status"); if (st) { st.textContent = ""; st.className = "byok-save-status"; }
  ov.style.display = "flex";
  document.body.style.overflow = "hidden";
}

function closeSettingsModal() {
  const ov = document.getElementById("byok-overlay");
  if (ov) ov.style.display = "none";
  document.body.style.overflow = "";
}

async function byokTestFromForm(provider) {
  const f = _byokFormRead();
  const statusId = "byok-status-" + provider;
  const el = document.getElementById(statusId);
  if (el) { el.textContent = "Testing…"; el.className = "byok-status pending"; }
  let candidate = {};
  if (provider === "anthropic") {
    if (!f.anthropic) { if (el) { el.textContent = "Paste a key first"; el.className = "byok-status fail"; } return; }
    candidate = { "X-Anthropic-Key": f.anthropic };
    if (f.claude_model) candidate["X-Claude-Model"] = f.claude_model;
  } else if (provider === "jsearch") {
    if (!f.rapidapi) { if (el) { el.textContent = "Paste a key first"; el.className = "byok-status fail"; } return; }
    candidate = { "X-RapidAPI-Key": f.rapidapi };
  } else if (provider === "adzuna") {
    if (!f.adzuna_id || !f.adzuna_key) { if (el) { el.textContent = "Paste both App Id and App Key"; el.className = "byok-status fail"; } return; }
    candidate = { "X-Adzuna-App-Id": f.adzuna_id, "X-Adzuna-App-Key": f.adzuna_key };
  } else if (provider === "usajobs") {
    if (!f.usajobs_email || !f.usajobs_key) { if (el) { el.textContent = "Paste both email and key"; el.className = "byok-status fail"; } return; }
    candidate = { "X-USAJobs-Email": f.usajobs_email, "X-USAJobs-Key": f.usajobs_key };
  }
  try {
    const res = await byokTestProvider(provider, candidate);
    if (el) {
      el.textContent = res.detail;
      el.className = "byok-status " + (res.ok ? "ok" : "fail");
    }
  } catch (e) {
    if (el) { el.textContent = "Network error: " + (e && e.message || e); el.className = "byok-status fail"; }
  }
}

async function byokSaveFromForm() {
  const st = document.getElementById("byok-save-status");
  const btn = document.getElementById("byok-save-btn");
  if (btn) btn.disabled = true;
  if (st) { st.textContent = "Saving…"; st.className = "byok-save-status pending"; }
  try {
    await byokSave(_byokFormRead());
    if (st) { st.textContent = "Saved. Keys are encrypted in this browser and never sent to JobPilot's server."; st.className = "byok-save-status ok"; }
    showToast("Settings saved.", "success");
    setTimeout(closeSettingsModal, 900);
  } catch (e) {
    if (st) { st.textContent = "Save failed: " + (e && e.message || e); st.className = "byok-save-status fail"; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Surface a single toast + auto-open Settings whenever the backend returns
// `byok_required: true` (i.e. the user hit a Claude route with no key).
// Call sites pass the parsed JSON body; returns true if it handled the
// error so the caller can short-circuit.
function handleByokRequired(body) {
  if (!body || body.byok_required !== true) return false;
  const header = body.header || "API key";
  showToast(`Open Settings → paste your ${header.replace(/^X-/, "")} to use AI features.`, "error");
  setTimeout(openSettingsModal, 250);
  return true;
}

// ── Google Drive access_token (Phase 1) ─────────────────────────────────
// The Drive-scoped OAuth access_token is obtained on the landing page via
// `google.accounts.oauth2.initTokenClient(...).requestAccessToken(...)` and
// stored in localStorage. It expires after ~1 hour, so any code that needs
// it should await `getGoogleToken()` which silently re-mints when expired.
const GOOGLE_OAUTH_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');
let _gisTokenClient = null;

function _gtokenValid() {
  const tok = localStorage.getItem("jp_gtoken");
  const exp = parseInt(localStorage.getItem("jp_gtoken_expiry") || "0", 10);
  // 60s safety buffer so we refresh *before* the token actually expires.
  return !!tok && !!exp && Date.now() < (exp - 60_000);
}

// Returns a fresh Google access_token, silently re-minting via GIS if the
// cached one is missing/expired. Resolves with a string token or rejects
// if the user must re-consent (e.g. they revoked Drive access from their
// Google account). Demo users have no gtoken and this rejects immediately.
function getGoogleToken() {
  return new Promise(function (resolve, reject) {
    if (localStorage.getItem("jp_demo") === "1") {
      reject(new Error("demo-no-drive")); return;
    }
    if (_gtokenValid()) { resolve(localStorage.getItem("jp_gtoken")); return; }
    const clientId = (window.JOBPILOT_GOOGLE_CLIENT_ID ||
      (document.querySelector('meta[name="google-client-id"]') || {}).content || "");
    if (!clientId) { reject(new Error("GOOGLE_CLIENT_ID not configured")); return; }
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
      reject(new Error("GIS library not loaded")); return;
    }
    if (!_gisTokenClient) {
      _gisTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GOOGLE_OAUTH_SCOPES,
        callback: function (resp) {
          if (resp && resp.access_token) {
            try {
              const expiresIn = parseInt(resp.expires_in || "3600", 10);
              localStorage.setItem("jp_gtoken", resp.access_token);
              localStorage.setItem("jp_gtoken_expiry", String(Date.now() + (expiresIn * 1000)));
            } catch (_) {}
            resolve(resp.access_token);
          } else {
            reject(new Error((resp && resp.error) || "No access_token returned"));
          }
        },
        error_callback: function (err) { reject(err || new Error("Token request failed")); },
      });
    }
    // Silent refresh: prompt='' means "only succeed if the user already
    // granted the requested scopes". If they revoked Drive, this rejects
    // and the caller can fall back to a full re-consent flow.
    try { _gisTokenClient.requestAccessToken({ prompt: '' }); }
    catch (e) { reject(e); }
  });
}

// Header bundle for Drive-backed routes. Adds X-Google-Token alongside the
// usual Authorization header. Awaits a silent re-mint if needed.
async function gAuthHeaders() {
  const base = authHeaders();
  try {
    const gtok = await getGoogleToken();
    base["X-Google-Token"] = gtok;
  } catch (_) { /* caller's route will return 401 and surface a re-consent CTA */ }
  return base;
}

function showAuthOverlay() {
  // Redirect to landing page instead of showing an inline overlay on the app page
  window.location.href = "/";
}

function hideAuthOverlay() {
  // The jobs page (index.html) doesn't render an auth overlay — it redirects to /
  // via an inline script when no token is present. Guard every lookup so the
  // function works on both the landing page and the jobs page.
  const overlay = document.getElementById("auth-overlay");
  if (overlay) overlay.style.display = "none";
  const layout  = document.getElementById("app-layout");
  if (layout)  layout.style.display = "";
  document.body.style.overflow = "";
  revealTopbarUser();
}

// Show the signed-in email + Sign out button in the topbar. Safe to call on
// any page; silently no-ops on pages that don't have the topbar.
function revealTopbarUser() {
  const email = getEmail();
  if (!email) return;
  const userEl = document.getElementById("topbar-user");
  const btnEl  = document.getElementById("logout-btn");
  if (userEl) {
    userEl.textContent  = email;
    userEl.style.display = "";
  }
  if (btnEl) btnEl.style.display = "";
  // Resume library is gated behind login.
  const libBtn = document.getElementById("resume-library-btn");
  if (libBtn) libBtn.style.display = "";
  // Phase 2 BYOK: same gating for the Settings button.
  const setBtn = document.getElementById("byok-settings-btn");
  if (setBtn) setBtn.style.display = "";
  refreshResumeLibraryCount();
}

function switchAuthTab(tab) {
  // Dead code path — Phase 1 of the BYOK refactor removed the email/password
  // tabs entirely. Kept as a no-op so any stale event handler in cached
  // HTML doesn't throw (Issue #42).
  void tab;
}

async function submitAuth() {
  // Dead code path — email/password sign-in was removed in Phase 1 of the
  // BYOK refactor. Google Sign-In is the only identity path; the UI for it
  // lives entirely in templates/landing.html.
}

function showAuthError(msg) {
  const el = document.getElementById("auth-error");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
}

function googleSignIn() {
  // Dead code path — the landing page owns the GIS button + token flow.
  // The /app shell never shows a sign-in prompt; it redirects unauthenticated
  // requests back to / via the IIFE in templates/index.html.
  window.location.href = "/";
}

async function handleGoogleCredential(_response) {
  // Dead code path — see googleSignIn() above. The real handler is in
  // templates/landing.html and is responsible for both the JobPilot JWT and
  // the Drive-scoped access_token (`jp_gtoken`).
  window.location.href = "/";
}

// ── Stored resume (per-browser, persists across job clicks) ───────────────────
// Keys mirror the auth session keys (jp_*) so logout can wipe them in one pass.
const RESUME_TEXT_KEY = "jp_resume_text";
const RESUME_NAME_KEY = "jp_resume_name";
function getStoredResume() {
  try {
    const text = localStorage.getItem(RESUME_TEXT_KEY) || "";
    const name = localStorage.getItem(RESUME_NAME_KEY) || "";
    return text ? { text, name: name || "resume" } : null;
  } catch (_) { return null; }
}
function setStoredResume(text, name) {
  try {
    localStorage.setItem(RESUME_TEXT_KEY, text || "");
    localStorage.setItem(RESUME_NAME_KEY, name || "resume");
  } catch (_) {}
}
function clearStoredResume() {
  try {
    localStorage.removeItem(RESUME_TEXT_KEY);
    localStorage.removeItem(RESUME_NAME_KEY);
  } catch (_) {}
}

function logout(opts) {
  const silent = opts && opts.silent === true;
  const proceed = () => {
    clearLoginSession();
    clearStoredResume();
    try { if (typeof sessionHistory !== "undefined") sessionHistory.length = 0; } catch (_) {}
    window.location.href = "/";
  };
  if (silent) { proceed(); return; }
  appConfirm("Sign out of JobPilot? Your in-session history will be cleared.", "Sign out")
    .then(ok => { if (ok) proceed(); });
}

// Lightweight in-app confirm dialog (replaces blocking native confirm()).
// Returns a Promise<boolean>. The dialog is created lazily on first use.
function appConfirm(message, confirmLabel) {
  return new Promise(resolve => {
    let backdrop = document.getElementById("app-confirm-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "app-confirm-backdrop";
      backdrop.className = "app-confirm-backdrop";
      backdrop.innerHTML =
        '<div class="app-confirm-card" role="dialog" aria-modal="true" aria-labelledby="app-confirm-msg">' +
          '<div class="app-confirm-msg" id="app-confirm-msg"></div>' +
          '<div class="app-confirm-actions">' +
            '<button type="button" class="app-confirm-cancel">Cancel</button>' +
            '<button type="button" class="app-confirm-ok">OK</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(backdrop);
    }
    backdrop.querySelector(".app-confirm-msg").textContent = message;
    backdrop.querySelector(".app-confirm-ok").textContent  = confirmLabel || "OK";
    backdrop.style.display = "flex";
    const close = (val) => {
      backdrop.style.display = "none";
      backdrop.querySelector(".app-confirm-ok").onclick     = null;
      backdrop.querySelector(".app-confirm-cancel").onclick = null;
      backdrop.onclick = null;
      resolve(val);
    };
    backdrop.querySelector(".app-confirm-ok").onclick     = () => close(true);
    backdrop.querySelector(".app-confirm-cancel").onclick = () => close(false);
    backdrop.onclick = (e) => { if (e.target === backdrop) close(false); };
  });
}

// Sliding-TTL session enforcement. If the persisted token has expired (or
// the expiry timestamp is missing because the user landed here via a
// stale link), wipe credentials and bounce back to the landing page.
// Otherwise refresh the expiry forward by SESSION_TTL_MS so active users
// stay signed in. Mirror of the IIFE in templates/index.html.
function enforceSessionLifecycle() {
  if (!getToken()) return false;
  if (!isLoginSessionValid()) {
    logout({ silent: true });
    return false;
  }
  // Sliding refresh.
  localStorage.setItem("jp_session_expiry", String(Date.now() + _sessionTtl()));
  return true;
}

// ── Session history (in-memory, resets on reload / logout) ───────────────────
// Issue #69 — keep these as `var`s and back them with `window.*` so a second
// inclusion of app.js (e.g. due to a bfcache restore or a duplicated <script>
// tag) does not throw `SyntaxError: redeclaration of let sessionHistory` and
// wipe out the in-progress activity log. The redeclaration is also written
// idempotently so the array reference is preserved across re-includes; that
// is why `clearSessionHistory()` mutates the array in place rather than
// reassigning it. A full IIFE wrapper is intentionally deferred until we add
// a bundler (see issues #44 / #45).
var sessionHistory = window.sessionHistory || [];
window.sessionHistory = sessionHistory;
var _sessionHistoryOpen = (typeof window._sessionHistoryOpen === "boolean")
  ? window._sessionHistoryOpen
  : false;
window._sessionHistoryOpen = _sessionHistoryOpen;

function logSession(type, text, meta) {
  try {
    sessionHistory.push({
      time: Date.now(),
      type: type || "event",
      text: text || "",
      meta: meta || null,
    });
    if (sessionHistory.length > 200) sessionHistory.shift();
    if (_sessionHistoryOpen) renderSessionHistoryPanel();
  } catch (_) {}
}

function _fmtSessionTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function toggleSessionHistory() {
  _sessionHistoryOpen = !_sessionHistoryOpen;
  window._sessionHistoryOpen = _sessionHistoryOpen;
  const panel = document.getElementById("session-history-panel");
  if (!panel) return;
  panel.style.display = _sessionHistoryOpen ? "" : "none";
  if (_sessionHistoryOpen) renderSessionHistoryPanel();
}

function renderSessionHistoryPanel() {
  const body = document.getElementById("session-history-body");
  if (!body) return;
  if (!sessionHistory.length) {
    body.innerHTML = `<div class="sh-empty">No activity yet in this session.</div>`;
    return;
  }
  const items = sessionHistory.slice().reverse().map(ev => {
    return `<div class="sh-item sh-${escHtml(ev.type)}">
      <span class="sh-time">${_fmtSessionTime(ev.time)}</span>
      <span class="sh-type">${escHtml(ev.type)}</span>
      <span class="sh-text">${escHtml(ev.text)}</span>
    </div>`;
  }).join("");
  body.innerHTML = items;
}

function clearSessionHistory() {
  // Issue #69 — mutate in place so the `window.sessionHistory` alias and any
  // older bindings continue to point at the same array.
  sessionHistory.length = 0;
  _persistSessionHistory();
  renderSessionHistoryPanel();
}

function checkAuth() {
  const token = getToken();
  if (!token) { showAuthOverlay(); return false; }
  if (!enforceSessionLifecycle()) return false;
  hideAuthOverlay();
  revealTopbarUser();
  return true;
}
// ── End Auth ──────────────────────────────────────────────────────────────────
const THEME_STORAGE_KEY = "jobpilot-theme";
const DEFAULT_THEME = "light";
// Issue #43: previously the JS used "light-pro"/"dark-pro" as theme keys but
// CSS / base.html used "light"/"dark". We normalize to the short keys here
// and migrate any persisted *-pro values from older sessions.
function normalizeThemeKey(value) {
  if (value === "dark" || value === "dark-pro") return "dark";
  return "light";
}

// ── State ─────────────────────────────────────────────────────────────────────
let allJobs      = [];
let selectedJob  = null;
let jobStates    = {};   // jobId → { state, resumeText, resumeName, jdText, tailoredText, score, scoreData, chatHistory }
let currentTab   = "jd";
let scoredCount  = 0;
let searchAbortController = null;  // used to cancel in-flight search
const ATS_AUTO_DEBOUNCE_MS = 1200;
const ATS_TYPING_COOLDOWN_MS = 7000;
const ATS_MEANINGFUL_DELTA_CHARS = 40;
const ATS_TARGET_SCORE = 90;

// Resume currently loaded for the active job (in-memory, not from disk)
// state.resumeText holds the text; state.resumeName holds the display name

// ── Autocomplete data ─────────────────────────────────────────────────────────

const JOB_TITLES = [
  "Accountant","Account Executive","Account Manager","Administrative Assistant",
  "AI Engineer","AI Researcher","Analytics Engineer","Android Developer",
  "Application Developer","Architect","Automation Engineer","Backend Engineer",
  "Big Data Engineer","Biomedical Engineer","Business Analyst","Business Intelligence Analyst",
  "Business Intelligence Developer","Business Intelligence Engineer","Cloud Architect",
  "Cloud Engineer","Cloud Infrastructure Engineer","Compliance Analyst","Compliance Manager",
  "Content Writer","Controls Engineer","Cybersecurity Analyst","Cybersecurity Engineer",
  "Data Analyst","Data Architect","Data Engineer","Data Scientist","Database Administrator",
  "Database Engineer","Deep Learning Engineer","DevOps Engineer","Director of Engineering",
  "Director of Product","Electrical Engineer","Embedded Systems Engineer","Engineering Manager",
  "Financial Analyst","Financial Engineer","Frontend Engineer","Full Stack Engineer",
  "Game Developer","GIS Analyst","Graphic Designer","Growth Engineer","Hardware Engineer",
  "HR Manager","Information Security Analyst","Infrastructure Engineer","iOS Developer",
  "IT Manager","IT Support Specialist","Java Developer","JavaScript Developer",
  "Kubernetes Engineer","Lead Engineer","Machine Learning Engineer","Marketing Analyst",
  "Marketing Manager","Mechanical Engineer","Mobile Developer","MLOps Engineer",
  "Network Engineer","NLP Engineer","Operations Analyst","Operations Manager",
  "Platform Engineer","Principal Engineer","Product Analyst","Product Designer",
  "Product Manager","Product Owner","Program Manager","Project Manager",
  "Python Developer","QA Automation Engineer","QA Engineer","React Developer",
  "Reliability Engineer","Research Scientist","Risk Analyst","Salesforce Developer",
  "SAP Consultant","Scrum Master","Security Analyst","Security Engineer",
  "Senior Backend Engineer","Senior Data Engineer","Senior Data Scientist",
  "Senior DevOps Engineer","Senior Frontend Engineer","Senior Full Stack Engineer",
  "Senior Machine Learning Engineer","Senior Product Manager","Senior Software Engineer",
  "Site Reliability Engineer","Software Architect","Software Engineer",
  "Solutions Architect","Staff Engineer","Supply Chain Analyst","Systems Administrator",
  "Systems Analyst","Systems Engineer","Technical Lead","Technical Program Manager",
  "Technical Recruiter","Technical Writer","UI Designer","UI Developer",
  "UX Designer","UX Researcher","Vice President of Engineering","Web Developer",
  "WordPress Developer","React Native Developer","Vue Developer","Angular Developer",
  "Rust Developer","Go Developer","Scala Developer","Kotlin Developer",
  "Swift Developer","TypeScript Developer","Node.js Developer","Django Developer",
  "Flask Developer","Spring Developer","ETL Developer","Tableau Developer",
  "Power BI Developer","Snowflake Engineer","Databricks Engineer","Spark Engineer",
  "Kafka Engineer","AWS Engineer","Azure Engineer","GCP Engineer",
  "Terraform Engineer","Ansible Engineer","Docker Engineer","Penetration Tester",
  "Blockchain Developer","AR/VR Developer","Robotics Engineer","Quantitative Analyst",
  "Actuary","Statistician","Epidemiologist","Bioinformatics Engineer",
  "Healthcare Data Analyst","Clinical Data Analyst","CRM Developer","ERP Consultant",
  "Legal Analyst","Paralegal","Finance Manager","Treasury Analyst",
  "Investment Analyst","Portfolio Manager","Real Estate Analyst",
];

const US_LOCATIONS = [
  "United States","Remote",
  "Atlanta, GA","Austin, TX","Baltimore, MD","Bellevue, WA","Birmingham, AL",
  "Boston, MA","Boulder, CO","Buffalo, NY","Charlotte, NC","Chicago, IL",
  "Cincinnati, OH","Cleveland, OH","Columbus, OH","Dallas, TX","Denver, CO",
  "Detroit, MI","Durham, NC","El Paso, TX","Fort Worth, TX","Fresno, CA",
  "Houston, TX","Indianapolis, IN","Jacksonville, FL","Kansas City, MO",
  "Las Vegas, NV","Long Beach, CA","Los Angeles, CA","Louisville, KY",
  "Memphis, TN","Mesa, AZ","Miami, FL","Milwaukee, WI","Minneapolis, MN",
  "Nashville, TN","New Orleans, LA","New York, NY","Newark, NJ","Oakland, CA",
  "Oklahoma City, OK","Omaha, NE","Orlando, FL","Philadelphia, PA","Phoenix, AZ",
  "Pittsburgh, PA","Portland, OR","Raleigh, NC","Richmond, VA","Sacramento, CA",
  "Salt Lake City, UT","San Antonio, TX","San Diego, CA","San Francisco, CA",
  "San Jose, CA","Seattle, WA","St. Louis, MO","Tampa, FL","Tucson, AZ",
  "Virginia Beach, VA","Washington, DC","Bellevue, WA","Redmond, WA",
  "Kirkland, WA","Sunnyvale, CA","Santa Clara, CA","Menlo Park, CA",
  "Palo Alto, CA","Mountain View, CA","San Mateo, CA","Irvine, CA",
  "Plano, TX","Irving, TX","Frisco, TX","Scottsdale, AZ","Chandler, AZ",
  "Tempe, AZ","Henderson, NV","Reno, NV","Boise, ID","Spokane, WA",
  "Tacoma, WA","Olympia, WA","Anchorage, AK","Honolulu, HI","Burlington, VT",
  "Providence, RI","Hartford, CT","Bridgeport, CT","Albany, NY","Rochester, NY",
  "Syracuse, NY","Yonkers, NY","Jersey City, NJ","Trenton, NJ","Wilmington, DE",
  "Annapolis, MD","Columbia, SC","Greenville, SC","Charleston, SC",
  "Savannah, GA","Augusta, GA","Macon, GA","Huntsville, AL","Mobile, AL",
  "Montgomery, AL","Jackson, MS","Baton Rouge, LA","Shreveport, LA",
  "Little Rock, AR","Tulsa, OK","Albuquerque, NM","Santa Fe, NM",
  "El Paso, TX","Lubbock, TX","Amarillo, TX","Waco, TX","Corpus Christi, TX",
  "Lincoln, NE","Des Moines, IA","Madison, WI","Green Bay, WI",
  "Grand Rapids, MI","Lansing, MI","Ann Arbor, MI","Dayton, OH",
  "Akron, OH","Toledo, OH","Lexington, KY","Knoxville, TN","Chattanooga, TN",
  "Fayetteville, NC","Winston-Salem, NC","Greensboro, NC","Norfolk, VA",
  "Arlington, VA","Alexandria, VA","Bethesda, MD","Rockville, MD",
];

// ── Autocomplete engine ───────────────────────────────────────────────────────

function setupAutocomplete(inputId, data, onSelect) {
  const input = document.getElementById(inputId);
  if (!input) return;

  // Create dropdown
  const dropdown = document.createElement("div");
  dropdown.className = "ac-dropdown";
  dropdown.id = `${inputId}-ac`;
  input.parentNode.style.position = "relative";
  input.parentNode.appendChild(dropdown);

  let activeIdx = -1;

  function showSuggestions(query) {
    const q = query.toLowerCase().trim();
    if (!q) { dropdown.style.display = "none"; return; }

    const matches = data
      .filter(item => item.toLowerCase().includes(q))
      .sort((a, b) => {
        // Prioritize starts-with over contains
        const aStart = a.toLowerCase().startsWith(q);
        const bStart = b.toLowerCase().startsWith(q);
        if (aStart && !bStart) return -1;
        if (!aStart && bStart) return 1;
        return a.localeCompare(b);
      })
      .slice(0, 8);

    if (!matches.length) { dropdown.style.display = "none"; return; }

    activeIdx = -1;
    dropdown.innerHTML = matches.map((m, i) => {
      // Highlight matching part
      const idx  = m.toLowerCase().indexOf(q);
      const highlighted = idx >= 0
        ? escHtml(m.slice(0, idx)) + `<b>${escHtml(m.slice(idx, idx + q.length))}</b>` + escHtml(m.slice(idx + q.length))
        : escHtml(m);
      return `<div class="ac-item" data-idx="${i}" data-value="${escHtml(m)}">${highlighted}</div>`;
    }).join("");

    dropdown.style.display = "block";

    dropdown.querySelectorAll(".ac-item").forEach(item => {
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = item.dataset.value;
        dropdown.style.display = "none";
        if (onSelect) onSelect(item.dataset.value);
      });
    });
  }

  input.addEventListener("input", () => showSuggestions(input.value));
  input.addEventListener("focus", () => { if (input.value) showSuggestions(input.value); });

  input.addEventListener("keydown", (e) => {
    const items = dropdown.querySelectorAll(".ac-item");
    if (!items.length || dropdown.style.display === "none") return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, -1);
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      input.value = items[activeIdx].dataset.value;
      dropdown.style.display = "none";
      if (onSelect) onSelect(input.value);
      return;
    } else if (e.key === "Escape") {
      dropdown.style.display = "none";
      return;
    }

    items.forEach((item, i) => item.classList.toggle("ac-active", i === activeIdx));
    if (activeIdx >= 0) items[activeIdx].scrollIntoView({ block: "nearest" });
  });

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = "none";
    }
  });
}

function initApp() {
  checkHealth();
  // Phase 2 BYOK: decrypt the user's saved API keys into the in-memory
  // cache so `authHeaders()` can inject them synchronously into every
  // subsequent fetch. Fire-and-forget — if it hasn't completed by the
  // time the first request goes out, the server will respond 400 with
  // `byok_required` and the user will be nudged to open Settings.
  byokInit().catch(e => console.warn("byokInit failed", e));
  // Show demo banner when user is in demo/guest mode
  if (localStorage.getItem("jp_demo") === "1") {
    const banner = document.getElementById("demo-banner");
    if (banner) banner.style.display = "flex";
    document.body.classList.add("demo-mode");
  }

  // ── Resume hydration & onboarding ───────────────────────────────────────
  // 1. localStorage gives instant feedback on warm reloads.
  // 2. hydrateStoredResumeFromServer() pulls the active resume from the
  //    user's Drive appDataFolder (Phase 3) so a fresh device or cleared
  //    cache still recovers the resume.
  // 3. Welcome modal only shows if no resume exists AND the user hasn't
  //    already dismissed it this browser session.
  hydrateStoredResumeFromServer().then(() => {
    const hasResume = !!getStoredResume();
    if (hasResume) {
      relabelSearchAsScrape();
      renderTopbarResumeChip();
      maybeAutoSearchFromHero();
    } else if (!sessionStorage.getItem("jp_welcome_seen")) {
      showWelcomeModal();
    } else {
      maybeAutoSearchFromHero();
    }
  });

  const inp = document.getElementById("job-title-input");
  if (inp) inp.focus();
}

// Auto-search from landing-page hero search / trending chip. Pulled out of
// initApp so the resume-hydration promise can call it after it resolves.
let _heroAutoSearchFired = false;
function maybeAutoSearchFromHero() {
  if (_heroAutoSearchFired) return;
  const storedTitle    = sessionStorage.getItem("jp_search_title");
  const storedLocation = sessionStorage.getItem("jp_search_location");
  if (!storedTitle) return;
  _heroAutoSearchFired = true;
  sessionStorage.removeItem("jp_search_title");
  const titleInp = document.getElementById("job-title-input");
  if (titleInp) titleInp.value = storedTitle;
  if (storedLocation) {
    sessionStorage.removeItem("jp_search_location");
    const locInp = document.getElementById("location-input");
    if (locInp) locInp.value = storedLocation;
  }
  searchJobs();
}

// Pull the user's saved resume from Drive (or the demo localStorage library)
// on app boot so a fresh device or cleared cache still recovers the active
// resume. Picks the resume marked active via localStorage.jp_active_resume_id,
// falling back to the most-recently-created one. Failures swallowed so the
// UI degrades to whatever's already in jp_resume_text.
async function hydrateStoredResumeFromServer() {
  try {
    if (!getToken()) return;
    if (typeof listResumesFromDrive !== "function") return; // drive.js not loaded yet
    const items = await listResumesFromDrive();
    if (!items || !items.length) return;
    const activeId = (typeof getActiveResumeId === "function") ? getActiveResumeId() : "";
    const pick = (activeId && items.find(x => x.id === activeId)) || items[0];
    if (!pick) return;
    const text = await getResumeFromDrive(pick.id);
    if (text) {
      setStoredResume(text, pick.name || "resume");
      if (typeof setActiveResumeId === "function") setActiveResumeId(pick.id);
    }
  } catch (_) { /* offline / no Drive permission / demo — ignore */ }
}

// ── Welcome modal: prompt the user to upload a resume after login ──────────
function showWelcomeModal() {
  const ov = document.getElementById("welcome-overlay");
  if (!ov) return;
  ov.style.display = "flex";
  const status = document.getElementById("welcome-status");
  if (status) { status.textContent = ""; status.classList.remove("error"); }
  // Wire drag-and-drop on the modal card (idempotent).
  const card = ov.querySelector(".welcome-modal");
  if (card && !card._dndWired) {
    card._dndWired = true;
    const stop = e => { e.preventDefault(); e.stopPropagation(); };
    ["dragenter", "dragover"].forEach(ev => card.addEventListener(ev, e => {
      stop(e); card.classList.add("drop-active");
    }));
    ["dragleave", "drop"].forEach(ev => card.addEventListener(ev, e => {
      stop(e); card.classList.remove("drop-active");
    }));
    card.addEventListener("drop", e => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const inp = document.getElementById("welcome-resume-file-input");
      if (!inp) return;
      const dt = new DataTransfer();
      dt.items.add(f);
      inp.files = dt.files;
      handleWelcomeResumeFile(inp);
    });
  }
}
function dismissWelcomeModal() {
  const ov = document.getElementById("welcome-overlay");
  if (ov) ov.style.display = "none";
  // Sticky-skip for the rest of this browser session so we don't nag.
  sessionStorage.setItem("jp_welcome_seen", "1");
}
async function handleWelcomeResumeFile(input) {
  if (!input.files || !input.files.length) return;
  const file = input.files[0];
  const status = document.getElementById("welcome-status");
  const btn    = document.getElementById("welcome-upload-btn");
  if (status) { status.textContent = "Reading your resume…"; status.classList.remove("error"); }
  if (btn) btn.disabled = true;
  try {
    // 1) Parse the file fully in the browser via pdf.js / mammoth.js
    //    (resume-parser.js). There is no server upload path on the static
    //    deploy — if the parser module hasn't loaded yet we surface the
    //    error to the user instead of silently falling through.
    if (typeof parseResumeFile !== "function") {
      throw new Error("Resume parser not loaded yet");
    }
    const d = await parseResumeFile(file);
    if (!d || !d.text) throw new Error("Resume text could not be extracted");
    const displayName = d.filename || file.name;
    // 2) Persist to Drive (or demo localStorage). Mark as active so this
    //    resume hydrates on the next page load.
    let savedId = "";
    if (typeof saveResumeToDrive === "function") {
      try {
        const saved = await saveResumeToDrive(displayName, d.text, "upload");
        savedId = saved && saved.id;
        if (savedId && typeof setActiveResumeId === "function") setActiveResumeId(savedId);
      } catch (driveErr) {
        console.warn("Drive save failed; resume only in local cache:", driveErr);
      }
    }
    setStoredResume(d.text, displayName);
    showToast(`Resume saved: ${displayName}`, "success");
    dismissWelcomeModal();
    relabelSearchAsScrape({ pulse: true, focus: true });
    renderTopbarResumeChip();
    refreshResumeLibraryCount();
    maybeAutoSearchFromHero();
  } catch (e) {
    if (status) { status.textContent = e.message || "Upload failed"; status.classList.add("error"); }
    showToast(`Upload failed: ${e.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
    input.value = "";
  }
}
// Reframe the existing sidebar search button as the "Start Job Scraping" CTA
// once a resume is on file. Optionally pulse it to draw attention.
function relabelSearchAsScrape(opts) {
  const btn = document.getElementById("search-btn");
  const txt = document.getElementById("search-btn-text");
  if (txt) txt.textContent = "Start Job Scraping";
  if (btn && opts && opts.pulse) {
    btn.classList.add("scrape-ready");
    setTimeout(() => btn.classList.remove("scrape-ready"), 4500);
  }
  if (btn && opts && opts.focus) {
    try { btn.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
    setTimeout(() => { try { btn.focus({ preventScroll: true }); } catch (_) {} }, 300);
  }
}

// ── Topbar resume chip ──────────────────────────────────────────────────────
// A persistent reminder of which resume is on file, with quick "Replace"
// and "Remove" affordances. Rendered after hydration completes.
function renderTopbarResumeChip() {
  const stored = getStoredResume();
  let chip = document.getElementById("topbar-resume-chip");
  if (!stored) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement("div");
    chip.id = "topbar-resume-chip";
    chip.className = "topbar-resume-chip";
    chip.title = "Your resume on file — Replace to swap, × to remove";
    const right = document.querySelector(".topbar-right");
    if (right) right.insertBefore(chip, right.firstChild);
    else document.body.appendChild(chip);
  }
  const rawName = stored.name || "resume";
  const name = rawName.length > 28 ? rawName.slice(0, 25) + "\u2026" : rawName;
  chip.innerHTML =
    `<span class="trc-icon">\u{1F4C4}</span>` +
    `<span class="trc-name">${escHtml(name)}</span>` +
    `<button class="trc-replace" type="button" onclick="replaceStoredResume()" title="Replace resume">Replace</button>` +
    `<button class="trc-clear" type="button" onclick="deleteStoredResume()" title="Remove resume">\u00d7</button>`;
}

function replaceStoredResume() {
  // Reuse the welcome-modal file picker so upload + drag-drop wiring is
  // identical between the two entry points.
  const inp = document.getElementById("welcome-resume-file-input");
  if (inp) inp.click();
}

async function deleteStoredResume() {
  const ok = await appConfirm("Remove your saved resume from JobPilot?", "Remove resume");
  if (!ok) return;
  // Delete the Drive-backed copy if there is one. Local cache is cleared
  // unconditionally below so the chip vanishes even if the Drive call fails.
  try {
    const activeId = (typeof getActiveResumeId === "function") ? getActiveResumeId() : "";
    if (activeId && typeof deleteResumeFromDrive === "function") {
      await deleteResumeFromDrive(activeId);
    }
  } catch (_) { /* network / permission failure — local cache still clears */ }
  if (typeof setActiveResumeId === "function") setActiveResumeId("");
  clearStoredResume();
  renderTopbarResumeChip();
  // Reset every job's local cache so the picker reappears in Tailor tab.
  Object.values(jobStates || {}).forEach(st => {
    if (st && st.state === "idle") {
      st.resumeText = "";
      st.resumeName = "";
    }
  });
  if (selectedJob && jobStates[selectedJob.id]?.state === "idle") renderTabBody();
  const txt = document.getElementById("search-btn-text");
  if (txt) txt.textContent = "Find jobs now";
  showToast("Resume removed", "success");
  refreshResumeLibraryCount();
}

// ── Resume library (multi-resume) ───────────────────────────────────────────
// Topbar "Resumes" button → modal listing every resume the user has saved,
// with [Use], [Delete], and Upload affordances. Phase 3: library now lives
// in the user's Drive `appDataFolder` (real users) or localStorage (demo).
// The active-resume pointer is local-only — see jp_active_resume_id.

async function refreshResumeLibraryCount() {
  const badge = document.getElementById("resume-library-count");
  if (!badge) return;
  try {
    if (!getToken() || typeof listResumesFromDrive !== "function") {
      badge.style.display = "none"; return;
    }
    const items = await listResumesFromDrive();
    const n = items.length;
    if (n > 0) {
      badge.textContent = String(n);
      badge.style.display = "";
    } else {
      badge.style.display = "none";
    }
  } catch (_) { badge.style.display = "none"; }
}

function openResumeLibrary() {
  const ov = document.getElementById("library-overlay");
  if (!ov) return;
  ov.style.display = "flex";
  const status = document.getElementById("library-status");
  if (status) { status.textContent = ""; status.classList.remove("error"); }
  loadResumeLibrary();
}

function closeResumeLibrary() {
  const ov = document.getElementById("library-overlay");
  if (ov) ov.style.display = "none";
}

async function loadResumeLibrary() {
  const list = document.getElementById("library-list");
  const cap  = document.getElementById("library-cap");
  if (!list) return;
  list.innerHTML = `<div class="library-empty">Loading your saved resumes…</div>`;
  try {
    if (!getToken()) {
      list.innerHTML = `<div class="library-empty">Sign in to manage saved resumes.</div>`;
      return;
    }
    if (typeof listResumesFromDrive !== "function") {
      list.innerHTML = `<div class="library-empty">Drive client not loaded. Refresh the page.</div>`;
      return;
    }
    const items = await listResumesFromDrive();
    if (cap) cap.textContent = items.length ? `${items.length} of 20 used` : "";
    if (!items.length) {
      list.innerHTML = `<div class="library-empty">No resumes saved yet. Upload one to get started.</div>`;
      return;
    }
    list.innerHTML = items.map(renderLibraryItem).join("");
  } catch (e) {
    list.innerHTML = `<div class="library-empty">Could not load resumes: ${escHtml(e.message || "error")}</div>`;
  }
}

function renderLibraryItem(it) {
  // Drive returns RFC3339 timestamps; demo items use ISO8601. Both parse via
  // the Date constructor directly — no manual munging required.
  const created = it.created ? new Date(it.created).toLocaleString() : "";
  const sizeKb = Math.max(1, Math.round((it.chars || 0) / 1024));
  const source = (it.source || "upload").toLowerCase();
  const sourceLabel = source.charAt(0).toUpperCase() + source.slice(1);
  const badges = [
    it.is_active ? `<span class="library-badge active">Active</span>` : "",
    `<span class="library-badge ${escHtml(source)}">${escHtml(sourceLabel)}</span>`,
  ].filter(Boolean).join(" ");
  // Drive ids are opaque strings — pass them quoted, and stash the display
  // name on a data-* attr so `useLibraryResume` can show it in the toast
  // without a second metadata fetch.
  const idAttr   = escHtml(String(it.id));
  const nameAttr = escHtml(it.name || "resume");
  const previewHtml = it.preview ? escHtml(it.preview) : "";
  return `
    <div class="library-item" data-id="${idAttr}">
      <div class="library-item-main">
        <div class="library-item-name">${nameAttr}</div>
        <div class="library-item-meta">
          ${badges}
          <span>${sizeKb} KB</span>
          ${created ? `<span>${escHtml(created)}</span>` : ""}
        </div>
        ${previewHtml ? `<div class="library-item-preview">${previewHtml}</div>` : ""}
      </div>
      <div class="library-item-actions">
        ${it.is_active
          ? `<button class="library-act-btn" disabled>In use</button>`
          : `<button class="library-act-btn primary" type="button" data-rid="${idAttr}" data-rname="${nameAttr}" onclick="useLibraryResume(this.dataset.rid, this.dataset.rname)">Use this</button>`}
        <button class="library-act-btn danger" type="button" data-rid="${idAttr}" onclick="deleteLibraryResume(this.dataset.rid)">Delete</button>
      </div>
    </div>`;
}

async function useLibraryResume(id, name) {
  const status = document.getElementById("library-status");
  if (status) { status.textContent = "Loading resume…"; status.classList.remove("error"); }
  try {
    if (typeof getResumeFromDrive !== "function") {
      throw new Error("Drive client not loaded");
    }
    const text = await getResumeFromDrive(id);
    if (!text) throw new Error("Resume body was empty");
    const displayName = name || "resume";
    if (typeof setActiveResumeId === "function") setActiveResumeId(id);
    setStoredResume(text, displayName);
    renderTopbarResumeChip();
    relabelSearchAsScrape({ pulse: true });
    // Refresh in-flight tailor tabs that haven't started yet.
    Object.values(jobStates || {}).forEach(st => {
      if (st && st.state === "idle") {
        st.resumeText = text;
        st.resumeName = displayName;
      }
    });
    if (selectedJob && jobStates[selectedJob.id]?.state === "idle") renderTabBody();
    showToast(`Now using "${displayName}"`, "success");
    closeResumeLibrary();
    // Re-render so the active badge moves to the new pick.
    loadResumeLibrary();
  } catch (e) {
    if (status) { status.textContent = e.message || "Failed"; status.classList.add("error"); }
    showToast(e.message || "Failed to switch resume", "error");
  }
}

async function deleteLibraryResume(id) {
  const ok = await appConfirm("Remove this resume from your library?", "Delete");
  if (!ok) return;
  try {
    if (typeof deleteResumeFromDrive !== "function") {
      throw new Error("Drive client not loaded");
    }
    const wasActive = (typeof getActiveResumeId === "function") && getActiveResumeId() === id;
    await deleteResumeFromDrive(id);
    showToast("Resume deleted", "success");
    if (wasActive) {
      // Local cache pointed at the deleted file — wipe it and re-hydrate
      // from whatever's still in Drive (most-recent fallback).
      clearStoredResume();
      await hydrateStoredResumeFromServer();
      renderTopbarResumeChip();
    }
    loadResumeLibrary();
    refreshResumeLibraryCount();
  } catch (e) {
    showToast(e.message || "Delete failed", "error");
  }
}

async function handleLibraryResumeFile(input) {
  if (!input.files || !input.files.length) return;
  const file = input.files[0];
  const status = document.getElementById("library-status");
  if (status) { status.textContent = `Uploading ${file.name}…`; status.classList.remove("error"); }
  try {
    // 1) Parse the file (Phase 4: client-side for real users via pdf.js +
    //    mammoth.js; demo users still hit the server). We discard any
    //    server-side library mirror — Drive is the only place the UI
    //    now reads from.
    if (typeof parseResumeFile !== "function") {
      throw new Error("Resume parser not loaded yet");
    }
    const d = await parseResumeFile(file);
    if (!d.text) throw new Error("Could not extract resume text");
    const displayName = d.filename || file.name;
    // 2) Persist to Drive and mark as active.
    if (typeof saveResumeToDrive !== "function") {
      throw new Error("Drive client not loaded");
    }
    const saved = await saveResumeToDrive(displayName, d.text, "upload");
    if (saved && saved.id && typeof setActiveResumeId === "function") {
      setActiveResumeId(saved.id);
    }
    setStoredResume(d.text, displayName);
    renderTopbarResumeChip();
    relabelSearchAsScrape({ pulse: true });
    showToast(`Saved: ${displayName}`, "success");
    if (status) status.textContent = "";
    loadResumeLibrary();
    refreshResumeLibraryCount();
  } catch (e) {
    if (status) { status.textContent = e.message || "Upload failed"; status.classList.add("error"); }
    showToast(e.message || "Upload failed", "error");
  } finally {
    input.value = "";
  }
}

// Save a tailored resume into the user's library so it's available for
// future searches without re-tailoring.
async function saveTailoredToLibrary(btn) {
  const j = selectedJob;
  if (!j) { showToast("No job selected", "error"); return; }
  const st = jobStates[j.id];
  if (!st || !st.tailoredText || !st.tailoredText.trim()) {
    showToast("Nothing to save yet", "error");
    return;
  }
  const company = (j.company || "Company").slice(0, 40);
  const title   = (j.title   || "Role").slice(0, 40);
  const stamp   = new Date().toISOString().slice(0, 10);
  const name    = `Tailored — ${company} — ${title} — ${stamp}`;
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    if (typeof saveResumeToDrive !== "function") {
      throw new Error("Drive client not loaded");
    }
    await saveResumeToDrive(name, st.tailoredText, "tailored");
    st.savedToLibrary = true;
    showToast("Saved to your resume library", "success");
    refreshResumeLibraryCount();
    const bar = document.getElementById("save-to-library-bar");
    if (bar) {
      bar.classList.add("saved");
      const msg = bar.querySelector(".stl-msg");
      if (msg) msg.innerHTML = `<b>Saved</b> as “${escHtml(name)}” — available for future searches.`;
      if (btn) { btn.textContent = "Saved ✓"; btn.disabled = true; }
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "Save to library"; }
    showToast(e.message || "Save failed", "error");
  }
}

// Close library when clicking outside the card / pressing Escape.
document.addEventListener("click", (e) => {
  const ov = document.getElementById("library-overlay");
  if (!ov || ov.style.display === "none") return;
  if (e.target === ov) closeResumeLibrary();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const ov = document.getElementById("library-overlay");
  if (ov && ov.style.display !== "none") closeResumeLibrary();
});

async function deleteMyAccount() {
  const ok = await appConfirm(
    "Clear all JobPilot data from this browser? This wipes your saved resume, BYOK keys, and login session. Your Google account is not affected.",
    "Clear local data",
  );
  if (!ok) return;
  // Static deploy — nothing to delete server-side. We wipe the browser:
  //   • BYOK vault (encrypted keys + in-memory cache)
  //   • stored resume text/name
  //   • login session (token + email)
  try { byokClear(); } catch (_) {}
  try { clearStoredResume(); } catch (_) {}
  try {
    if (typeof sessionHistory !== "undefined") sessionHistory.length = 0;
  } catch (_) {}
  showToast("Local data cleared", "success");
  logout({ silent: true });
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initThemeControls();
  setupAutocomplete("job-title-input", JOB_TITLES);
  setupAutocomplete("location-input", US_LOCATIONS);
  initPanelResizers();
  document.addEventListener("fullscreenchange", syncPreviewFullscreenState);
  if (!checkAuth()) return;
  initApp();
});

function initThemeControls() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  const selectedTheme = normalizeThemeKey(stored || DEFAULT_THEME);
  // Migrate any legacy *-pro value persisted by older builds.
  if (stored && stored !== selectedTheme) {
    localStorage.setItem(THEME_STORAGE_KEY, selectedTheme);
  }
  applyTheme(selectedTheme, false);

  const select = document.getElementById("theme-select");
  if (select) {
    select.value = selectedTheme;
    select.addEventListener("change", (e) => {
      const value = e.target && e.target.value ? e.target.value : DEFAULT_THEME;
      onThemeSelectChange(value);
    });
  }
}

function onThemeSelectChange(theme) {
  applyTheme(theme, true);
}

function applyTheme(theme, persist = true) {
  const nextTheme = normalizeThemeKey(theme);
  document.documentElement.setAttribute("data-theme", nextTheme);
  document.body.setAttribute("data-theme", nextTheme);

  if (persist) {
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  }
}

function initPanelResizers() {
  const layout = document.getElementById("app-layout");
  if (!layout) return;

  restorePanelLayout(layout);

  let activeSide = null;
  let activeHandle = null;

  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
  const setWidth = (side, px) => {
    const rect = layout.getBoundingClientRect();
    if (side === "left") {
      const maxLeft = Math.max(220, rect.width - 520);
      layout.style.setProperty("--left-panel-width", `${Math.round(clamp(px, 180, maxLeft))}px`);
    } else {
      const maxRight = Math.max(320, rect.width - 340);
      layout.style.setProperty("--right-panel-width", `${Math.round(clamp(px, 300, maxRight))}px`);
    }
  };
  const readWidths = () => ({
    left: parseFloat(getComputedStyle(layout).getPropertyValue("--left-panel-width")) || 240,
    right: parseFloat(getComputedStyle(layout).getPropertyValue("--right-panel-width")) || 460,
  });

  const stopResize = () => {
    if (!activeSide) return;
    activeSide = null;
    layout.classList.remove("resizing");
    if (activeHandle) activeHandle.classList.remove("dragging");
    activeHandle = null;
    document.body.style.userSelect = "";
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(readWidths()));
  };

  layout.querySelectorAll(".panel-resizer").forEach(handle => {
    const side = handle.dataset.resize;

    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      activeSide = side;
      activeHandle = handle;
      layout.classList.add("resizing");
      handle.classList.add("dragging");
      document.body.style.userSelect = "none";
    });

    handle.addEventListener("dblclick", () => {
      resetPanelLayout(layout);
      showToast("Layout reset to default", "success");
    });

    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 40 : 20;
      const widths = readWidths();

      if (side === "left" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        setWidth("left", widths.left + (e.key === "ArrowRight" ? step : -step));
      }
      if (side === "right" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        setWidth("right", widths.right + (e.key === "ArrowLeft" ? step : -step));
      }
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(readWidths()));
    });
  });

  window.addEventListener("pointermove", (e) => {
    if (!activeSide) return;
    const rect = layout.getBoundingClientRect();

    if (activeSide === "left") {
      setWidth("left", e.clientX - rect.left);
    } else {
      setWidth("right", rect.right - e.clientX);
    }
  });

  window.addEventListener("pointerup", stopResize);
  window.addEventListener("pointercancel", stopResize);
}

function restorePanelLayout(layout) {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || "null");
    if (!saved) return;

    const rect = layout.getBoundingClientRect();
    const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
    if (saved.left) {
      const maxLeft = Math.max(220, rect.width - 520);
      layout.style.setProperty("--left-panel-width", `${Math.round(clamp(saved.left, 180, maxLeft))}px`);
    }
    if (saved.right) {
      const maxRight = Math.max(320, rect.width - 340);
      layout.style.setProperty("--right-panel-width", `${Math.round(clamp(saved.right, 300, maxRight))}px`);
    }
  } catch {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
  }
}

function resetPanelLayout(layout) {
  layout.style.removeProperty("--left-panel-width");
  layout.style.removeProperty("--right-panel-width");
  localStorage.removeItem(LAYOUT_STORAGE_KEY);
}

// ── Usage panel ───────────────────────────────────────────────────────────────
async function toggleUsagePanel() {
  const panel = document.getElementById("usage-panel");
  if (!panel) return;
  if (panel.style.display === "none") {
    panel.style.display = "block";
    await refreshUsage();
  } else {
    panel.style.display = "none";
  }
}

async function refreshUsage() {
  const grid = document.getElementById("usage-grid");
  if (!grid) return;
  try {
    const raw = localStorage.getItem("jp_usage_v1") || "{}";
    const u = JSON.parse(raw) || {};
    const n = (k) => Number(u[k] || 0);

    grid.innerHTML = `
      <div class="usage-section">
        <div class="usage-section-title">Claude AI (Anthropic)</div>
        <div class="usage-stat-row">
          <div class="usage-stat"><div class="usage-stat-num">${n("claude_calls")}</div><div class="usage-stat-label">Total AI calls</div></div>
          <div class="usage-stat"><div class="usage-stat-num">${n("total_tailors")}</div><div class="usage-stat-label">Tailors</div></div>
          <div class="usage-stat"><div class="usage-stat-num">${n("total_ats_scores")}</div><div class="usage-stat-label">ATS scores</div></div>
          <div class="usage-stat"><div class="usage-stat-num">${n("total_ai_chats")}</div><div class="usage-stat-label">AI chats</div></div>
        </div>
      </div>
      <div class="usage-section">
        <div class="usage-section-title">Session Activity</div>
        <div class="usage-stat-row">
          <div class="usage-stat"><div class="usage-stat-num">${n("total_searches")}</div><div class="usage-stat-label">Searches</div></div>
        </div>
      </div>
      <div class="usage-section">
        <div class="usage-section-title">Job Search Providers</div>
        <div class="usage-sub">Quotas are tracked by each provider directly. Open your JSearch / Adzuna / USAJobs dashboard to see remaining calls.</div>
      </div>`;
  } catch (_) {
    grid.innerHTML = `<div style="color:var(--red);font-size:11px">Could not load usage data</div>`;
  }
}

// Local usage counter — incremented from ai.js after each successful AI call.
// Stored in localStorage as `jp_usage_v1` so it survives reloads (and stays
// purely client-side — no telemetry leaves the browser).
function bumpUsage(kind) {
  if (!kind) return;
  try {
    const u = JSON.parse(localStorage.getItem("jp_usage_v1") || "{}") || {};
    u[kind] = Number(u[kind] || 0) + 1;
    localStorage.setItem("jp_usage_v1", JSON.stringify(u));
  } catch (_) {}
}

// ── Health check ──────────────────────────────────────────────────────────────
// Static deploy — there's no Flask /api/health to ping. We hide the dot.
async function checkHealth() {
  const dot = document.getElementById("health-dot");
  if (dot) dot.style.display = "none";
  const section = document.getElementById("api-status-section");
  if (section) section.style.display = "none";
}

function renderApiStatus(_sources) {
  // Source panel hidden — internal infrastructure not shown to users
  const section = document.getElementById("api-status-section");
  if (section) section.style.display = "none";
}

// ── Search jobs ───────────────────────────────────────────────────────────────
function stopSearch() {
  if (searchAbortController) {
    searchAbortController.abort();
    searchAbortController = null;
  }
}

async function searchJobs() {
  const titleEl      = document.getElementById("job-title-input");
  const locationEl   = document.getElementById("location-input");
  const seniorityEl  = document.getElementById("seniority-input");
  const dateEl       = document.getElementById("date-posted-input");
  const title        = (titleEl?.value || "").trim();
  const location     = (locationEl?.value || "United States").trim();
  const seniority    = seniorityEl?.value || "any";
  const date_posted  = dateEl?.value || "pastWeek";
  const btn        = document.getElementById("search-btn");
  const btnText    = document.getElementById("search-btn-text");

  if (!title) {
    showToast("Enter a job title to search", "error");
    titleEl?.focus();
    return;
  }

  // If already searching, stop previous
  if (searchAbortController) searchAbortController.abort();
  searchAbortController = new AbortController();

  btn.disabled = false;  // keep enabled so it becomes the Stop button
  btn.onclick  = stopSearch;
  btn.classList.add("stop-mode");
  btnText.textContent = "Stop search";

  // Reset state
  allJobs     = [];
  selectedJob = null;
  jobStates   = {};
  scoredCount = 0;
  document.getElementById("stat-scored").textContent  = "0";
  document.getElementById("stat-total").textContent   = "—";
  document.getElementById("stat-sources").textContent = "—";
  document.getElementById("rp-empty").style.display   = "flex";
  document.getElementById("rp-content").style.display = "none";

  showSearching(title, location);

  try {
    // Every job search goes through the user's Cloudflare Worker
    // (proxy/worker.js) using their BYOK provider keys. There is no
    // backend fallback — if the Worker URL is missing or the call
    // fails, we surface a clear error and open Settings.
    const workerUrl = (_byokPlain && _byokPlain.cf_worker_url) || "";
    let data        = null;

    if (!workerUrl) {
      showToast("Cloudflare Worker URL not set. Open Settings → Job search.", "error");
      setTimeout(openSettingsModal, 250);
      return;
    }
    if (typeof window.searchJobsViaWorker !== "function") {
      showToast("Job search module failed to load. Refresh the page.", "error");
      return;
    }

    try {
      data = await window.searchJobsViaWorker({
        title, location, seniority,
        datePosted: date_posted,
        workerUrl,
      });
    } catch (workerErr) {
      if (workerErr && workerErr.name === "AbortError") throw workerErr;
      console.warn("[jobs] Worker search failed", workerErr);
      showToast(
        "Job search via Worker failed: " + ((workerErr && workerErr.message) || workerErr),
        "error",
      );
      return;
    }

    bumpUsage("total_searches");
    allJobs    = data.jobs || [];

    const sourceList = data.sources || [];
    renderJobList(allJobs);

    document.getElementById("stat-total").textContent   = allJobs.length;
    document.getElementById("stat-sources").textContent = sourceList.length;
    document.getElementById("mid-count").innerHTML =
      `<b>${allJobs.length}</b> jobs · <b>${title}</b> · ${location}`;

    const chip = document.getElementById("source-chip");
    if (chip) { chip.textContent = `${sourceList.length} sources`; chip.style.display = "flex"; }

    if (!allJobs.length) {
      showToast("No jobs found — try a broader title or 'United States' as location", "error");
    } else {
      showToast(`Found ${allJobs.length} jobs from ${sourceList.length} sources`, "success");
    }
  } catch (e) {
    if (e.name === "AbortError") {
      showToast("Search stopped", "");
      document.getElementById("job-list").innerHTML = `<div class="empty-state">
        <div class="empty-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="var(--text3)" stroke-width="1.5"/>
          <line x1="9" y1="9" x2="15" y2="15" stroke="var(--text3)" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="15" y1="9" x2="9" y2="15" stroke="var(--text3)" stroke-width="1.5" stroke-linecap="round"/>
        </svg></div>
        <div class="empty-title">Search stopped</div>
        <div class="empty-sub">Enter a job title and search again</div>
      </div>`;
    } else {
      showToast("Search failed — is the server running?", "error");
      renderJobList([]);
    }
  } finally {
    searchAbortController = null;
    btn.onclick  = searchJobs;
    btn.classList.remove("stop-mode");
    btnText.textContent = "Find jobs now";
  }
}

function showSearching(title, _location) {
  // Issue #65 — escape user-supplied title before injecting into innerHTML.
  document.getElementById("job-list").innerHTML = `
    <div class="searching-state">
      <div class="search-spinner"></div>
      <div class="search-progress">
        <b>Searching across all US companies for "${escHtml(title)}"...</b>
        Scanning thousands of job listings from FAANG to solo founders...
      </div>
    </div>`;
}

// ── Render job list ───────────────────────────────────────────────────────────
function renderJobList(jobs) {
  const list = document.getElementById("job-list");
  if (!jobs.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none">
        <circle cx="11" cy="11" r="8" stroke="var(--text3)" stroke-width="1.5"/>
        <path d="m21 21-4.35-4.35" stroke="var(--text3)" stroke-width="1.5" stroke-linecap="round"/>
      </svg></div>
      <div class="empty-title">No jobs found</div>
      <div class="empty-sub">Try a different job title, broader location, or check your API keys in .env</div>
    </div>`;
    return;
  }

  list.innerHTML = jobs.map((j, i) => {
    const st   = jobStates[j.id] || {};
    const sc   = st.score;
    const cls  = sc ? (sc >= 90 ? "hi" : sc >= 75 ? "md" : "lo") : "";
    const pill = sc
      ? `<div class="score-num">${sc}</div><div class="score-lbl">ATS</div>`
      : `<div class="score-num" style="font-size:11px;color:var(--text3)">—</div><div class="score-lbl">ATS</div>`;

    return `<div class="job-card ${selectedJob?.id === j.id ? "selected" : ""}"
                 id="jcard-${i}" onclick="openJob(${i})">
      <div class="jc-left">
        <div class="jc-title">${escHtml(j.title)}</div>
        <div class="jc-co">${escHtml(j.company)}</div>
        <div class="jc-tags">
          <span class="tag t-loc">${escHtml(j.location)}</span>
          <span class="tag t-src">${escHtml(j.source)}</span>
          ${j.salary && j.salary !== "Not listed" && j.salary !== "See listing"
            ? `<span class="tag t-sal">${escHtml(j.salary)}</span>` : ""}
          <span class="tag t-time">${escHtml(j.posted)}</span>
          ${j.type ? `<span class="tag t-type">${escHtml(j.type)}</span>` : ""}
        </div>
      </div>
      <div class="score-pill ${cls}">${pill}</div>
    </div>`;
  }).join("");
}

// ── Sort ──────────────────────────────────────────────────────────────────────
function sortJobs(by, el) {
  document.querySelectorAll(".sort-tab").forEach(t => t.classList.remove("active"));
  el.classList.add("active");
  const sorted = [...allJobs];
  if (by === "company") sorted.sort((a, b) => a.company.localeCompare(b.company));
  if (by === "salary")  sorted.sort((a, b) => _parseSalary(b.salary) - _parseSalary(a.salary));
  renderJobList(sorted);
}

function _parseSalary(s) {
  const m = (s || "").match(/\$?([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, "")) : 0;
}

// ── Open job ──────────────────────────────────────────────────────────────────
function openJob(idx) {
  selectedJob = allJobs[idx];
  if (!jobStates[selectedJob.id]) {
    // Pre-load the user's globally uploaded resume (if any) so the Tailor
    // tab can skip the picker and go straight to tailoring.
    const stored = getStoredResume();
    jobStates[selectedJob.id] = {
      state:           "idle",   // idle | uploading | generating | gen_form | tailoring | tailored | scored
      resumeText:      stored ? stored.text : "",
      resumeName:      stored ? stored.name : "",
      jdText:          "",
      tailoredText:    "",
      originalTailored: "",   // v1 snapshot — used for reset
      resumeVersion:   1,     // increments with each chat edit
      score:           null,
      scoreData:       null,
      chatHistory:     [],    // [{ role, text }]
      previewMode:  true,     // true = live preview, false = raw textarea edit
      hasScored:    false,
      atsAssistMode: "",
      atsAssistWorking: false,
      atsDraftExtras: "",
      atsLastEditAt: 0,
      atsLastScoredAt: 0,
      atsLastScoredLen: 0,
      atsLastScoredHash: 0,
      atsScoring: false,
      atsNeedsRescore: false,
      atsTimer: null,
    };
  }
  currentTab = "jd";

  document.querySelectorAll(".job-card").forEach(c => c.classList.remove("selected"));
  const card = document.getElementById(`jcard-${idx}`);
  if (card) { card.classList.add("selected"); card.scrollIntoView({ block: "nearest" }); }

  document.getElementById("rp-empty").style.display   = "none";
  const rpc = document.getElementById("rp-content");
  rpc.style.display = "flex";
  renderRightPanel();

  if (!jobStates[selectedJob.id].jdText && selectedJob.url) fetchJD();
}

// ── Right panel ───────────────────────────────────────────────────────────────
function renderRightPanel() {
  const j  = selectedJob;
  const st = jobStates[j.id];
  const rpc = document.getElementById("rp-content");
  const hasScore = st.state === "scored";

  rpc.innerHTML = `
    <div class="rp-tabs">
      <div class="rp-tab ${currentTab==="jd"?"active":""}"     onclick="switchTab('jd')">Job Description</div>
      <div class="rp-tab ${currentTab==="tailor"?"active":""}" onclick="switchTab('tailor')">Tailor &amp; Edit</div>
      <div class="rp-tab ${currentTab==="score"?"active":""}${!hasScore?" locked":""}" onclick="switchTab('score')">ATS Score</div>
    </div>
    <div class="rp-body" id="rp-body"></div>`;

  renderTabBody();
}

function switchReportTab(btn, panelId) {
  document.querySelectorAll(".tr-tab").forEach(t => t.classList.remove("tr-tab-active"));
  document.querySelectorAll(".tr-panel").forEach(p => p.style.display = "none");
  btn.classList.add("tr-tab-active");
  const panel = document.getElementById(panelId);
  if (panel) panel.style.display = "";
}

function switchTab(tab) {
  const st = jobStates[selectedJob.id];
  if (tab === "score" && st.state !== "scored") return;
  currentTab = tab;
  renderRightPanel();
}

function renderTabBody() {
  const body = document.getElementById("rp-body");
  if (!body) return;
  const j  = selectedJob;
  const st = jobStates[j.id];
  if (currentTab === "jd")     body.innerHTML = buildJDTab(j, st);
  if (currentTab === "tailor") body.innerHTML = buildTailorTab(j, st);
  if (currentTab === "score")  body.innerHTML = buildScoreTab(j, st);
  // Bind events after render
  if (currentTab === "tailor") bindTailorEvents(st);
}

// ── JD Tab ────────────────────────────────────────────────────────────────────
function buildJDTab(j, st) {
  let jdContent;
  if (!st.jdText) {
    jdContent = `<div class="jd-content jd-loading">Loading job description...
      <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    </div>`;
  } else if (st.jdText === "__PASTE_NEEDED__") {
    jdContent = `
      <div class="paste-jd-box">
        <div class="paste-jd-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" stroke="var(--amber)" stroke-width="1.6" stroke-linecap="round"/>
            <rect x="9" y="3" width="6" height="4" rx="1" stroke="var(--amber)" stroke-width="1.6"/>
            <line x1="9" y1="12" x2="15" y2="12" stroke="var(--amber)" stroke-width="1.4" stroke-linecap="round"/>
            <line x1="9" y1="16" x2="13" y2="16" stroke="var(--amber)" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="paste-jd-title">Job description couldn't be loaded automatically</div>
        <div class="paste-jd-sub">
          This happens with LinkedIn, Indeed and other platforms that block scraping.<br><br>
          <b>Quick fix:</b> Open the job page → select all the description text → copy → paste below.
        </div>
        <button class="btn-secondary paste-jd-open" onclick="window.open('${escHtml(j.url)}','_blank')">
          Open job page to copy description ↗
        </button>
        <textarea class="paste-jd-textarea" id="manual-jd-input"
          placeholder="Paste the full job description here..."></textarea>
        <button class="btn-primary" onclick="saveManualJD()">Save &amp; use this description</button>
      </div>`;
  } else {
    jdContent = `
      <div class="jd-content">${formatJD(st.jdText)}</div>
      <div class="paste-jd-optional">
        <button class="btn-ghost paste-jd-toggle" onclick="togglePasteBox()">✏ Use a different description</button>
        <div class="paste-jd-box" id="optional-paste-box" style="display:none">
          <textarea class="paste-jd-textarea" id="manual-jd-input"
            placeholder="Paste the full job description here..."></textarea>
          <button class="btn-primary" onclick="saveManualJD()">Save &amp; use this description</button>
        </div>
      </div>`;
  }
  return `
    <div class="job-detail-header">
      <div class="jd-title">${escHtml(j.title)}</div>
      <div class="jd-co">${escHtml(j.company)} · ${escHtml(j.location)}</div>
      <div class="jd-tags">
        <span class="tag t-src">${escHtml(j.source)}</span>
        ${j.salary && j.salary !== "Not listed" && j.salary !== "See listing" ? `<span class="tag t-sal">${escHtml(j.salary)}</span>` : ""}
        <span class="tag t-time">${escHtml(j.posted)}</span>
        ${j.type ? `<span class="tag t-type">${escHtml(j.type)}</span>` : ""}
      </div>
    </div>
    ${jdContent}
    <button class="btn-primary" onclick="window.open('${escHtml(j.url)}','_blank')">
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
        <path d="M8 2h4v4M12 2L6 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M10 8v4H2V4h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Apply directly — open job page
    </button>
    <div class="divider-text">or tailor your resume first</div>
    <button class="btn-secondary" onclick="switchTab('tailor')">Tailor resume with AI →</button>`;
}

async function fetchJD() {
  const j  = selectedJob;
  const st = jobStates[j.id];
  // If the API already included a description, use it directly
  if (j.description && j.description.trim().length > 200) {
    st.jdText = j.description.trim();
    if (currentTab === "jd") renderTabBody();
    return;
  }
  // Static deploy — no Flask backend to scrape the job page. Surface the
  // paste box so the user can drop the description in manually.
  st.jdText = "__PASTE_NEEDED__";
  if (currentTab === "jd") renderTabBody();
}

function _stripHtml(str) {
  const tmp = document.createElement("div");
  tmp.innerHTML = str;
  return tmp.textContent || tmp.innerText || "";
}

function saveManualJD() {
  const ta = document.getElementById("manual-jd-input");
  if (!ta || !selectedJob) return;
  let text = ta.value.trim();
  if (!text) { showToast("Paste the job description first", "error"); return; }
  if (text.includes("<") && text.includes(">")) text = _stripHtml(text).trim();
  jobStates[selectedJob.id].jdText = text;
  renderTabBody();
  showToast("Job description saved!", "success");
}

function togglePasteBox() {
  const box = document.getElementById("optional-paste-box");
  if (!box) return;
  const visible = box.style.display !== "none";
  box.style.display = visible ? "none" : "block";
}

// ── Tailor Tab ────────────────────────────────────────────────────────────────
function buildTailorTab(j, st) {
  // ── State: idle — resume already on file, offer one-click tailor ─────────
  if (st.state === "idle" && st.resumeText) {
    return `
      <div class="resume-pick-header">
        <div class="rph-title">Tailor your resume for <b>${escHtml(j.company)}</b></div>
        <div class="rph-sub">Using your uploaded resume: <b>${escHtml(st.resumeName || "resume")}</b>. JobPilot will rewrite it for this role in seconds.</div>
      </div>
      <button class="btn-primary" id="tailor-stored-btn" onclick="startTailor()">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="margin-right:6px;vertical-align:-2px">
          <path d="M2 8h4M8 2v4M14 8h-4M8 14v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          <circle cx="8" cy="8" r="2" fill="currentColor"/>
        </svg>
        Tailor Resume for this Job
      </button>
      <button class="btn-ghost" id="replace-resume-btn" style="margin-top:10px"
        onclick="document.getElementById('resume-file-input').click()">Use a different resume</button>`;
  }
  // ── State: idle — no resume yet, ask user to pick action ─────────────────
  if (st.state === "idle") {
    return `
      <div class="resume-pick-header">
        <div class="rph-title">Add your resume for <b>${escHtml(j.company)}</b></div>
        <div class="rph-sub">Upload an existing resume or let AI generate one from scratch. JobPilot will tailor it specifically for this role.</div>
      </div>
      <button class="resume-action-btn upload-btn" id="upload-resume-btn">
        <div class="rab-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            <polyline points="17,8 12,3 7,8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="rab-text">
          <div class="rab-title">Upload your resume</div>
          <div class="rab-desc">PDF, DOCX, or TXT — AI will tailor it for this role</div>
        </div>
      </button>
      <div class="divider-text">or</div>
      <button class="resume-action-btn generate-btn" id="generate-resume-btn">
        <div class="rab-icon generate-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="rab-text">
          <div class="rab-title">Generate a new resume with AI</div>
          <div class="rab-desc">Describe your background — Claude builds a professional resume</div>
        </div>
      </button>`;
  }

  // ── State: gen_form — show textarea for user to describe themselves ────────
  if (st.state === "gen_form") {
    return `
      <div class="resume-pick-header">
        <div class="rph-title">Tell AI about yourself</div>
        <div class="rph-sub">Describe your experience, skills, education, and what you're looking for. The more detail, the better the resume.</div>
      </div>
      <textarea class="gen-textarea" id="gen-description"
        placeholder="Example: I'm a software engineer with 6 years of experience. I worked at Stripe (2021–2024) as a backend engineer building payment APIs in Python and Go. Before that I was at a startup doing full-stack work with React and Node.js. I have a BS in Computer Science from Georgia Tech. I'm looking for senior backend or platform engineering roles. Skills include Python, Go, PostgreSQL, Kubernetes, AWS, Kafka."
        rows="10">${st.genDraft || ""}</textarea>
      <button class="btn-primary" id="gen-submit-btn" onclick="generateResume()">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path d="M2 8h4M8 2v4M14 8h-4M8 14v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          <circle cx="8" cy="8" r="2" fill="currentColor"/>
        </svg>
        Generate resume with AI
      </button>
      <button class="btn-ghost" onclick="resetTailor()">← Back</button>`;
  }

  // ── State: uploading / generating / tailoring — show spinner ──────────────
  if (st.state === "uploading") {
    return `<div class="proc-box">
      <div class="proc-title">Reading your resume...</div>
      <div class="proc-sub">Extracting text from your file</div>
      <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    </div>`;
  }
  if (st.state === "generating") {
    return `<div class="proc-box">
      <div class="proc-title">Generating your resume...</div>
      <div class="proc-sub">Claude is building a professional resume from your description</div>
      <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    </div>`;
  }
  if (st.state === "tailoring") {
    return `<div class="proc-box">
      <div class="proc-title">Tailoring for ${escHtml(j.company)}...</div>
      <div class="proc-sub">Reading JD · Matching keywords · Rewriting summary · Strengthening bullets for 90%+ ATS</div>
      <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    </div>`;
  }

  // ── State: tailored | scored — split layout ───────────────────────────────
  if (st.state === "tailored" || st.state === "scored") {
    const previewMode = st.previewMode !== false;  // default true
    const historyHtml = (st.chatHistory || []).map(m =>
      `<div class="chat-msg ${m.role}">
        <div class="chat-msg-label">${m.role === "user" ? "You" : "AI"}</div>
        <div class="chat-msg-text">${escHtml(m.text)}</div>
       </div>`
    ).join("");

    const editorArea = previewMode
      ? `<div class="resume-preview-wrap" id="resume-preview-wrap">
           <button class="preview-fs-fab" id="preview-fs-fab" onclick="togglePreviewFullscreen()">Full screen</button>
           <div class="resume-page" id="resume-preview">${parseResumeToHtml(st.tailoredText)}</div>
         </div>`
      : `<div class="editor-toolbar">
           <button class="tb-btn" onclick="editorFmt('bold')">Bold</button>
           <button class="tb-btn" onclick="editorFmt('upper')">UPPER</button>
           <div class="tb-sep"></div>
           <button class="tb-btn" onclick="editorAddBullet()">+ Bullet</button>
           <button class="tb-btn" onclick="editorAddSection()">+ Section</button>
           <div class="tb-sep"></div>
           <button class="tb-btn" onclick="document.execCommand('undo')">Undo</button>
           <button class="tb-btn tb-ai" onclick="aiImproveSelectedLine()">✦ AI improve line</button>
         </div>
         <textarea class="editor-area editor-fill" id="resume-editor"
           oninput="saveEditorContent()"
           spellcheck="true">${escHtml(st.tailoredText)}</textarea>`;

    return `
      <div class="editor-layout">

        <!-- STATUS BAR -->
        <div class="editor-statusbar">
          <div class="editor-status-left">
            <span class="status-dot"></span>
            <span class="status-text">Tailored for <b>${escHtml(j.company)}</b></span>
          </div>
          <div class="status-controls">
            <span class="page-fit-badge fit-none" id="page-fit-badge">—</span>
            <span class="ats-live-badge ats-live-none" id="live-ats-badge">ATS: --</span>
            <div class="mode-toggle">
              <button class="mode-toggle-btn ${previewMode ? "mtb-active" : ""}" onclick="setPreviewMode(true)">Preview</button>
              <button class="mode-toggle-btn ${!previewMode ? "mtb-active" : ""}" onclick="setPreviewMode(false)">Edit</button>
            </div>
            ${previewMode ? `<button class="status-fs-btn" id="preview-fs-btn" onclick="togglePreviewFullscreen()">Full screen</button>` : ""}
            <button class="status-reset-btn" onclick="resetTailor()">Change</button>
            <button class="status-history-btn" id="session-history-btn" onclick="toggleSessionHistory()" title="Show session history">History</button>
          </div>
        </div>

        <!-- SESSION HISTORY PANEL -->
        <div class="session-history-panel" id="session-history-panel" style="display:none">
          <div class="sh-header">
            <div class="sh-title">Session history</div>
            <div class="sh-actions">
              <button class="sh-clear-btn" onclick="clearSessionHistory()">Clear</button>
              <button class="sh-close-btn" onclick="toggleSessionHistory()">Close</button>
            </div>
          </div>
          <div class="sh-body" id="session-history-body"></div>
        </div>

        <!-- EDITOR / PREVIEW AREA -->
        <div class="editor-main">${editorArea}</div>

        <!-- BOTTOM: AI chat + action buttons -->
        <div class="editor-bottom">
          <div class="chat-panel">
            <div class="chat-panel-header">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M2 8h4M8 2v4M14 8h-4M8 14v-4" stroke="var(--primary)" stroke-width="1.8" stroke-linecap="round"/>
                <circle cx="8" cy="8" r="2" fill="var(--primary)"/>
              </svg>
              Ask AI to change anything
            </div>
            ${historyHtml ? `<div class="chat-history" id="chat-history">${historyHtml}</div>` : ""}
            <div class="chat-input-area">
              <div class="chat-input-row">
                <textarea class="chat-inline-input" id="chat-instruction-input"
                  rows="2"
                  placeholder='e.g. "remove the gap after certifications", "shorter summary", "stronger verbs"...'
                  onkeydown="handleChatInstructionKeydown(event)"></textarea>
                <button class="chat-send-btn" onclick="applyInstruction()" id="chat-send-btn">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <path d="M14 8H2M9 3l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              </div>
              <div class="chat-status" id="chat-status"></div>
            </div>
          </div>

          <div class="action-bar">
            <button class="btn-primary action-ats" onclick="checkATSScore()">Check ATS score</button>
            <button class="btn-secondary action-dl" onclick="downloadResume('pdf', 0)">Download PDF</button>
            <div class="download-row">
              <button class="btn-ghost" style="flex:1" onclick="downloadResume('pdf',2)">2 pages</button>
              <button class="btn-ghost" style="flex:1" onclick="downloadResume('pdf',1)">1 page</button>
              <button class="btn-ghost" style="flex:1" onclick="downloadResume('docx',0)">.docx</button>
            </div>
            <div class="save-to-library-bar ${st.savedToLibrary ? "saved" : ""}" id="save-to-library-bar">
              <div class="stl-msg">
                ${st.savedToLibrary
                  ? `<b>Saved</b> to your resume library — available for future searches.`
                  : `Like this version? Save it to your <b>resume library</b> so you can reuse it next time.`}
              </div>
              <button type="button" onclick="saveTailoredToLibrary(this)" ${st.savedToLibrary ? "disabled" : ""}>
                ${st.savedToLibrary ? "Saved ✓" : "Save to library"}
              </button>
            </div>
          </div>
        </div>

        ${(st.jdAnalysis || st.auditFindings || st.tailorReport) ? `
        <!-- TAILORING REPORT -->
        <div class="tailor-report">
          <div class="tailor-report-tabs">
            <button class="tr-tab tr-tab-active" onclick="switchReportTab(this,'tr-jd')">JD Analysis</button>
            <button class="tr-tab" onclick="switchReportTab(this,'tr-audit')">Resume Audit</button>
            <button class="tr-tab" onclick="switchReportTab(this,'tr-report')">Tailoring Report</button>
          </div>
          <div class="tr-panel" id="tr-jd">${escHtml(st.jdAnalysis||"").replace(/\n/g,"<br>")}</div>
          <div class="tr-panel" id="tr-audit" style="display:none">${escHtml(st.auditFindings||"").replace(/\n/g,"<br>")}</div>
          <div class="tr-panel" id="tr-report" style="display:none">${escHtml(st.tailorReport||"").replace(/\n/g,"<br>")}</div>
        </div>` : ""}

      </div>`;
  }

  return "";
}

// ── Bind events after render ──────────────────────────────────────────────────
function bindTailorEvents(st) {
  const uploadBtn = document.getElementById("upload-resume-btn");
  const genBtn    = document.getElementById("generate-resume-btn");
  if (uploadBtn) uploadBtn.addEventListener("click", () => {
    document.getElementById("resume-file-input").click();
  });
  if (genBtn) genBtn.addEventListener("click", () => {
    st.state    = "gen_form";
    st.genDraft = st.genDraft || "";
    renderTabBody();
    setTimeout(() => document.getElementById("gen-description")?.focus(), 50);
  });
  // Scroll chat to bottom
  const ch = document.getElementById("chat-history");
  if (ch) ch.scrollTop = ch.scrollHeight;
  updateLiveAtsBadge(st);

  // Calculate page-fit badge after preview fully renders
  if (st.previewMode !== false) {
    // Use setTimeout to ensure DOM has painted and heights are settled
    setTimeout(() => {
      const preview = document.getElementById("resume-preview");
      const badge   = document.getElementById("page-fit-badge");
      if (preview && badge) {
        const fit = calculatePageFit(preview);
        badge.textContent = fit.label;
        badge.className   = `page-fit-badge ${fit.cls}`;
      }
      syncPreviewFullscreenState();
    }, 150);
  }
}

// ── Handle file upload ────────────────────────────────────────────────────────
async function handleResumeFile(input) {
  if (!input.files.length || !selectedJob) return;
  const file = input.files[0];
  const st   = jobStates[selectedJob.id];

  st.state = "uploading";
  renderTabBody();

  try {
    if (typeof parseResumeFile !== "function") {
      throw new Error("Resume parser not loaded yet");
    }
    const d = await parseResumeFile(file);
    st.resumeText = d.text;
    st.resumeName = d.filename;
    // Persist as the user's default resume so other jobs reuse it.
    setStoredResume(d.text, d.filename);
    // Phase 3: also persist to Drive (or demo localStorage) and mark active.
    if (typeof saveResumeToDrive === "function") {
      try {
        const saved = await saveResumeToDrive(d.filename, d.text, "upload");
        if (saved && saved.id && typeof setActiveResumeId === "function") {
          setActiveResumeId(saved.id);
        }
        refreshResumeLibraryCount();
      } catch (driveErr) {
        console.warn("Drive save failed; resume only in local cache:", driveErr);
      }
    }
    logSession("upload", `Uploaded resume: ${d.filename}`);
    showToast(`Resume uploaded: ${d.filename}`, "success");
    await startTailor();
  } catch (e) {
    st.state = "idle";
    renderTabBody();
    showToast(`Upload failed: ${e.message}`, "error");
  }
  // Reset file input for reuse
  input.value = "";
}

// ── Generate resume ───────────────────────────────────────────────────────────
async function generateResume() {
  const textarea = document.getElementById("gen-description");
  const description = textarea?.value?.trim();
  if (!description) {
    showToast("Please describe your background first", "error");
    textarea?.focus();
    return;
  }

  const j  = selectedJob;
  const st = jobStates[j.id];
  st.genDraft = description;
  st.state    = "generating";
  renderTabBody();

  try {
    if (typeof aiGenerateResume !== "function") {
      throw new Error("AI module not loaded");
    }
    const d = await aiGenerateResume(description, j.title, st.jdText || "");
    if (handleByokRequired(d)) { st.state = "gen_form"; renderTabBody(); return; }
    if (d.error) throw new Error(d.error);
    st.resumeText = d.resume;
    st.resumeName = "AI Generated Resume";
    notifyTruncation(d);
    logSession("generate", `Generated AI resume for ${j.title || "role"}`);
    showToast("Resume generated!", "success");
    await startTailor();
  } catch (e) {
    st.state = "gen_form";
    renderTabBody();
    showToast(`Generation failed: ${e.message}`, "error");
  }
}

// ── Tailor resume ─────────────────────────────────────────────────────────────
async function startTailor() {
  const j  = selectedJob;
  const st = jobStates[j.id];

  if (!st.resumeText) {
    showToast("No resume loaded", "error");
    st.state = "idle";
    renderTabBody();
    return;
  }

  if (!st.jdText) {
    showToast("Fetching job description first...");
    await fetchJD();
  }

  st.state = "tailoring";
  renderTabBody();

  try {
    if (typeof aiTailorResume !== "function") {
      throw new Error("AI module not loaded");
    }
    const d = await aiTailorResume(st.resumeText, st.jdText, j.title, j.company);
    if (handleByokRequired(d)) { st.state = "idle"; renderTabBody(); return; }
    if (d.error) throw new Error(d.error);
    st.tailoredText    = d.tailored;
    st.originalTailored = d.tailored;  // v1 snapshot for reset
    st.resumeVersion   = 1;
    st.tailorReport    = d.report      || "";
    st.jdAnalysis      = d.jd_analysis || "";
    st.auditFindings   = d.audit       || "";
    st.state           = "tailored";
    st.chatHistory     = [];
    st.savedToLibrary  = false;  // new tailor → re-prompt user to save
    notifyTruncation(d);
    logSession("tailor", `Tailored resume for ${j.company} — ${j.title}`);
    showToast("Resume tailored successfully!", "success");
    scheduleAutoAtsScore(250, "tailor");
  } catch (e) {
    st.state = "idle";
    showToast(`Tailoring failed: ${e.message}`, "error");
  }
  renderTabBody();
}

function saveEditorContent() {
  const ta = document.getElementById("resume-editor");
  if (ta && selectedJob) {
    const st = jobStates[selectedJob.id];
    st.tailoredText = ta.value;
    st.atsLastEditAt = Date.now();
    scheduleAutoAtsScore(ATS_AUTO_DEBOUNCE_MS, "typing");
  }
}

function resetTailor() {
  const st = jobStates[selectedJob.id];
  if (st.atsTimer) clearTimeout(st.atsTimer);
  st.state        = "idle";
  // Keep the user's globally stored resume populated so they can re-tailor
  // with one click instead of being forced back through the picker.
  const stored   = getStoredResume();
  st.resumeText   = stored ? stored.text : "";
  st.resumeName   = stored ? stored.name : "";
  st.tailoredText = "";
  st.chatHistory  = [];
  st.score        = null;
  st.scoreData    = null;
  st.hasScored    = false;
  st.atsScoring   = false;
  st.atsNeedsRescore = false;
  st.atsTimer     = null;
  st.atsLastEditAt = 0;
  st.atsLastScoredAt = 0;
  st.atsLastScoredLen = 0;
  st.atsLastScoredHash = 0;
  st.genDraft     = "";
  renderTabBody();
}

// ── Editor helpers ────────────────────────────────────────────────────────────
function editorFmt(type) {
  const ta = document.getElementById("resume-editor");
  if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.substring(s, e);
  if (!sel) return;
  ta.setRangeText(type === "bold" ? `**${sel}**` : sel.toUpperCase(), s, e, "select");
  saveEditorContent();
}
function editorAddBullet() {
  const ta = document.getElementById("resume-editor");
  if (!ta) return;
  ta.setRangeText("\n• ", ta.selectionStart, ta.selectionStart, "end");
  saveEditorContent();
}
function editorAddSection() {
  const ta = document.getElementById("resume-editor");
  if (!ta) return;
  ta.setRangeText("\n\nNEW SECTION\n" + "─".repeat(30) + "\n", ta.selectionStart, ta.selectionStart, "end");
  saveEditorContent();
}
async function aiImproveSelectedLine() {
  const ta = document.getElementById("resume-editor");
  if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e) { showToast("Select a line or bullet first", "error"); return; }
  const original = ta.value.substring(s, e);
  const j  = selectedJob;
  const st = jobStates[j.id];
  ta.setRangeText("⏳ Improving...", s, e, "select");
  try {
    if (typeof window.aiImproveLine !== "function") {
      throw new Error("AI module not loaded");
    }
    const d = await window.aiImproveLine(original, st.jdText, j.title);
    if (handleByokRequired(d)) { ta.setRangeText(original, s, s + "⏳ Improving...".length, "select"); return; }
    ta.setRangeText(d.improved || original, s, s + "⏳ Improving...".length, "select");
    saveEditorContent();
    showToast("Line improved!", "success");
  } catch {
    ta.setRangeText(original, s, s + "⏳ Improving...".length, "select");
    showToast("Could not improve line", "error");
  }
}

// ── Open-ended AI chat ────────────────────────────────────────────────────────
function handleChatInstructionKeydown(event) {
  if (event.isComposing || event.key !== "Enter") return;

  // Shift+Enter should insert a newline; Enter alone sends.
  if (event.shiftKey) return;

  event.preventDefault();
  applyInstruction();
}

function updateLiveAtsBadge(st) {
  const badge = document.getElementById("live-ats-badge");
  if (!badge) return;

  if (st.atsScoring) {
    badge.textContent = "ATS: updating...";
    badge.className = "ats-live-badge ats-live-pending";
    return;
  }

  if (typeof st.score !== "number") {
    badge.textContent = "ATS: --";
    badge.className = "ats-live-badge ats-live-none";
    return;
  }

  badge.textContent = `ATS: ${st.score}/100`;
  badge.className = `ats-live-badge ${st.score >= 90 ? "ats-live-good" : st.score >= 80 ? "ats-live-mid" : "ats-live-low"}`;
}

function _hashForScore(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h;
}

function _normalizeForScore(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function scheduleAutoAtsScore(delay = ATS_AUTO_DEBOUNCE_MS, reason = "typing") {
  if (!selectedJob) return;
  const st = jobStates[selectedJob.id];
  if (!st) return;
  if (!(st.state === "tailored" || st.state === "scored")) return;
  if (!st.tailoredText?.trim() || !st.jdText?.trim()) return;

  const normalized = _normalizeForScore(st.tailoredText);
  const currLen = normalized.length;
  const currHash = _hashForScore(normalized);
  const lenDelta = Math.abs(currLen - (st.atsLastScoredLen || 0));
  const hashChanged = st.atsLastScoredHash !== 0 && currHash !== st.atsLastScoredHash;
  const tinyChange = hashChanged && lenDelta < ATS_MEANINGFUL_DELTA_CHARS;

  // If already strong and edits are tiny, skip background rescoring.
  if (reason === "typing" && st.score >= ATS_TARGET_SCORE && tinyChange) return;

  if (st.atsTimer) clearTimeout(st.atsTimer);

  const now = Date.now();
  const minInterval = reason === "typing" ? ATS_TYPING_COOLDOWN_MS : ATS_AUTO_DEBOUNCE_MS;
  const waitForInterval = Math.max(0, minInterval - (now - (st.atsLastScoredAt || 0)));
  const wait = Math.max(delay, waitForInterval);

  st.atsTimer = setTimeout(() => {
    checkATSScore({ auto: true, switchToScoreTab: false, showToastMessage: false, showLoadingUI: false });
  }, wait);
}

async function applyInstruction() {
  const input  = document.getElementById("chat-instruction-input");
  const status = document.getElementById("chat-status");
  const btn    = document.getElementById("chat-send-btn");
  const instruction = input?.value?.trim();

  if (!instruction || !selectedJob) return;

  const st = jobStates[selectedJob.id];
  saveEditorContent();

  // Add user message to history
  st.chatHistory = st.chatHistory || [];
  st.chatHistory.push({ role: "user", text: instruction });
  logSession("chat", `Chat: ${instruction.slice(0, 80)}${instruction.length > 80 ? "…" : ""}`);

  btn.disabled       = true;
  status.textContent = "Applying...";
  status.className   = "chat-status working";
  input.value        = "";

  // Re-render so user message appears
  renderTabBody();

  try {
    if (typeof aiApplyChatInstruction !== "function") {
      throw new Error("AI module not loaded");
    }
    const d = await aiApplyChatInstruction({
      instruction:     instruction,
      resume_text:     st.tailoredText,
      description:     st.jdText || "",
      job_title:       selectedJob.title,
      company:         selectedJob.company,
      chat_history:    st.chatHistory.slice(0, -1),
      version:         st.resumeVersion || 1,
      original_resume: st.originalTailored || st.tailoredText,
    });
    if (handleByokRequired(d)) { st.chatHistory.pop(); renderTabBody(); return; }
    if (d.error) throw new Error(d.error);

    if (d.resume_changed !== false) {
      st.tailoredText  = d.updated_resume;
      st.resumeVersion = d.version || (st.resumeVersion + 1);
    }
    st.chatHistory.push({ role: "ai", text: d.explanation });

    renderTabBody();
    notifyTruncation(d);
    if (d.resume_changed !== false) {
      scheduleAutoAtsScore(250, "chat");
      showToast("Resume updated!", "success");
    }
  } catch (e) {
    st.chatHistory.push({ role: "ai", text: `Error: ${e.message}` });
    renderTabBody();
    showToast("Could not apply instruction", "error");
  }
}

// ── ATS Score Tab ─────────────────────────────────────────────────────────────
async function checkATSScore(opts = {}) {
  const {
    auto = false,
    switchToScoreTab = !auto,
    showToastMessage = !auto,
    showLoadingUI = !auto,
  } = opts;

  const j  = selectedJob;
  if (!j) return;
  const st = jobStates[j.id];
  if (!st?.tailoredText?.trim() || !st?.jdText?.trim()) return;

  if (st.atsScoring) {
    st.atsNeedsRescore = true;
    return;
  }

  st.atsScoring = true;
  updateLiveAtsBadge(st);

  if (showLoadingUI) {
    const rp = document.getElementById("rp-body");
    if (rp) {
      rp.innerHTML = `<div class="proc-box">
        <div class="proc-title">Calculating ATS score...</div>
        <div class="proc-sub">Comparing your tailored resume against this job's requirements</div>
        <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
      </div>`;
    }
  }

  try {
    if (typeof aiScoreAts !== "function") {
      throw new Error("AI module not loaded");
    }
    const d = await aiScoreAts(st.tailoredText, st.jdText, !auto);
    if (handleByokRequired(d)) {
      if (!auto) { currentTab = "tailor"; renderTabBody(); }
      return;
    }
    if (d.error) throw new Error(d.error);

    st.scoreData = d;
    st.score     = d.score;
    st.state     = "scored";
    if (!auto) {
      notifyTruncation(d);
      logSession("ats", `ATS score: ${d.score}/100 for ${selectedJob?.company || ""} — ${selectedJob?.title || ""}`);
    }
    const normalized = _normalizeForScore(st.tailoredText);
    st.atsLastScoredAt = Date.now();
    st.atsLastScoredLen = normalized.length;
    st.atsLastScoredHash = _hashForScore(normalized);
    if (!st.hasScored) {
      scoredCount++;
      st.hasScored = true;
    }
    document.getElementById("stat-scored").textContent = scoredCount;
    renderJobList(allJobs);
    updateLiveAtsBadge(st);

    if (switchToScoreTab) {
      currentTab = "score";
      renderRightPanel();
    } else if (currentTab === "score") {
      renderTabBody();
    }

    if (showToastMessage) {
      showToast(`ATS Score: ${d.score}/100 — ${d.verdict}`, d.score >= 80 ? "success" : "");
    }
  } catch (e) {
    if (!auto) {
      showToast(`Scoring failed: ${e.message}`, "error");
      currentTab = "tailor";
      renderTabBody();
    }
  } finally {
    st.atsScoring = false;
    updateLiveAtsBadge(st);
    if (st.atsNeedsRescore) {
      st.atsNeedsRescore = false;
      scheduleAutoAtsScore(250, "typing");
    }
  }
}

function buildAtsAssistPanel(st, d) {
  const score = d.score || 0;
  if (score >= 90) return "";

  const missing = d.missing_keywords || [];
  const manualOpen = st.atsAssistMode === "manual";
  const busy = st.atsAssistWorking;

  return `
    <div class="ats-assist-box">
      <div class="ats-assist-title">ATS is below 90</div>
      <div class="ats-assist-sub">
        I can boost this resume toward 90+ now. Choose whether to use generic improvements, or add your own skills/certificates first.
      </div>
      <div class="ats-assist-actions">
        <button class="btn-secondary" onclick="startAtsAssistInEditor('generic')" ${busy ? "disabled" : ""}>Do it (generic boost)</button>
        <button class="btn-ghost" onclick="startAtsAssistInEditor('manual')" ${busy ? "disabled" : ""}>Upload it (my skills/certs)</button>
      </div>
      ${manualOpen ? `
        <textarea id="ats-extra-input" class="ats-extra-input" placeholder="Paste skills, tools, certifications, projects, or achievements you actually have.\nExample: AWS SAA prep, Terraform, Kubernetes on EKS, reduced API latency by 30%.">${escHtml(st.atsDraftExtras || "")}</textarea>
      ` : ""}
      ${missing.length ? `
        <div class="ats-missing-wrap">
          <div class="kw-label">Priority gaps from ATS</div>
          <div class="kw-chips">${missing.map(k => `<span class="kw-chip kw-miss">${escHtml(k)}</span>`).join("")}</div>
        </div>
      ` : ""}
    </div>`;
}

function toggleAtsAssistInput() {
  if (!selectedJob) return;
  const st = jobStates[selectedJob.id];
  const ta = document.getElementById("ats-extra-input");
  if (ta) st.atsDraftExtras = ta.value;
  st.atsAssistMode = st.atsAssistMode === "manual" ? "" : "manual";
  renderTabBody();
  if (st.atsAssistMode === "manual") {
    setTimeout(() => document.getElementById("ats-extra-input")?.focus(), 30);
  }
}

function startAtsAssistInEditor(mode = "generic") {
  if (!selectedJob) return;
  const st = jobStates[selectedJob.id];
  const wasTab = currentTab;

  // Route the user into Tailor/Edit so progress is visible where resume edits happen.
  currentTab = "tailor";
  renderRightPanel();

  if (mode === "manual") {
    const details = window.prompt("Paste skills/certifications you actually have to include in ATS optimization:");
    if (details === null) {
      currentTab = wasTab;
      renderRightPanel();
      return;
    }
    const trimmed = details.trim();
    if (!trimmed) {
      showToast("Add your skills/certifications first", "error");
      return;
    }
    st.atsDraftExtras = trimmed;
    runAtsBoost("manual", trimmed);
    return;
  }

  showToast("Applying ATS boost in Edit space...");
  runAtsBoost("generic");
}

async function runAtsBoost(mode = "generic", manualExtras = "") {
  if (!selectedJob) return;
  const j = selectedJob;
  const st = jobStates[j.id];
  if (st.atsAssistWorking) return;

  const missingList = (st.scoreData?.missing_keywords || []).slice(0, 10).join(", ");
  let instruction;
  let userMessage;

  if (mode === "manual") {
    const ta = document.getElementById("ats-extra-input");
    const extras = (manualExtras || ta?.value || st.atsDraftExtras || "").trim();
    if (!extras) {
      showToast("Add your skills/certifications first", "error");
      return;
    }
    st.atsDraftExtras = extras;
    userMessage = `Use my provided additions to improve ATS: ${extras}`;
    instruction = `Target ATS score >= 90 for this role. Update the resume to improve ATS while staying truthful.\n\nUse ONLY these user-provided additions when adding skills/certifications/content:\n${extras}\n\nAlso prioritize these missing ATS keywords where appropriate: ${missingList || "N/A"}.\n\nDo not invent employers, dates, or degrees. Keep company names, titles, and timeline unchanged. Explain clearly what was added from user input.`;
  } else {
    userMessage = "Auto-improve this resume toward ATS 90+ using safe generic additions";
    instruction = `Target ATS score >= 90 for this role. Improve summary, bullet phrasing, and skills ordering to better match the job description while staying truthful.\n\nPrioritize these missing ATS keywords: ${missingList || "N/A"}.\n\nIf exact evidence is missing, add only generic transferable capabilities or learning-in-progress statements. Do not invent employers, dates, degrees, or fake certifications. Keep company names, job titles, and timeline unchanged. State in your explanation what was generalized.`;
  }

  st.atsAssistWorking = true;
  st.chatHistory = st.chatHistory || [];
  st.chatHistory.push({ role: "user", text: userMessage });
  renderTabBody();

  try {
    if (typeof aiApplyChatInstruction !== "function") {
      throw new Error("AI module not loaded");
    }
    const d = await aiApplyChatInstruction({
      instruction,
      resume_text: st.tailoredText,
      description: st.jdText || "",
      job_title: j.title,
      company: j.company,
      chat_history: st.chatHistory.slice(0, -1),
    });
    if (handleByokRequired(d)) { st.chatHistory.pop(); st.atsAssistWorking = false; st.atsAssistMode = ""; renderTabBody(); return; }
    if (d.error) throw new Error(d.error);

    if (d.resume_changed !== false && d.updated_resume) {
      st.tailoredText = d.updated_resume;
    }
    st.chatHistory.push({ role: "ai", text: d.explanation || "Applied ATS improvements." });

    if (typeof aiScoreAts !== "function") {
      throw new Error("AI module not loaded");
    }
    const newScore = await aiScoreAts(st.tailoredText, st.jdText, true);
    if (handleByokRequired(newScore)) { st.atsAssistWorking = false; st.atsAssistMode = ""; renderTabBody(); return; }
    if (newScore.error) throw new Error(newScore.error);

    st.scoreData = newScore;
    st.score = newScore.score;
    st.state = "scored";
    const normalized = _normalizeForScore(st.tailoredText);
    st.atsLastScoredAt = Date.now();
    st.atsLastScoredLen = normalized.length;
    st.atsLastScoredHash = _hashForScore(normalized);
    if (!st.hasScored) {
      scoredCount++;
      st.hasScored = true;
    }
    document.getElementById("stat-scored").textContent = scoredCount;
    st.atsAssistMode = "";
    updateLiveAtsBadge(st);
    renderJobList(allJobs);
    renderTabBody();
    showToast(`ATS updated: ${newScore.score}/100`, newScore.score >= 90 ? "success" : "");
  } catch (e) {
    st.chatHistory.push({ role: "ai", text: `Error: ${e.message}` });
    showToast(`ATS boost failed: ${e.message}`, "error");
    renderTabBody();
  } finally {
    st.atsAssistWorking = false;
    renderTabBody();
  }
}

function buildScoreTab(j, st) {
  if (!st.scoreData) return `<div style="color:var(--text3);font-size:12px;text-align:center;padding:24px;">No score yet.</div>`;

  const d  = st.scoreData;
  const sc = d.score || 0;
  const vCls = sc >= 90 ? "" : sc >= 80 ? "strong" : sc >= 65 ? "good" : "weak";
  const cats  = d.categories || {};
  const bars  = [
    { label: "Core skills",          val: cats.core_skills       || 0 },
    { label: "Experience match",     val: cats.experience_match  || 0 },
    { label: "Tools & technologies", val: cats.tools_technologies|| 0 },
    { label: "Domain knowledge",     val: cats.domain_knowledge  || 0 },
    { label: "Soft skills",          val: cats.soft_skills       || 0 },
  ].filter(b => b.val > 0);
  const atsAssistHtml = buildAtsAssistPanel(st, d);

  return `
    <div class="ats-box">
      <div class="ats-header">
        <div class="ats-big">${sc}<span class="ats-denom">/100</span></div>
        <div class="ats-right">
          <div class="ats-verdict ${vCls}">${escHtml(d.verdict)}</div>
          <div class="ats-tip">${escHtml(d.tip || "")}</div>
        </div>
      </div>
      <div class="ats-bars">
        ${bars.map(b => `
          <div>
            <div class="ab-label"><span>${escHtml(b.label)}</span><span>${b.val}</span></div>
            <div class="ab-track"><div class="ab-fill ${b.val<70?"low":b.val<85?"mid":""}" style="width:${b.val}%"></div></div>
          </div>`).join("")}
      </div>
      ${d.matched_keywords?.length ? `
      <div class="kw-section">
        <div class="kw-label">Matched keywords</div>
        <div class="kw-chips">${d.matched_keywords.map(k=>`<span class="kw-chip kw-match">${escHtml(k)}</span>`).join("")}</div>
        ${d.missing_keywords?.length ? `
        <div class="kw-label" style="margin-top:8px;">Missing keywords</div>
        <div class="kw-chips">${d.missing_keywords.map(k=>`<span class="kw-chip kw-miss">${escHtml(k)}</span>`).join("")}</div>` : ""}
      </div>` : ""}
    </div>
    ${atsAssistHtml}
    <button class="btn-primary" onclick="window.open('${escHtml(j.url)}','_blank')">Apply now — open job page</button>
    <button class="btn-secondary" onclick="downloadResume('pdf',0)">Download resume (.pdf)</button>
    <div class="download-row">
      <button class="btn-ghost" style="flex:1" onclick="downloadResume('pdf',2)">Fit to 2 pages</button>
      <button class="btn-ghost" style="flex:1" onclick="downloadResume('pdf',1)">Fit to 1 page</button>
      <button class="btn-ghost" style="flex:1" onclick="downloadResume('docx',0)">Download .docx</button>
    </div>
    <button class="btn-ghost" onclick="switchTab('tailor')">Edit resume further</button>`;
}

// ── Download ──────────────────────────────────────────────────────────────────
async function downloadResume(fmt = "pdf", fitPages = 0) {
  const st = jobStates[selectedJob?.id];
  if (!st?.tailoredText) { showToast("No tailored resume to download", "error"); return; }
  if (fitPages > 0) showToast(`Building ${fitPages}-page PDF...`);

  const downloadName = `${(selectedJob.company || "resume").replace(/\s+/g,"_")}_${(selectedJob.title||"").replace(/\s+/g,"_")}_tailored.${fmt}`;

  try {
    // Static deploy — every user renders client-side via jsPDF / docx.js
    // (Phase 4 helpers exposed by export.js on `window`).
    if (fmt === "pdf") {
      if (typeof downloadResumePdf !== "function") throw new Error("PDF exporter not loaded");
      downloadResumePdf(st.tailoredText, downloadName, { fitPages: fitPages > 0 ? fitPages : null });
    } else if (fmt === "docx") {
      if (typeof downloadResumeDocx !== "function") throw new Error("DOCX exporter not loaded");
      await downloadResumeDocx(st.tailoredText, downloadName);
    } else if (fmt === "txt") {
      if (typeof downloadResumeText !== "function") throw new Error("Text exporter not loaded");
      downloadResumeText(st.tailoredText, downloadName);
    } else {
      throw new Error(`Unknown format: ${fmt}`);
    }
    logSession("download", `Downloaded ${fmt.toUpperCase()}${fitPages ? ` (${fitPages}-page)` : ""} — ${selectedJob.company || ""}`);
    showToast("Resume downloaded!", "success");
  } catch (e) {
    showToast("Download failed: " + e.message, "error");
  }
}

// ── Resume live preview ───────────────────────────────────────────────────────

/**
 * Convert plain-text resume into semantic HTML for the white-page preview.
 * Classifies each line: name, contact, section header, role+date, company, bullet, plain.
 */
function parseResumeToHtml(text) {
  const lines = text.split('\n');
  let html = '';
  let isFirst = true;
  let contactDone = false;

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.trim();

    if (!line) {
      html += '<div class="rv-spacer"></div>';
      continue;
    }

    // Very first non-empty line = name
    if (isFirst) {
      isFirst = false;
      html += `<div class="rv-name">${escHtml(line)}</div>`;
      continue;
    }

    // Contact line: has @ (email), phone digits, pipe/bullet separators, or social links
    if (!contactDone && (
      /@/.test(line) ||
      /\d{3}[\s\-\.]\d{3}[\s\-\.]\d{4}/.test(line) ||
      /linkedin\.com|github\.com|portfolio/i.test(line) ||
      /\|/.test(line) && line.length < 120
    )) {
      html += `<div class="rv-contact">${escHtml(line)}</div>`;
      continue;
    }

    // Once we hit a section header, contact block is done
    // Section header: ALL CAPS, short, no digits
    if (/^[A-Z][A-Z\s&\/\(\)\-]+$/.test(line) && line.length >= 3 && line.length <= 50 && !/\d/.test(line)) {
      contactDone = true;
      html += `<div class="rv-section-title">${escHtml(line)}</div>`;
      continue;
    }

    // Bullet point
    if (/^[•·\-\*▸►>]/.test(line)) {
      const content = line.replace(/^[•·\-\*▸►>\s]+/, '');
      html += `<div class="rv-bullet">${escHtml(content)}</div>`;
      continue;
    }

    // Role + date line: contains a year and some separator like | – — or multiple spaces
    if (/\b(19|20)\d{2}\b/.test(line)) {
      const sep = line.match(/\s{2,}|[|–—]\s*/);
      if (sep) {
        const idx  = line.indexOf(sep[0]);
        const left = line.slice(0, idx).trim();
        const right = line.slice(idx + sep[0].length).trim();
        html += `<div class="rv-role-date"><span>${escHtml(left)}</span><span>${escHtml(right)}</span></div>`;
        continue;
      }
    }

    // Company / location line: short, follows a role line, often italic-style
    const prevLine = lines.slice(0, i).reverse().find(l => l.trim());
    if (prevLine && /\b(19|20)\d{2}\b/.test(prevLine) && line.length < 60 && !/^[A-Z]{3,}/.test(line)) {
      html += `<div class="rv-company">${escHtml(line)}</div>`;
      continue;
    }

    // Default: plain paragraph text
    html += `<div class="rv-plain">${escHtml(line)}</div>`;
  }

  return html;
}

/**
 * Measure how many pages the resume content fills.
 * A4 at 96dpi = 1122px, minus padding 88px top+bottom = ~1034px usable content per page.
 * We use the element's offsetHeight (rendered height including all content).
 */
function calculatePageFit(previewEl) {
  const CONTENT_PER_PAGE = 1034;  // A4 content height at 96dpi minus padding
  const h = previewEl.offsetHeight;
  const pages = h / CONTENT_PER_PAGE;
  if (pages <= 1.05) return { label: '1 page ✓', cls: 'fit-good' };
  if (pages <= 1.6)  return { label: '~1.5 pages', cls: 'fit-warn' };
  if (pages <= 2.1)  return { label: '2 pages', cls: 'fit-warn' };
  if (pages <= 2.6)  return { label: '~2.5 pages', cls: 'fit-bad' };
  return { label: `~${Math.ceil(pages)} pages`, cls: 'fit-bad' };
}

/** Toggle between live preview and raw textarea edit mode. */
function setPreviewMode(on) {
  if (!selectedJob) return;
  const st = jobStates[selectedJob.id];
  if (!on) {
    // Save current textarea value before switching to preview
    const ta = document.getElementById("resume-editor");
    if (ta) st.tailoredText = ta.value;
  }
  st.previewMode = on;
  renderTabBody();
}

async function togglePreviewFullscreen() {
  const wrap = document.getElementById("resume-preview-wrap");
  if (!wrap) return;

  if (!document.fullscreenEnabled || !wrap.requestFullscreen) {
    showToast("Full screen is not supported in this browser", "error");
    return;
  }

  try {
    const active = document.fullscreenElement === wrap;
    if (active) {
      await document.exitFullscreen();
    } else {
      await wrap.requestFullscreen();
    }
  } catch (_err) {
    showToast("Could not toggle full screen", "error");
  }
}

function syncPreviewFullscreenState() {
  const wrap = document.getElementById("resume-preview-wrap");
  const fsBtn = document.getElementById("preview-fs-btn");
  const fsFab = document.getElementById("preview-fs-fab");
  const isActive = !!wrap && document.fullscreenElement === wrap;

  if (wrap) {
    wrap.classList.toggle("is-fullscreen", isActive);
  }

  const label = isActive ? "Exit full screen" : "Full screen";
  if (fsBtn) fsBtn.textContent = label;
  if (fsFab) fsFab.textContent = label;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function formatJD(text) {
  return escHtml(text)
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>")
    .replace(/(responsibilities|qualifications|requirements|skills|about|overview|description|benefits|what you.ll)/gi,
             m => `</p><h4>${m}</h4><p>`);
}

function showToast(msg, type = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className   = `toast show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3500);
}

// Issue #90 — surface backend `truncation_warning` fields as a soft warning so
// users know their longest job description / resume was clipped before the
// AI saw it.
function notifyTruncation(j) {
  if (j && typeof j.truncation_warning === "string" && j.truncation_warning) {
    showToast(j.truncation_warning, "error");
  }
}
