/**
 * app.js  —  JobPilot Enterprise Frontend
 *
 * Key changes from v2:
 *  - Free-text job title input (no preset dropdown)
 *  - Resume upload/generate AFTER selecting a job (not upfront in sidebar)
 *  - Fully open-ended AI chat with conversation history
 *  - Source-aware stat bar
 *  - Platform pills removed — source shown on each job card after results arrive
 */

const API = "";  // same origin
const LAYOUT_STORAGE_KEY = "jobpilot-layout-widths";

// ── Auth ──────────────────────────────────────────────────────────────────────

let _authTab = "login";

function getToken() { return localStorage.getItem("jp_token"); }
function getEmail()  { return localStorage.getItem("jp_email"); }

function authHeaders() {
  const t = getToken();
  return t ? { "Content-Type": "application/json", "Authorization": `Bearer ${t}` }
           : { "Content-Type": "application/json" };
}

function showAuthOverlay() {
  document.getElementById("auth-overlay").style.display = "flex";
  document.getElementById("app-layout").style.display   = "none";
  document.body.style.overflow = "hidden";
}

function hideAuthOverlay() {
  document.getElementById("auth-overlay").style.display = "none";
  document.getElementById("app-layout").style.display   = "";
  document.body.style.overflow = "";
  const email = getEmail();
  if (email) {
    document.getElementById("topbar-user").textContent = email;
    document.getElementById("topbar-user").style.display = "";
    document.getElementById("logout-btn").style.display  = "";
  }
}

