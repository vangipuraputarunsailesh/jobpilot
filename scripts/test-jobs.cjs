const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "jobpilot", "static", "js", "jobs.js"), "utf8");
const options = { title: "software engineer", workerUrl: "https://worker.example.test/" };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));
const empty = platform => platform === "usajobs"
  ? { SearchResult: { SearchResultItems: [] } }
  : { [platform === "remotive" ? "jobs" : ["adzuna", "themuse"].includes(platform) ? "results" : "data"]: [] };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ data }) });
const museJob = (id, extra = {}) => ({
  id, name: "Software Engineer", company: { name: `Company ${id}` },
  locations: [{ name: "Seattle, WA" }], publication_date: "Today",
  refs: { landing_page: `https://jobs.example.test/${id}` }, type: "full_time", ...extra,
});
const keys = {
  "X-RapidAPI-Key": "rapid-secret", "X-Adzuna-App-Id": "adzuna-id",
  "X-Adzuna-App-Key": "adzuna-secret", "X-USAJobs-Email": "private@example.test",
  "X-USAJobs-Key": "usajobs-secret", Authorization: "identity-secret",
  "X-Anthropic-Key": "anthropic-secret", "X-OpenAI-Key": "openai-secret",
  "X-Gemini-Key": "gemini-secret", "X-OpenRouter-Key": "openrouter-secret",
  "X-Custom-Key": "custom-secret", "X-Claude-Model": "private-model",
};

function harness(headers = {}) {
  let now = 0;
  let id = 0;
  const timers = new Map();
  const requests = [];
  const active = new Set();
  const logs = [];
  const clock = {
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { at: now + ms, fn }); return key; },
    clearTimeout(key) { timers.delete(key); },
    async advance(ms) {
      await flush();
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
  const context = vm.createContext({
    AbortController, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    authHeaders: () => headers,
    console: { warn: (...v) => logs.push(v), error: (...v) => logs.push(v) },
    document: {
      createElement: () => ({
        set innerHTML(value) { this.textContent = value.replace(/<[^>]*>/g, ""); },
        textContent: "",
      }),
    },
    fetch: (url, init) => {
      const request = { url, ...init, params: JSON.parse(init.body) };
      requests.push(request);
      return h.handle(request);
    },
  });
  context.window = context;
  vm.runInContext(source, context);
  const h = {
    requests, active, logs, timers, clock, context,
    search: overrides => context.searchJobsViaWorker({ ...options, ...overrides }),
    handle: request => response(empty(request.params.platform)),
    wait(request, ms, value) {
      return new Promise((resolve, reject) => {
        active.add(request);
        let timer;
        const cleanup = () => {
          active.delete(request);
          clock.clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
        };
        const abort = () => { cleanup(); reject(new Error("unsafe provider cancellation payload")); };
        request.signal.addEventListener("abort", abort, { once: true });
        if (ms !== undefined) timer = clock.setTimeout(() => { cleanup(); resolve(value); }, ms);
        if (request.signal.aborted) abort();
      });
    },
    clean() { assert.equal(active.size, 0); assert.equal(timers.size, 0); },
  };
  return h;
}

test("empty success runs three public sources, skips unconfigured providers, and clears timers", async () => {
  const h = harness();
  const result = await h.search();
  assert.deepEqual(plain(result), {
    jobs: [], count: 0, sources: [], title: options.title, location: "United States", warnings: [],
  });
  assert.deepEqual(h.requests.map(r => r.params.platform), ["themuse", "remotive", "arbeitnow"]);
  h.clean();
});

test("only each provider's allowed job-board headers reach the configured Worker; no fallback", async () => {
  const h = harness(keys);
  await h.search();
  assert.equal(h.requests.length, 6);
  const allowed = {
    jsearch: ["X-RapidAPI-Key"], adzuna: ["X-Adzuna-App-Id", "X-Adzuna-App-Key"],
    usajobs: ["X-USAJobs-Email", "X-USAJobs-Key"],
  };
  for (const r of h.requests) {
    assert.equal(r.url, "https://worker.example.test/search");
    assert.equal(r.redirect, "error");
    assert.equal(r.credentials, "omit");
    assert.deepEqual(Object.keys(r.headers), ["Content-Type", ...(allowed[r.params.platform] || [])]);
    for (const [key, value] of Object.entries(keys)) {
      assert.equal(JSON.stringify(r).includes(value), (allowed[r.params.platform] || []).includes(key));
      assert.ok(!r.body.includes(value));
    }
  }
  h.clean();
});

