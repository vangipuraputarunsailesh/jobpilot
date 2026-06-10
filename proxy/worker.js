// JobPilot job-search proxy — Cloudflare Worker (Phase 5)
//
// This is a STATELESS forwarder. It accepts:
//   POST /search { platform, title, location, date_posted, page }
// and forwards to the requested job-board API with credentials taken from
// the per-request BYOK headers:
//   X-RapidAPI-Key      (JSearch)
//   X-Adzuna-App-Id     (Adzuna app_id)
//   X-Adzuna-App-Key    (Adzuna app_key)
//   X-USAJobs-Email     (USAJobs User-Agent + Host headers)
//   X-USAJobs-Key       (USAJobs Authorization-Key)
//
// The Worker NEVER stores keys, NEVER reads from environment variables,
// and NEVER logs request bodies or BYOK headers. It only proxies.
//
// Returns the upstream provider's raw JSON, with a `__platform` field added
// so the client can route the response without re-parsing the URL.
//
// CORS: configure ALLOW_ORIGINS via wrangler.toml. The default during local
// dev is permissive (`*`) — tighten to `https://<USERNAME>.github.io`
// before deploying.

// ── Provider configuration ───────────────────────────────────────────────
// Each platform exposes one HTTP call that the Worker forwards. The actual
// shape of the response is parsed CLIENT-side in static/js/jobs.js so the
// Worker stays tiny and the parsing logic has a single source of truth.
const PROVIDERS = {
  jsearch: {
    needs: ["X-RapidAPI-Key"],
    build({ title, location, page = 1, date_posted = "pastWeek" }, headers) {
      const dateMap = { past24Hours: "today", pastWeek: "week", pastMonth: "month" };
      const url = new URL("https://jsearch.p.rapidapi.com/search");
      url.searchParams.set("query", `${title} in ${location}`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("num_pages", "1");
      url.searchParams.set("date_posted", dateMap[date_posted] || "week");
      return {
        url: url.toString(),
        init: {
          method: "GET",
          headers: {
            "X-RapidAPI-Key": headers.get("X-RapidAPI-Key") || "",
            "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
          },
        },
      };
    },
  },

  adzuna: {
    needs: ["X-Adzuna-App-Id", "X-Adzuna-App-Key"],
    build({ title, location, page = 1, date_posted = "pastWeek" }, headers) {
      const maxDaysOld =
        date_posted === "past24Hours" ? 1 : date_posted === "pastMonth" ? 30 : 7;
      const url = new URL(
        `https://api.adzuna.com/v1/api/jobs/us/search/${Number(page) || 1}`
      );
      url.searchParams.set("app_id", headers.get("X-Adzuna-App-Id") || "");
      url.searchParams.set("app_key", headers.get("X-Adzuna-App-Key") || "");
      url.searchParams.set("results_per_page", "20");
      url.searchParams.set("what_phrase", title);
      url.searchParams.set("where", location);
      url.searchParams.set("max_days_old", String(maxDaysOld));
      url.searchParams.set("sort_by", "date");
      return { url: url.toString(), init: { method: "GET" } };
    },
  },

  themuse: {
    needs: [],
    build({ title, location, page = 1 }) {
      // Loose location mapping — themuse only supports a few US cities.
      const locMap = {
        seattle: "Seattle, WA",
        "new york": "New York City, NY",
        "san francisco": "San Francisco, CA",
        "los angeles": "Los Angeles, CA",
        austin: "Austin, TX",
        chicago: "Chicago, IL",
        boston: "Boston, MA",
        denver: "Denver, CO",
        atlanta: "Atlanta, GA",
        dallas: "Dallas, TX",
        houston: "Houston, TX",
        miami: "Miami, FL",
        washington: "Washington, DC",
        remote: "Flexible / Remote",
      };
      const locLower = String(location || "").toLowerCase();
      const museLoc = Object.entries(locMap).find(([k]) => locLower.includes(k));
      const url = new URL("https://www.themuse.com/api/public/jobs");
      url.searchParams.set("descending", "true");
      url.searchParams.set("category", title);
      url.searchParams.set("page", String(page));
      if (museLoc) url.searchParams.set("location", museLoc[1]);
      return { url: url.toString(), init: { method: "GET" } };
    },
  },

  remotive: {
    needs: [],
    build({ title }) {
      const url = new URL("https://remotive.com/api/remote-jobs");
      url.searchParams.set("search", title);
      url.searchParams.set("limit", "100");
      return { url: url.toString(), init: { method: "GET" } };
    },
  },

  usajobs: {
    needs: [],
    build({ title, location, date_posted = "pastWeek" }, headers) {
      const daysWindow =
        date_posted === "past24Hours" ? 1 : date_posted === "pastMonth" ? 30 : 7;
      const url = new URL("https://data.usajobs.gov/api/search");
      url.searchParams.set("Keyword", title);
      url.searchParams.set("LocationName", location);
      url.searchParams.set("DatePosted", String(daysWindow));
      url.searchParams.set("ResultsPerPage", "25");
      url.searchParams.set("SortField", "OpenDate");
      url.searchParams.set("SortDirection", "Desc");
      const hdrs = {
        Host: "data.usajobs.gov",
        "User-Agent":
          headers.get("X-USAJobs-Email") || "jobpilot@example.com",
      };
      const apiKey = headers.get("X-USAJobs-Key");
      if (apiKey) hdrs["Authorization-Key"] = apiKey;
      return { url: url.toString(), init: { method: "GET", headers: hdrs } };
    },
  },

  arbeitnow: {
    needs: [],
    build({ title, page = 1 }) {
      const url = new URL("https://www.arbeitnow.com/api/job-board-api");
      url.searchParams.set("search", title);
      url.searchParams.set("page", String(page));
      return { url: url.toString(), init: { method: "GET" } };
    },
  },
};

// ── CORS helpers ─────────────────────────────────────────────────────────

function allowedOrigin(req, env) {
  const allowList = (env.ALLOW_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.get("Origin") || "";
  if (allowList.includes("*")) return "*";
  return allowList.includes(origin) ? origin : "";
}

function corsHeaders(req, env) {
  const origin = allowedOrigin(req, env);
  return {
    "Access-Control-Allow-Origin": origin || "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-RapidAPI-Key, X-Adzuna-App-Id, X-Adzuna-App-Key, X-USAJobs-Email, X-USAJobs-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(req, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req, env),
    },
  });
}

