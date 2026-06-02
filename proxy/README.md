# JobPilot Job-Search Proxy (Cloudflare Worker)

This is the **Phase 5** stateless job-search proxy. It exists so the
JobPilot static frontend (Phase 6 GitHub Pages cutover) can reach
`api.adzuna.com`, `jsearch.p.rapidapi.com`, `data.usajobs.gov`,
`www.themuse.com`, `remotive.com`, and `www.arbeitnow.com` without
hitting browser CORS restrictions or exposing BYOK keys to a third-party
origin.

The Worker:

- accepts `POST /search { platform, title, location, date_posted, page }`
- forwards the request to the chosen provider with BYOK headers passed
  through verbatim (`X-RapidAPI-Key`, `X-Adzuna-App-Id`, `X-Adzuna-App-Key`,
  `X-USAJobs-Email`, `X-USAJobs-Key`)
- returns the upstream JSON wrapped as `{ __platform, __upstream_status, data }`
- **never stores keys, never reads env vars for keys, never logs request bodies**

The client (`jobpilot/static/js/jobs.js`) is the single source of truth
for response normalization, deduplication, and filtering. The Worker
stays tiny on purpose.

## Endpoints

| Path | Method | Notes |
| --- | --- | --- |
| `/`, `/health` | `GET` | Health check. No auth, no upstream call. |
| `/search` | `POST` | Forwards to one provider. JSON body required. |

## Deploy

```pwsh
# 1. Install Cloudflare's wrangler CLI (one-time).
npm install -g wrangler

# 2. Sign in to your Cloudflare account.
wrangler login

# 3. From inside this directory, deploy.
cd proxy
wrangler deploy
```

Wrangler will print the deployed URL, e.g.
`https://jobpilot-proxy.<your-subdomain>.workers.dev`. Paste that URL into
the **Cloudflare Worker URL** field of JobPilot's in-app Settings modal.

## CORS hardening

The default `wrangler.toml` ships with `ALLOW_ORIGINS = "*"` so you can
test locally. **Before production**, edit `wrangler.toml`:

```toml
[vars]
ALLOW_ORIGINS = "https://<your-username>.github.io,https://www.jobspilot.site"
```

…and redeploy with `wrangler deploy`.

## Security guarantees

1. **No persisted state.** The Worker has no KV, no D1, no R2, no env var
   key material. Every request is a clean forward.
2. **No header logging.** The Worker never serializes `X-*-Key` headers
   into the response body or into `console.log`.
3. **Upstream timeout.** Each forwarded fetch is bounded by a 15-second
   `AbortController` so a slow provider can't pin the Worker open.
4. **Header allow-list.** CORS pre-flight only advertises the BYOK
   header names this Worker actually forwards.

## Local development

```pwsh
cd proxy
wrangler dev
```

This boots the Worker at `http://localhost:8787`. Smoke test:

```pwsh
curl -X POST http://localhost:8787/search `
     -H "Content-Type: application/json" `
     -H "X-RapidAPI-Key: <your-key>" `
     -d '{"platform":"jsearch","title":"data engineer","location":"United States"}'
```

## Why a Worker (and not, say, Netlify Functions or Vercel Edge)?

Cloudflare Workers give you 100,000 requests/day on the free tier, run on
a global anycast network with sub-50 ms cold starts, and bill nothing for
the kind of personal-use traffic JobPilot generates. No credit card
required to deploy. For a single-developer self-hostable tool, this is
the lowest-friction option that meets the no-server constraint of the
GitHub Pages cutover.