test("disabled credentialed providers and incomplete credentials are skipped, public sources always run", async () => {
  const h = harness({ ...keys, "X-Adzuna-App-Key": "", "X-USAJobs-Email": "" });
  const result = await h.search({ disabledProviders: ["jsearch", "themuse", "remotive", "arbeitnow"] });
  assert.deepEqual(h.requests.map(r => r.params.platform), ["themuse", "remotive", "arbeitnow"]);
  assert.deepEqual(plain(result.warnings), []);
  h.clean();
});

test("already cancelled search rejects AbortError without requests or timers", async () => {
  const h = harness();
  const c = new AbortController();
  c.abort("private abort reason");
  await assert.rejects(h.search({ signal: c.signal }), { name: "AbortError", message: "Job search cancelled" });
  assert.equal(h.requests.length, 0);
  h.clean();
});

test("caller cancellation aborts every pending provider and removes caller listener", async () => {
  const h = harness(keys);
  const c = new AbortController();
  let listeners = 0;
  const signal = {
    get aborted() { return c.signal.aborted; },
    addEventListener(...args) { listeners++; c.signal.addEventListener(...args); },
    removeEventListener(...args) { listeners--; c.signal.removeEventListener(...args); },
  };
  h.handle = r => h.wait(r);
  const result = h.search({ signal });
  const rejected = assert.rejects(result, { name: "AbortError", message: "Job search cancelled" });
  assert.equal(h.active.size, 6);
  c.abort(new Error("identity-secret"));
  await rejected;
  assert.ok(h.requests.every(r => r.signal.aborted));
  assert.equal(listeners, 0);
  h.clean();
});

test("caller cancellation wins over already completed partial results and stops pagination", async () => {
  const h = harness();
  h.handle = r => r.params.platform === "themuse" && r.params.page === 1
    ? response({ results: [museJob(1)] }) : h.wait(r);
  const c = new AbortController();
  const promise = h.search({ signal: c.signal });
  const rejected = assert.rejects(promise, { name: "AbortError" });
  await flush();
  assert.equal(h.requests.filter(r => r.params.platform === "themuse").length, 2);
  c.abort();
  await rejected;
  await h.clock.advance(120000);
  assert.equal(h.requests.length, 4);
  h.clean();
});

test("caller cancellation also interrupts response body reads", async () => {
  const h = harness();
  const c = new AbortController();
  h.handle = r => ({ ok: true, status: 200, json: () => h.wait(r) });
  const rejected = assert.rejects(h.search({ signal: c.signal }), { name: "AbortError" });
  await flush();
  assert.equal(h.active.size, 3);
  c.abort("private cancellation details");
  await rejected;
  assert.ok(h.requests.every(r => r.signal.aborted));
  h.clean();
});

test("settled searches release the caller abort listener and deadline", async () => {
  const h = harness();
  const c = new AbortController();
  let listeners = 0;
  const signal = {
    get aborted() { return c.signal.aborted; },
    addEventListener(...args) { listeners++; c.signal.addEventListener(...args); },
    removeEventListener(...args) { listeners--; c.signal.removeEventListener(...args); },
  };
  await h.search({ signal });
  assert.equal(listeners, 0);
  c.abort();
  await h.clock.advance(120000);
  assert.ok(h.requests.every(r => !r.signal.aborted));
  h.clean();
});

test("timeouts settle even when a transport ignores abort while still signalling cancellation", async () => {
  const h = harness();
  h.handle = () => new Promise(() => {});
  const rejected = assert.rejects(h.search(), /All job sources failed/);
  await h.clock.advance(20000);
  await rejected;
  assert.ok(h.requests.every(r => r.signal.aborted));
  h.clean();
});

test("20-second page timeout aborts pending requests and reports all-source failure safely", async () => {
  const h = harness();
  h.handle = r => h.wait(r);
  const promise = h.search();
  const rejected = assert.rejects(promise, error => {
    assert.equal(error.message, "All job sources failed: [themuse] request timed out; [remotive] request timed out; [arbeitnow] request timed out");
    return true;
  });
  await h.clock.advance(20000);
  await rejected;
  assert.ok(h.requests.every(r => r.signal.aborted));
  h.clean();
});

test("timeout covers response body parsing, not just fetch headers", async () => {
  const h = harness();
  h.handle = r => ({ ok: true, status: 200, json: () => h.wait(r) });
  const rejected = assert.rejects(h.search(), /request timed out/);
  await h.clock.advance(20000);
  await rejected;
  assert.ok(h.requests.every(r => r.signal.aborted));
  h.clean();
});

