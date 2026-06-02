// jobpilot/static/js/jobs.js — Phase 5 client-side job search
//
// Calls the Cloudflare Worker (proxy/worker.js) for each provider in
// parallel, normalizes responses into the canonical
// {id, title, company, location, posted, salary, url, source, description, type}
// shape, then runs the same 5-stage filter pipeline as the legacy
// Python `search_all_platforms` in jobpilot/core/job_scraper.py:
//
//   1. US / Remote location filter
//   2. Non-empty title guard
//   3. _title_matches() — 4-layer relevance check
//   4. Seniority match
//   5. Date-posted window filter
//   6. Deduplicate by (title, company)
//
// Single entry point: window.searchJobsViaWorker({title, location, seniority,
//   datePosted, workerUrl}) -> Promise<{jobs, count, sources, title, location}>.
//
// If `workerUrl` is missing or the call throws, the caller (app.js) is
// expected to fall back to the legacy Flask /api/jobs endpoint — that
// fallback is wired in searchJobs() inside app.js, not here, so this
// module stays pure-IIFE with no app.js dependency.

(function () {
  "use strict";

  // ── 1. Role alias map ────────────────────────────────────────────────
  // Ported verbatim from jobpilot/core/job_scraper.py::ROLE_ALIASES.
  // Kept as a flat object for O(1) lookup in _expandAliases.
  const ROLE_ALIASES = {
    "software engineer": [
      "software engineer", "software developer", "software development engineer",
      "full stack engineer", "full stack developer", "fullstack engineer",
      "backend engineer", "backend developer", "back end engineer",
      "frontend engineer", "frontend developer", "front end engineer",
      "web developer", "web engineer", "application developer",
      "application engineer", "swe",
    ],
    "full stack engineer": [
      "full stack engineer", "full stack developer", "fullstack engineer",
      "fullstack developer", "software engineer", "web developer",
    ],
    "backend engineer": [
      "backend engineer", "backend developer", "back end engineer",
      "back end developer", "server side engineer", "api engineer",
      "software engineer", "software developer",
    ],
    "frontend engineer": [
      "frontend engineer", "frontend developer", "front end engineer",
      "front end developer", "ui engineer", "ui developer",
      "react developer", "react engineer", "angular developer", "vue developer",
      "javascript developer", "javascript engineer",
    ],
    "data engineer": [
      "data engineer", "data pipeline engineer", "etl developer",
      "etl engineer", "data platform engineer", "big data engineer",
      "analytics engineer", "data infrastructure engineer",
    ],
    "data scientist": [
      "data scientist", "data science engineer", "machine learning scientist",
      "applied scientist", "research scientist", "quantitative analyst",
    ],
    "data analyst": [
      "data analyst", "business analyst", "business intelligence analyst",
      "bi analyst", "reporting analyst", "analytics analyst",
      "quantitative analyst", "insights analyst",
    ],
    "machine learning engineer": [
      "machine learning engineer", "ml engineer", "ai engineer",
      "ai/ml engineer", "deep learning engineer", "applied ml engineer",
      "mlops engineer", "research engineer",
    ],
    "devops engineer": [
      "devops engineer", "site reliability engineer", "sre",
      "platform engineer", "cloud engineer", "infrastructure engineer",
      "release engineer", "build engineer", "devsecops engineer",
    ],
    "cloud engineer": [
      "cloud engineer", "cloud architect", "aws engineer", "azure engineer",
      "gcp engineer", "cloud infrastructure engineer", "devops engineer",
      "platform engineer",
    ],
    "product manager": [
      "product manager", "product owner", "technical product manager",
      "senior product manager", "associate product manager",
      "program manager", "digital product manager",
    ],
    "ux designer": [
      "ux designer", "ui designer", "ui/ux designer", "product designer",
      "interaction designer", "user experience designer",
      "user interface designer", "visual designer",
    ],
    "security engineer": [
      "security engineer", "cybersecurity engineer", "information security engineer",
      "application security engineer", "cloud security engineer",
      "security analyst", "penetration tester", "soc analyst",
    ],
    "engineering manager": [
      "engineering manager", "software engineering manager",
      "director of engineering", "vp of engineering",
      "technical lead", "tech lead", "team lead",
    ],
    "qa engineer": [
      "qa engineer", "quality assurance engineer", "test engineer",
      "sdet", "automation engineer", "quality engineer",
      "software test engineer",
    ],
  };

  function _expandAliases(title) {
    const key = String(title || "").trim().toLowerCase();
    if (ROLE_ALIASES[key]) return ROLE_ALIASES[key];
    for (const [k, aliases] of Object.entries(ROLE_ALIASES)) {
      if (k.includes(key) || key.includes(k)) return aliases;
    }
    return [title];
  }

  // ── 2. US / Remote filter (port of _is_us_or_remote) ─────────────────
  const _US_STATES = new Set([
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
    "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
    "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
    "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
    "WI", "WY", "DC",
  ]);
  const _REMOTE_KEYWORDS = [
    "remote", "united states", "usa", "u.s.", "us,", "worldwide",
    "anywhere", "work from home",
  ];
  const _NON_US_COUNTRIES = [
    "united kingdom", "india", "canada", "australia", "germany", "france",
    "netherlands", "singapore", "brazil", "mexico", "spain", "italy",
    "poland", "uk", "gb", "eu", "europe", "ireland", "scotland", "wales",
    "switzerland", "sweden", "norway", "denmark", "finland", "belgium",
    "austria", "portugal", "greece", "czech", "czechia", "romania", "hungary",
    "ukraine", "russia", "turkey", "israel", "uae", "saudi", "qatar",
    "china", "japan", "korea", "taiwan", "hong kong", "vietnam", "thailand",
    "indonesia", "philippines", "malaysia", "pakistan", "bangladesh",
    "south africa", "nigeria", "kenya", "egypt", "argentina", "chile",
    "colombia", "peru", "new zealand",
  ];
  const _FOREIGN_CITIES = [
    "london", "manchester", "birmingham", "edinburgh", "glasgow", "dublin",
    "berlin", "munich", "hamburg", "frankfurt", "cologne", "stuttgart",
    "düsseldorf", "dusseldorf", "leipzig", "dresden",
    "paris", "lyon", "marseille", "toulouse", "nice", "bordeaux",
    "madrid", "barcelona", "valencia", "seville", "bilbao",
    "rome", "milan", "turin", "naples", "florence",
    "amsterdam", "rotterdam", "eindhoven", "the hague", "utrecht",
    "brussels", "antwerp", "vienna", "zurich", "geneva", "basel", "bern",
    "stockholm", "gothenburg", "oslo", "copenhagen", "helsinki",
    "warsaw", "krakow", "prague", "budapest", "bucharest", "sofia",
    "lisbon", "porto", "athens", "istanbul",
    "toronto", "vancouver", "montreal", "ottawa", "calgary", "edmonton",
    "mexico city", "guadalajara", "monterrey", "sao paulo", "são paulo",
    "rio de janeiro", "buenos aires", "santiago", "bogota", "bogotá", "lima",
    "bangalore", "bengaluru", "hyderabad", "mumbai", "delhi", "new delhi",
    "chennai", "pune", "kolkata", "noida", "gurgaon", "gurugram",
    "singapore", "tokyo", "osaka", "kyoto", "yokohama",
    "seoul", "beijing", "shanghai", "shenzhen", "guangzhou", "taipei",
    "hong kong", "bangkok", "jakarta", "manila", "kuala lumpur", "hanoi",
    "sydney", "melbourne", "brisbane", "perth", "auckland", "wellington",
    "dubai", "abu dhabi", "doha", "riyadh", "tel aviv", "jerusalem",
    "cairo", "johannesburg", "cape town", "nairobi", "lagos",
  ];

  function _escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function _isUsOrRemote(loc) {
    if (!loc) return true;
    const u = loc.toLowerCase();
    for (const k of _REMOTE_KEYWORDS) if (u.includes(k)) return true;
    for (const k of _NON_US_COUNTRIES) if (u.includes(k)) return false;
    for (const city of _FOREIGN_CITIES) {
      if (new RegExp(`\\b${_escapeRe(city)}\\b`).test(u)) return false;
    }
    const uUp = loc.toUpperCase();
    for (const state of _US_STATES) {
      if (
        uUp.includes(`, ${state}`) ||
        uUp.includes(` ${state},`) ||
        uUp.endsWith(` ${state}`) ||
        uUp.endsWith(`,${state}`)
      ) {
        return true;
      }
    }
    if (loc.split(/\s+/).length <= 3) return true;
    return false;
  }

  // ── 3. Seniority filter (port of _seniority_matches) ─────────────────
  const _SENIORITY_ENTRY = new Set([
    "junior", "jr", "entry", "associate", "intern", "graduate", "new", "grad", "apprentice",
  ]);
  const _SENIORITY_SENIOR = new Set(["senior", "sr"]);
  const _SENIORITY_LEAD = new Set([
    "staff", "principal", "lead", "director", "head", "vp", "vice", "president",
    "architect", "distinguished", "fellow", "chief", "manager",
  ]);

  function _seniorityMatches(title, seniority) {
    if (!seniority || seniority === "any") return true;
    const t = title.toLowerCase();
    const words = new Set(t.match(/\b\w+\b/g) || []);
    const hasEntry = [..._SENIORITY_ENTRY].some((w) => words.has(w));
    const hasSenior = [..._SENIORITY_SENIOR].some((w) => words.has(w));
    const hasLead = [..._SENIORITY_LEAD].some((w) => words.has(w));
    const romanMatch = t.match(/\b(iv|iii|ii|i)\b/);
    const romanLevel = romanMatch
      ? { i: 1, ii: 2, iii: 3, iv: 4 }[romanMatch[1]] || 0
      : 0;

    if (seniority === "entry") return hasEntry || romanLevel === 1;
    if (seniority === "mid")
      return (!hasEntry && !hasSenior && !hasLead) || romanLevel === 2;
    if (seniority === "senior") return hasSenior || romanLevel === 3;
    if (seniority === "lead") return hasLead || romanLevel === 4;
    return true;
  }

  // ── 4. Title relevance filter (port of _title_matches) ───────────────
  // 4-layer check identical to the Python implementation. See the
  // docstring in jobpilot/core/job_scraper.py for the full rationale.
  const _FILLER_WORDS = new Set([
    "senior", "sr", "jr", "junior", "lead", "staff", "principal",
    "associate", "head", "i", "ii", "iii", "iv",
    "the", "and", "or", "of", "in", "at", "a",
    "remote", "us", "usa", "jobs", "job",
  ]);
  const _PROXIMITY_WINDOW = 4;

  function _cartesianProduct(arrays) {
    return arrays.reduce(
      (acc, curr) => acc.flatMap((a) => curr.map((c) => [...a, c])),
      [[]]
    );
  }

  function _titleMatches(jobTitle, searchQuery) {
    const rawTokens = String(searchQuery || "")
      .split(/[\s,/\-]+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w && w.length > 1);
    const queryWords = rawTokens.filter((w) => !_FILLER_WORDS.has(w));
    if (queryWords.length === 0) return false;
    if (rawTokens.length >= 2 && queryWords.length < 2) return false;

    const titleLower = String(jobTitle || "").toLowerCase();
    for (const qw of queryWords) {
      if (!new RegExp(`\\b${_escapeRe(qw)}\\b`).test(titleLower)) return false;
    }

    if (queryWords.length < 2) return true;

    const titleWords = titleLower.match(/\b\w+\b/g) || [];
    const positions = {};
    for (const qw of queryWords) {
      for (let i = 0; i < titleWords.length; i++) {
        if (titleWords[i] === qw) {
          (positions[qw] = positions[qw] || []).push(i);
        }
      }
    }
    if (Object.keys(positions).length < queryWords.length) return false;

    const posLists = queryWords.map((qw) => positions[qw]);
    // Bail out of cartesian product if it would be huge — a title with
    // dozens of repeated words is implausibly relevant anyway.
    const productSize = posLists.reduce((acc, p) => acc * p.length, 1);
    if (productSize > 1024) return false;

    const combos = _cartesianProduct(posLists);
    const minSpan = Math.min(
      ...combos.map((c) => Math.max(...c) - Math.min(...c))
    );
    if (minSpan > _PROXIMITY_WINDOW) return false;

    const orderOk = combos.some((c) => {
      for (let i = 0; i < c.length - 1; i++) {
        if (c[i] >= c[i + 1]) return false;
      }
      return true;
    });
    return orderOk;
  }

  // ── 5. Date helpers (port of _normalize_date + _days_old) ────────────
  function _normalizeDate(raw) {
    if (raw === null || raw === undefined || raw === "") return "Today";
    const s = String(raw).trim();
    const sLow = s.toLowerCase();
    if (/just|moment|now|second/.test(sLow)) return "Just now";
    if (sLow.includes("hour")) {
      const n = s.match(/(\d+)/);
      return n ? `${n[1]} hr ago` : "Today";
    }
    if (sLow.includes("today") || sLow === "0" || sLow === "0 days") return "Today";
    if (sLow.includes("day")) {
      const n = s.match(/(\d+)/);
      if (!n) return "Today";
      return `${n[1]} day${n[1] !== "1" ? "s" : ""} ago`;
    }
    if (/^\d+$/.test(s) && (s.length === 10 || s.length === 13)) {
      try {
        const ts = s.length === 13 ? Number(s) : Number(s) * 1000;
        const dt = new Date(ts);
        const now = new Date();
        const deltaMs = now - dt;
        const d = Math.floor(deltaMs / (1000 * 60 * 60 * 24));
        const hrs = Math.floor((deltaMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        if (d === 0) return hrs > 0 ? `${hrs} hr ago` : "Just now";
        if (d === 1) return "1 day ago";
        if (d < 7) return `${d} days ago`;
        return dt.toISOString().slice(0, 10);
      } catch {
        return "Today";
      }
    }
    try {
      const dt = new Date(s.replace("Z", "+00:00"));
      if (isNaN(dt.getTime())) throw new Error("invalid");
      const now = new Date();
      const deltaMs = now - dt;
      const d = Math.floor(deltaMs / (1000 * 60 * 60 * 24));
      const hrs = Math.floor((deltaMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      if (d === 0) return hrs > 0 ? `${hrs} hr ago` : "Just now";
      if (d === 1) return "1 day ago";
      if (d < 7) return `${d} days ago`;
      return s.slice(0, 10);
    } catch {
      return s.length >= 10 ? s.slice(0, 10) : (s || "Today");
    }
  }

  function _daysOld(posted) {
    if (!posted) return null;
    const s = String(posted).trim().toLowerCase();
    if (!s) return null;
    if (s === "just now" || s === "today" || s.includes("hr ago") || s.includes("min ago")) {
      return 0;
    }
    const m = s.match(/^(\d+)\s+days?\s+ago$/);
    if (m) {
      const n = parseInt(m[1], 10);
      return isNaN(n) ? null : n;
    }
    if (s === "1 day ago") return 1;
    try {
      const dt = new Date(s.slice(0, 10) + "T00:00:00Z");
      if (isNaN(dt.getTime())) return null;
      const today = new Date();
      const utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      const utcDt = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
      const delta = Math.floor((utcToday - utcDt) / (1000 * 60 * 60 * 24));
      return Math.max(delta, 0);
    } catch {
      return null;
    }
  }

  // ── 6. Salary / location / HTML helpers ──────────────────────────────
  function _salary(min, max, period) {
    const suffix = { year: "/yr", month: "/mo", week: "/wk", hour: "/hr" }[
      String(period || "").toLowerCase()
    ] || "";
    const toInt = (v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = parseFloat(v);
      return isNaN(n) ? null : Math.floor(n);
    };
    const lo = toInt(min);
    const hi = toInt(max);
    if (lo === null && hi === null) return "Not listed";
    if (lo && hi) {
      return `$${lo.toLocaleString()} – $${hi.toLocaleString()}${suffix}`;
    }
    if (lo) return `$${lo.toLocaleString()}+${suffix}`;
    return "Not listed";
  }

  function _location(city, state, country, isRemote) {
    if (isRemote) return "Remote";
    const parts = [city, state].filter(Boolean);
    if (parts.length) return parts.join(", ");
    return country || "United States";
  }

  function _stripHtml(text) {
    if (!text || !text.includes("<")) return text || "";
    // Browser DOM-based strip: safe because the string is never inserted
    // anywhere — we only read .textContent.
    const div = document.createElement("div");
    div.innerHTML = text;
    return (div.textContent || "").trim();
  }

  // ── 7. Per-provider response normalizers ─────────────────────────────
  // Each takes the `data` field returned by the Worker (which is the raw
  // upstream JSON) and emits a list of canonical job dicts. The defensive
  // fallbacks mirror the Python try/except blocks in job_scraper.py.

  function _normalizeJsearch(data) {
    const out = [];
    const batch = (data && data.data) || [];
    for (const j of batch) {
      const isRemote = !!j.job_is_remote;
      out.push({
        id: `jsearch_${j.job_id || out.length}`,
        title: String(j.job_title || "").trim(),
        company: j.employer_name || "Unknown",
        location: _location(j.job_city, j.job_state, j.job_country, isRemote),
        posted: _normalizeDate(j.job_posted_at_datetime_utc),
        salary: _salary(j.job_min_salary, j.job_max_salary, j.job_salary_period),
        url: j.job_apply_link || j.job_google_link || "",
        source: j.job_publisher || "JSearch",
        description: String(j.job_description || "").slice(0, 8000),
        type: String(j.job_employment_type || "").replace(/_/g, " ")
          .replace(/\w\S*/g, (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()),
      });
    }
    return out;
  }

  function _normalizeAdzuna(data, location) {
    const out = [];
    const batch = (data && data.results) || [];
    for (const j of batch) {
      const company = (j.company && j.company.display_name) || "Unknown";
      const locArea = (j.location && j.location.area) || [];
      const locStr = locArea.length ? locArea.slice(-2).join(", ") : location;
      out.push({
        id: `adzuna_${j.id || out.length}`,
        title: String(j.title || "").trim(),
        company,
        location: locStr,
        posted: _normalizeDate(j.created),
        salary: _salary(j.salary_min, j.salary_max, "year"),
        url: j.redirect_url || "",
        source: "Adzuna",
        description: _stripHtml(j.description || "").slice(0, 8000),
        type: String(j.contract_time || "").replace(/_/g, " ")
          .replace(/\w\S*/g, (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()),
      });
    }
    return out;
  }

  function _normalizeThemuse(data, location) {
    const out = [];
    const batch = (data && data.results) || [];
    for (const j of batch) {
      const locs = j.locations || [];
      const locStr = (locs[0] && locs[0].name) || location;
      const company = (j.company && j.company.name) || "Unknown";
      out.push({
        id: `muse_${j.id || out.length}`,
        title: String(j.name || "").trim(),
        company,
        location: locStr,
        posted: _normalizeDate(j.publication_date),
        salary: "See listing",
        url: (j.refs && j.refs.landing_page) || "",
        source: "The Muse",
        description: "",
        type: String(j.type || "").replace(/_/g, " ")
          .replace(/\w\S*/g, (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()),
      });
    }
    return out;
  }

  function _normalizeRemotive(data) {
    const out = [];
    const batch = (data && data.jobs) || [];
    for (const j of batch) {
      const region = j.candidate_required_location || "Worldwide";
      out.push({
        id: `remotive_${j.id || out.length}`,
        title: String(j.title || "").trim(),
        company: j.company_name || "Unknown",
        location: `Remote — ${region}`,
        posted: _normalizeDate(j.publication_date),
        salary: j.salary || "See listing",
        url: j.url || "",
        source: "Remotive",
        description: _stripHtml(j.description || "").slice(0, 8000),
        type: "Remote",
      });
    }
    return out;
  }

  function _normalizeUsajobs(data, location) {
    const out = [];
    const items = (data && data.SearchResult && data.SearchResult.SearchResultItems) || [];
    for (const item of items) {
      const d = item.MatchedObjectDescriptor || {};
      const sal = (d.PositionRemuneration && d.PositionRemuneration[0]) || {};
      let url = "";
      const uris = d.ApplyURI || d.PositionURI || [];
      if (Array.isArray(uris) && uris.length) url = uris[0];
      else if (typeof uris === "string") url = uris;
      out.push({
        id: `usajobs_${d.PositionID || out.length}`,
        title: String(d.PositionTitle || "").trim(),
        company: d.OrganizationName || "US Federal Government",
        location: d.PositionLocationDisplay || location,
        posted: _normalizeDate(d.PublicationStartDate),
        salary: _salary(sal.MinimumRange, sal.MaximumRange, "year"),
        url,
        source: "USAJobs",
        description: _stripHtml(
          ((d.UserArea && d.UserArea.Details && d.UserArea.Details.JobSummary) || "")
        ).slice(0, 8000),
        type: (d.PositionSchedule && d.PositionSchedule[0] && d.PositionSchedule[0].Name) || "",
      });
    }
    return out;
  }

  function _normalizeArbeitnow(data) {
    const out = [];
    const batch = (data && data.data) || [];
    for (const j of batch) {
      const loc = j.location || "";
      const isRemote = !!j.remote;
      if (!isRemote && !_isUsOrRemote(loc)) continue;
      out.push({
        id: `arbeitnow_${j.slug || out.length}`,
        title: String(j.title || "").trim(),
        company: j.company_name || "Unknown",
        location: isRemote ? "Remote" : loc,
        posted: _normalizeDate(String(j.created_at || "")),
        salary: "See listing",
        url: j.url || "",
        source: "Arbeitnow",
        description: _stripHtml(j.description || "").slice(0, 8000),
        type: isRemote ? "Remote" : "",
      });
    }
    return out;
  }

  // ── 8. Worker fetch helper ───────────────────────────────────────────
  // BYOK headers come from window.authHeaders() (defined in app.js). We
  // strip Authorization and X-Anthropic-Key / X-Claude-Model — the Worker
  // doesn't need them and we don't want to leak them to a third-party
  // origin even if it's our own. Only forward the job-board keys.
  function _byokForWorker() {
    // authHeaders is a top-level function declaration in app.js, which
    // makes it implicitly global in the page. Fall back to window.* in
    // case a future refactor moves it inside an IIFE.
    const fn =
      (typeof authHeaders === "function" && authHeaders) ||
      (typeof window !== "undefined" && window.authHeaders) ||
      null;
    const all = (fn && fn()) || {};
    const out = {};
    const ALLOW = new Set([
      "X-RapidAPI-Key",
      "X-Adzuna-App-Id",
      "X-Adzuna-App-Key",
      "X-USAJobs-Email",
      "X-USAJobs-Key",
    ]);
    for (const [k, v] of Object.entries(all)) {
      if (ALLOW.has(k) && v) out[k] = v;
    }
    return out;
  }

  async function _workerCall(workerUrl, platform, params) {
    const url = workerUrl.replace(/\/+$/, "") + "/search";
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ..._byokForWorker(),
      },
      body: JSON.stringify({ platform, ...params }),
    });
    let payload = null;
    try {
      payload = await resp.json();
    } catch {
      payload = null;
    }
    if (!resp.ok) {
      const detail =
        (payload && (payload.detail || payload.error)) ||
        `Worker returned ${resp.status}`;
      throw new Error(`[${platform}] ${detail}`);
    }
    return (payload && payload.data) || {};
  }

  // ── 9. Per-platform orchestrators ────────────────────────────────────
  // Mirror the Python search_jsearch / search_adzuna / etc. — including
  // multi-page pagination for jsearch / adzuna / themuse / arbeitnow.

  async function _runJsearch(workerUrl, title, location, datePosted) {
    if (!_byokForWorker()["X-RapidAPI-Key"]) return [];
    const out = [];
    const pagesNeeded = Math.min(Math.floor(100 / 10) + 1, 5);
    for (let page = 1; page <= pagesNeeded; page++) {
      let data;
      try {
        data = await _workerCall(workerUrl, "jsearch", {
          title, location, page, date_posted: datePosted,
        });
      } catch {
        break;
      }
      const batch = _normalizeJsearch(data);
      if (!batch.length) break;
      out.push(...batch);
      if (out.length >= 100) break;
    }
    return out;
  }

  async function _runAdzuna(workerUrl, title, location, datePosted) {
    const creds = _byokForWorker();
    if (!creds["X-Adzuna-App-Id"] || !creds["X-Adzuna-App-Key"]) return [];
    const out = [];
    for (let page = 1; page <= 4; page++) {
      let data;
      try {
        data = await _workerCall(workerUrl, "adzuna", {
          title, location, page, date_posted: datePosted,
        });
      } catch {
        break;
      }
      const batch = _normalizeAdzuna(data, location);
      if (!batch.length) break;
      out.push(...batch);
    }
    return out;
  }

  async function _runThemuse(workerUrl, title, location) {
    const out = [];
    for (let page = 1; page <= 4; page++) {
      let data;
      try {
        data = await _workerCall(workerUrl, "themuse", { title, location, page });
      } catch {
        break;
      }
      const batch = _normalizeThemuse(data, location);
      if (!batch.length) break;
      out.push(...batch);
    }
    return out;
  }

  async function _runRemotive(workerUrl, title) {
    let data;
    try {
      data = await _workerCall(workerUrl, "remotive", { title });
    } catch {
      return [];
    }
    return _normalizeRemotive(data);
  }

  async function _runUsajobs(workerUrl, title, location, datePosted) {
    let data;
    try {
      data = await _workerCall(workerUrl, "usajobs", {
        title, location, date_posted: datePosted,
      });
    } catch {
      return [];
    }
    return _normalizeUsajobs(data, location);
  }

  async function _runArbeitnow(workerUrl, title) {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      let data;
      try {
        data = await _workerCall(workerUrl, "arbeitnow", { title, page });
      } catch {
        break;
      }
      const batch = _normalizeArbeitnow(data);
      if (!batch.length) break;
      out.push(...batch);
    }
    return out;
  }

  // ── 10. Top-level orchestrator ───────────────────────────────────────
  // Promise.allSettled across all 6 sources with a 60-second wall-clock
  // budget (matches the Python ThreadPoolExecutor `as_completed(timeout=60)`
  // semantics). Each source that hasn't finished by the deadline is
  // ignored — its in-flight `fetch` will still complete in the background
  // but its results are discarded.
  async function searchJobsViaWorker(opts) {
    const title = String((opts && opts.title) || "").trim();
    const location = String((opts && opts.location) || "United States").trim() ||
      "United States";
    const seniority = (opts && opts.seniority) || "any";
    const datePosted = (opts && opts.datePosted) || "pastWeek";
    const workerUrl = String((opts && opts.workerUrl) || "").trim();

    if (!title) throw new Error("Job title is required");
    if (!workerUrl) throw new Error("Cloudflare Worker URL not configured");

    const SOURCES = [
      () => _runJsearch(workerUrl, title, location, datePosted),
      () => _runAdzuna(workerUrl, title, location, datePosted),
      () => _runThemuse(workerUrl, title, location),
      () => _runRemotive(workerUrl, title),
      () => _runUsajobs(workerUrl, title, location, datePosted),
      () => _runArbeitnow(workerUrl, title),
    ];

    const WALL_CLOCK_MS = 60000;
    const deadline = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("budget-exceeded")), WALL_CLOCK_MS)
    );
    const runs = SOURCES.map((fn) =>
      Promise.race([fn(), deadline]).catch(() => [])
    );
    const settled = await Promise.allSettled(runs);
    let all = [];
    for (const r of settled) {
      if (r.status === "fulfilled" && Array.isArray(r.value)) {
        all = all.concat(r.value);
      }
    }

    // ── Filter pipeline (identical order to Python search_all_platforms)
    // 1. US / Remote
    all = all.filter((j) => _isUsOrRemote(j.location || ""));
    // 2. Non-empty title guard
    all = all.filter((j) => (j.title || "").trim());
    // 3. Title relevance (any alias matches)
    const aliases = _expandAliases(title);
    all = all.filter((j) =>
      aliases.some((a) => _titleMatches(j.title || "", a))
    );
    // 4. Seniority
    if (seniority && seniority !== "any") {
      all = all.filter((j) => _seniorityMatches(j.title || "", seniority));
    }
    // 5. Date window (fail-open on unparseable dates)
    const dateWindow =
      { past24Hours: 1, pastWeek: 7, pastMonth: 30 }[datePosted] || 7;
    all = all.filter((j) => {
      const d = _daysOld(j.posted || "");
      return d === null || d <= dateWindow;
    });
    // 6. Dedup by (title, company)
    const seen = new Set();
    const unique = [];
    for (const j of all) {
      const key =
        (j.title || "").toLowerCase().trim().slice(0, 60) +
        "||" +
        (j.company || "").toLowerCase().trim().slice(0, 50);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(j);
      }
    }
    for (let i = 0; i < unique.length; i++) unique[i].idx = i;

    const sources = Array.from(new Set(unique.map((j) => j.source)));
    return { jobs: unique, count: unique.length, sources, title, location };
  }

  // Public API
  window.searchJobsViaWorker = searchJobsViaWorker;
})();