function switchAuthTab(tab) {
  _authTab = tab;
  const isLogin = tab === "login";
  document.getElementById("auth-form-title").textContent  = isLogin ? "Welcome back"      : "Create your account";
  document.getElementById("auth-form-sub").textContent    = isLogin ? "Log in to your JobPilot account" : "Start your AI-powered job search";
  document.getElementById("auth-submit-btn").innerHTML    = (isLogin ? "Continue with Email" : "Create Account") +
    `<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  document.getElementById("auth-switch-hint").textContent = isLogin ? "New here?"       : "Already have an account?";
  document.getElementById("auth-switch-btn").textContent  = isLogin ? "Create an account" : "Sign in";
  document.getElementById("auth-error").style.display = "none";
}

async function submitAuth() {
  const email    = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  const errEl    = document.getElementById("auth-error");
  const btn      = document.getElementById("auth-submit-btn");

  if (!email || !password) { showAuthError("Please enter email and password"); return; }

  btn.disabled = true;
  btn.textContent = _authTab === "login" ? "Signing in..." : "Creating account...";

  try {
    const endpoint = _authTab === "login" ? "/api/auth/login" : "/api/auth/register";
    const r = await fetch(API + endpoint, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email, password }),
    });
    const d = await r.json();
    if (!r.ok) { showAuthError(d.detail || "Something went wrong"); return; }
    localStorage.setItem("jp_token", d.token);
    localStorage.setItem("jp_email", d.email);
    hideAuthOverlay();
    initApp();
  } catch {
    showAuthError("Connection error — is the server running?");
  } finally {
    btn.disabled = false;
    btn.textContent = _authTab === "login" ? "Sign in" : "Create account";
  }
}

function showAuthError(msg) {
  const el = document.getElementById("auth-error");
  el.textContent = msg;
  el.style.display = "block";
}

function googleSignIn() {
  const clientId = document.getElementById("g_id_onload").dataset.client_id;
  if (!clientId) {
    showAuthError("Google login is not configured yet. Please use email/password.");
    return;
  }
  google.accounts.id.initialize({ client_id: clientId, callback: handleGoogleCredential });
  google.accounts.id.prompt();
}

async function handleGoogleCredential(response) {
  try {
    const r = await fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential })
    });
    const d = await r.json();
    if (!r.ok) { showAuthError(d.detail || "Google sign-in failed"); return; }
    localStorage.setItem("jp_token", d.token);
    localStorage.setItem("jp_email", d.email);
    hideAuthOverlay();
    initApp();
  } catch {
    showAuthError("Google sign-in failed — server error");
  }
}

function logout() {
  localStorage.removeItem("jp_token");
  localStorage.removeItem("jp_email");
  document.getElementById("topbar-user").style.display = "none";
  document.getElementById("logout-btn").style.display  = "none";
  showAuthOverlay();
}

function checkAuth() {
  const token = getToken();
  if (!token) { showAuthOverlay(); return false; }
  hideAuthOverlay();
  return true;
}
// ── End Auth ──────────────────────────────────────────────────────────────────
const THEME_STORAGE_KEY = "jobpilot-theme";
const DEFAULT_THEME = "dark-pro";

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
  const inp = document.getElementById("job-title-input");
  if (inp) inp.focus();
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
  const selectedTheme = localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME;
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
  const nextTheme = theme === "light-pro" ? "light-pro" : "dark-pro";
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
    const r = await fetch(`${API}/api/usage`);
    const d = await r.json();
    const u = d.usage;
    const l = d.limits;
    const jsPercent = l.jsearch.monthly_limit
      ? Math.round((l.jsearch.used / l.jsearch.monthly_limit) * 100) : 0;
    const azPercent = l.adzuna.daily_limit
      ? Math.round((l.adzuna.used / l.adzuna.daily_limit) * 100) : 0;

    grid.innerHTML = `
      <div class="usage-section">
        <div class="usage-section-title">Job Search APIs</div>
        <div class="usage-row">
          <div class="usage-label">JSearch (RapidAPI)</div>
          <div class="usage-bar-wrap">
            <div class="usage-bar" style="width:${jsPercent}%;background:${jsPercent>80?'var(--red)':jsPercent>50?'var(--amber)':'var(--green)'}"></div>
          </div>
          <div class="usage-nums">${l.jsearch.used} / ${l.jsearch.monthly_limit || "—"} <span class="usage-period">/ month</span></div>
        </div>
        <div class="usage-sub">${l.jsearch.searches_left} searches remaining this month</div>
        <div class="usage-row" style="margin-top:8px">
          <div class="usage-label">Adzuna</div>
          <div class="usage-bar-wrap">
            <div class="usage-bar" style="width:${azPercent}%;background:${azPercent>80?'var(--red)':azPercent>50?'var(--amber)':'var(--green)'}"></div>
          </div>
          <div class="usage-nums">${l.adzuna.used} / ${l.adzuna.daily_limit || "—"} <span class="usage-period">/ day</span></div>
        </div>
        <div class="usage-sub">${l.adzuna.searches_left} searches remaining today</div>
      </div>
      <div class="usage-section">
        <div class="usage-section-title">Claude AI (Anthropic)</div>
        <div class="usage-stat-row">
          <div class="usage-stat"><div class="usage-stat-num">${u.claude_calls}</div><div class="usage-stat-label">Total AI calls</div></div>
          <div class="usage-stat"><div class="usage-stat-num">${u.total_tailors}</div><div class="usage-stat-label">Tailors</div></div>
          <div class="usage-stat"><div class="usage-stat-num">${u.total_ats_scores}</div><div class="usage-stat-label">ATS scores</div></div>
          <div class="usage-stat"><div class="usage-stat-num">${u.total_ai_chats}</div><div class="usage-stat-label">AI chats</div></div>
        </div>
      </div>
      <div class="usage-section">
        <div class="usage-section-title">Session Activity</div>
        <div class="usage-stat-row">
          <div class="usage-stat"><div class="usage-stat-num">${u.total_searches}</div><div class="usage-stat-label">Searches</div></div>
        </div>
      </div>`;
  } catch (e) {
    grid.innerHTML = `<div style="color:var(--red);font-size:11px">Could not load usage data</div>`;
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
async function checkHealth() {
  const dot = document.getElementById("health-dot");
  try {
    const r = await fetch(`${API}/api/health`);
    const d = await r.json();
    dot.classList.add(d.api_key_set ? "ok" : "err");
    dot.title = d.api_key_set
      ? `Connected · ${d.resume_count} resume(s) in folder`
      : "ANTHROPIC_API_KEY not set in .env";
    if (!d.api_key_set) showToast("Set ANTHROPIC_API_KEY in .env file", "error");

    // Show active sources in sidebar
    if (d.sources) renderApiStatus(d.sources);
  } catch {
    dot.classList.add("err");
    dot.title = "Server not running";
  }
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
    const r    = await fetch(`${API}/api/jobs`, {
      method:  "POST",
      headers: authHeaders(),
      body:    JSON.stringify({ title, location, seniority, date_posted }),
      signal:  searchAbortController.signal,
    });
    const data = await r.json();
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
  document.getElementById("job-list").innerHTML = `
    <div class="searching-state">
      <div class="search-spinner"></div>
      <div class="search-progress">
        <b>Searching across all US companies for "${title}"...</b>
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
    jobStates[selectedJob.id] = {
      state:           "idle",   // idle | uploading | generating | gen_form | tailoring | tailored | scored
      resumeText:      "",
      resumeName:      "",
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
  try {
    const r = await fetch(`${API}/api/jd`, {
      method:  "POST",
      headers: authHeaders(),
      body:    JSON.stringify({ url: j.url, description: j.description }),
    });
    const d = await r.json();
    const desc = (d.description || "").trim();
    // Only use fetched description if it has meaningful content
    st.jdText = desc.length > 200 ? desc : "__PASTE_NEEDED__";
  } catch {
    st.jdText = "__PASTE_NEEDED__";
  }
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
           <button class="tb-btn tb-ai" onclick="aiImproveLine()">✦ AI improve line</button>
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
          </div>
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
    const form = new FormData();
    form.append("file", file);
    const r = await fetch(`${API}/api/upload-resume`, { method: "POST", body: form });
    if (!r.ok) {
      const err = await r.json();
      throw new Error(err.detail || "Upload failed");
    }
    const d = await r.json();
    st.resumeText = d.text;
    st.resumeName = d.filename;
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
    const r = await fetch(`${API}/api/generate-resume`, {
      method:  "POST",
      headers: authHeaders(),
      body:    JSON.stringify({
        description:     description,
        job_title:       j.title,
        job_description: st.jdText || "",
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    st.resumeText = d.resume;
    st.resumeName = "AI Generated Resume";
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
    const r = await fetch(`${API}/api/tailor`, {
      method:  "POST",
      headers: authHeaders(),
      body:    JSON.stringify({
        resume_text: st.resumeText,
        description: st.jdText,
        job_title:   j.title,
        company:     j.company,
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    st.tailoredText    = d.tailored;
    st.originalTailored = d.tailored;  // v1 snapshot for reset
    st.resumeVersion   = 1;
    st.tailorReport    = d.report      || "";
    st.jdAnalysis      = d.jd_analysis || "";
    st.auditFindings   = d.audit       || "";
    st.state           = "tailored";
    st.chatHistory     = [];
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
  st.resumeText   = "";
  st.resumeName   = "";
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
async function aiImproveLine() {
  const ta = document.getElementById("resume-editor");
  if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e) { showToast("Select a line or bullet first", "error"); return; }
  const original = ta.value.substring(s, e);
  const j  = selectedJob;
  const st = jobStates[j.id];
  ta.setRangeText("⏳ Improving...", s, e, "select");
  try {
    const r = await fetch(`${API}/api/improve-line`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ line: original, description: st.jdText, job_title: j.title }),
    });
    const d = await r.json();
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

  btn.disabled       = true;
  status.textContent = "Applying...";
  status.className   = "chat-status working";
  input.value        = "";

  // Re-render so user message appears
  renderTabBody();

  try {
    const r = await fetch(`${API}/api/chat-instruction`, {
      method:  "POST",
      headers: authHeaders(),
      body:    JSON.stringify({
        instruction:     instruction,
        resume_text:     st.tailoredText,
        description:     st.jdText || "",
        job_title:       selectedJob.title,
        company:         selectedJob.company,
        chat_history:    st.chatHistory.slice(0, -1),
        version:         st.resumeVersion || 1,
        original_resume: st.originalTailored || st.tailoredText,
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);

    if (d.resume_changed !== false) {
      st.tailoredText  = d.updated_resume;
      st.resumeVersion = d.version || (st.resumeVersion + 1);
    }
    st.chatHistory.push({ role: "ai", text: d.explanation });

    renderTabBody();
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
    const r = await fetch(`${API}/api/score`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        resume_text: st.tailoredText,
        description: st.jdText,
        final_check: !auto,
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);

    st.scoreData = d;
    st.score     = d.score;
    st.state     = "scored";
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
    const r = await fetch(`${API}/api/chat-instruction`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        instruction,
        resume_text: st.tailoredText,
        description: st.jdText || "",
        job_title: j.title,
        company: j.company,
        chat_history: st.chatHistory.slice(0, -1),
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);

    if (d.resume_changed !== false && d.updated_resume) {
      st.tailoredText = d.updated_resume;
    }
    st.chatHistory.push({ role: "ai", text: d.explanation || "Applied ATS improvements." });

    const scoreRes = await fetch(`${API}/api/score`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ resume_text: st.tailoredText, description: st.jdText, final_check: true }),
    });
    const newScore = await scoreRes.json();
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

  try {
    const r = await fetch(`${API}/api/download`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        content:   st.tailoredText,
        filename:  st.resumeName || "resume",
        format:    fmt,
        fit_pages: fitPages,
      }),
    });
    if (!r.ok) throw new Error("Download failed");
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${(selectedJob.company || "resume").replace(/\s+/g,"_")}_${(selectedJob.title||"").replace(/\s+/g,"_")}_tailored.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
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