test("60-second aggregate deadline aborts later pages while preserving completed pages and warnings", async () => {
  const h = harness();
  h.handle = r => r.params.platform === "themuse"
    ? h.wait(r, 19000, response({ results: [museJob(r.params.page)] }))
    : response(empty(r.params.platform));
  const promise = h.search();
  await h.clock.advance(60000);
  const result = await promise;
  assert.equal(result.count, 3);
  assert.deepEqual(plain(result.warnings), ["[themuse] search deadline exceeded"]);
  const requests = h.requests.filter(r => r.params.platform === "themuse");
  assert.equal(requests.length, 4);
  assert.equal(requests[3].signal.aborted, true);
  await h.clock.advance(120000);
  h.clean();
});

test("partial provider failure and later-page errors remain visible without exposing payloads", async () => {
  const h = harness(keys);
  h.handle = r => {
    if (r.params.platform === "themuse" && r.params.page === 1) return response({ results: [museJob(1)] });
    if (r.params.platform === "remotive") throw new Error(JSON.stringify(keys));
    if (r.params.platform === "arbeitnow") return response({ data: [] });
    return { ok: false, status: 429, json: () => { throw new Error("must not read provider error body"); } };
  };
  const result = await h.search();
  assert.equal(result.count, 1);
  assert.deepEqual(plain(result.warnings), [
    "[jsearch] HTTP 429", "[adzuna] HTTP 429", "[themuse] HTTP 429",
    "[remotive] network request failed", "[usajobs] HTTP 429",
  ]);
  for (const value of Object.values(keys)) assert.ok(!JSON.stringify([result, h.logs]).includes(value));
  h.clean();
});

test("all failures reject an informative sanitized error and never fall back", async () => {
  const h = harness(keys);
  h.handle = () => { throw new Error(JSON.stringify(keys)); };
  await assert.rejects(h.search(), error => {
    assert.match(error.message, /^All job sources failed:/);
    for (const value of Object.values(keys)) assert.ok(!error.message.includes(value));
    for (const platform of ["jsearch", "adzuna", "themuse", "remotive", "usajobs", "arbeitnow"]) {
      assert.ok(error.message.includes(`[${platform}] network request failed`));
    }
    return true;
  });
  assert.equal(h.requests.length, 6);
  assert.deepEqual(h.logs, []);
  h.clean();
});

test("invalid JSON, malformed Worker envelopes and malformed rows report invalid response", async () => {
  const h = harness();
  h.handle = r => r.params.platform === "themuse"
    ? { ok: true, status: 200, json: async () => { throw new Error("sensitive raw body"); } }
    : r.params.platform === "remotive" ? response({ jobs: [null] }) : response({});
  await assert.rejects(h.search(), error => {
    assert.equal(error.message, "All job sources failed: [themuse] invalid response; [remotive] invalid response; [arbeitnow] invalid response");
    return true;
  });
  h.clean();
});

test("normalization, relevance/location/seniority/date filters, dedup and provider order remain unchanged", async () => {
  const h = harness();
  const jobs = [
    museJob(1, { name: "Senior Software Engineer", company: { name: "Same" } }),
    museJob(2, { name: "" }),
    museJob(3, { name: "Senior Nurse" }),
    museJob(4, { name: "Senior Software Engineer", locations: [{ name: "London, UK" }] }),
    museJob(5, { name: "Junior Software Engineer" }),
    museJob(6, { name: "Senior Software Engineer", publication_date: "8 days ago" }),
    museJob(7, { name: "Senior Software Engineer", publication_date: "unknown" }),
  ];
  h.handle = r => {
    if (r.params.platform === "themuse") return response({ results: r.params.page === 1 ? jobs : [] });
    if (r.params.platform === "remotive") return response({ jobs: [
      { id: 1, title: "Senior Software Engineer", company_name: "Same" },
      { id: 2, title: "Senior Software Engineer", company_name: "Remote company", description: "<b>Build</b>" },
    ] });
    return response({ data: r.params.page === 1 ? [
      { slug: "a", title: "Senior Software Engineer", company_name: "Final", remote: true },
    ] : [] });
  };
  const result = await h.search({ seniority: "senior" });
  assert.deepEqual(plain(result.jobs.map(j => j.id)), ["muse_1", "muse_7", "remotive_2", "arbeitnow_a"]);
  assert.deepEqual(plain(result.jobs.map(j => j.idx)), [0, 1, 2, 3]);
  assert.deepEqual(plain(result.sources), ["The Muse", "Remotive", "Arbeitnow"]);
  assert.equal(result.jobs[0].type, "Full Time");
  assert.equal(result.jobs[0].salary, "See listing");
  assert.equal(result.jobs[2].description, "Build");
  assert.deepEqual(plain(result.warnings), []);
  h.clean();
});