// ── Main handler ─────────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    }

    const url = new URL(req.url);

    // Health check — no auth, no upstream call.
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse(req, env, {
        service: "jobpilot-proxy",
        status: "ok",
        providers: Object.keys(PROVIDERS),
      });
    }

    if (url.pathname !== "/search" || req.method !== "POST") {
      return jsonResponse(req, env, { detail: "Not found" }, 404);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(req, env, { detail: "Invalid JSON body" }, 400);
    }

    const platform = String(body.platform || "").toLowerCase();
    const provider = PROVIDERS[platform];
    if (!provider) {
      return jsonResponse(
        req,
        env,
        { detail: `Unknown platform '${platform}'. Allowed: ${Object.keys(PROVIDERS).join(", ")}` },
        400
      );
    }

    // Reject missing BYOK headers up-front so the client gets a clean signal
    // instead of an opaque upstream 401/403.
    for (const headerName of provider.needs) {
      if (!req.headers.get(headerName)) {
        return jsonResponse(
          req,
          env,
          { detail: `Missing required header ${headerName} for platform '${platform}'.` },
          400
        );
      }
    }

    let target;
    try {
      target = provider.build(body, req.headers);
    } catch (e) {
      return jsonResponse(req, env, { detail: `Bad request: ${e.message}` }, 400);
    }

    // Bound the upstream call so a slow provider can't hold the Worker open.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    let upstream;
    try {
      upstream = await fetch(target.url, { ...target.init, signal: controller.signal });
    } catch (e) {
      clearTimeout(timeoutId);
      return jsonResponse(
        req,
        env,
        { detail: `Upstream fetch failed for '${platform}': ${e.message}` },
        502
      );
    }
    clearTimeout(timeoutId);

    let payload;
    try {
      payload = await upstream.json();
    } catch {
      const text = await upstream.text().catch(() => "");
      return jsonResponse(
        req,
        env,
        {
          detail: `Upstream '${platform}' returned non-JSON`,
          upstream_status: upstream.status,
          upstream_body: text.slice(0, 500),
        },
        502
      );
    }

    return jsonResponse(req, env, {
      __platform: platform,
      __upstream_status: upstream.status,
      data: payload,
    }, upstream.ok ? 200 : upstream.status);
  },
};
