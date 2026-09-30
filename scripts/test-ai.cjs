const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const source = name => fs.readFileSync(path.join(root, "jobpilot", "static", "js", name), "utf8");
const score = {
  score: 82, verdict: "Strong Match", matched_keywords: ["JavaScript"], missing_keywords: [],
  categories: { core_skills: 82, experience_match: 82, tools_technologies: 82, domain_knowledge: 82, soft_skills: 82 },
  tip: "Show a relevant project.",
};
const response = data => ({ ok: true, status: 200, json: async () => data });
const generated = (provider, text) => provider === "anthropic"
  ? { content: [{ type: "text", text }], stop_reason: "end_turn" }
  : provider === "gemini"
    ? { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }
    : { choices: [{ message: { content: text }, finish_reason: "stop" }] };

function harness(settings = {}, withApp = false) {
  const requests = [];
  const values = new Map();
  const elements = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: "", textContent: "", innerHTML: "", className: "", hidden: false,
      disabled: false, checked: false, style: {}, classList: { add() {}, remove() {} },
      setAttribute(name, value) { this[name] = value; },
      scrollIntoView() {}, focus() {}, prepend() {},
      removeAttribute(name) { delete this[name]; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    URL, AbortController, AbortSignal, DOMException, TextEncoder, TextDecoder, crypto: webcrypto, btoa, atob,
    setTimeout, clearTimeout, addEventListener() {}, console: { warn() {}, error() {} },
    localStorage: storage, sessionStorage: { ...storage },
    document: { addEventListener() {}, getElementById: element, querySelectorAll: () => [],
      createElement: () => element("created-" + elements.size), body: { style: {} } },
    getAiSettings: () => settings,
    bumpUsage: () => {},
    fetch: async (url, options) => {
      requests.push({ url: String(url), ...options });
      return response(generated(settings.ai_provider || "anthropic", "OK"));
    },
  });
  context.window = context;
  vm.runInContext(source("ai.js"), context);
  if (withApp) vm.runInContext(source("app.js"), context);
  return { context, requests, storage, element, evaluate: code => vm.runInContext(code, context) };
}

for (const provider of ["anthropic", "openai", "gemini", "openrouter", "custom"]) {
  test(`${provider}: all five AI features route exclusively through the selected key and model`, async () => {
    const h = harness();
    const info = h.context.aiProviders[provider];
    const settings = {
      ai_provider: provider, [info.keyField]: `${provider}-test-key`, [info.modelField]: "text-model-new",
      custom_ai_base_url: "https://models.example.test/api/v1/",
      rapidapi: "never-send-job-key", usajobs_key: "never-send-usajobs", anthropic: "never-fallback",
    };
    settings[info.keyField] = `${provider}-test-key`;
    h.context.getAiSettings = () => settings;
    let text = "OK";
    let calls = 0;
    h.context.bumpUsage = kind => { assert.equal(kind, "ai_calls"); calls++; };
    h.context.fetch = async (url, options) => {
      h.requests.push({ url, ...options });
      return response(generated(provider, text));
    };
    text = JSON.stringify(score);
    assert.equal((await h.context.aiScoreAts("JavaScript engineer", "JavaScript required")).score, 82);
    text = "SUMMARY\nEngineer\nEXPERIENCE\nBuilt software";
    assert.ok((await h.context.aiTailorResume("Engineer", "Software role", "Engineer", "Example")).tailored);
    text = "ANSWER: This role fits your experience.";
    assert.equal((await h.context.aiApplyChatInstruction({
      instruction: "Does this fit?", resume_text: "Engineer", description: "Software role", version: 1,
    })).resume_changed, false);
    text = "Built reliable software.";
    assert.equal((await h.context.aiImproveLine("Built software", "Software role", "Engineer")).improved, text);
    assert.equal((await h.context.aiGenerateResume("Software engineer", "Engineer", "Software role")).resume, text);
    assert.equal(calls, 5);
    for (const request of h.requests) {
      const body = JSON.parse(request.body);
      assert.ok(request.url.startsWith(provider === "custom" ? "https://models.example.test/api/v1/" : info.baseUrl + "/"));
      assert.equal(request.redirect, "error");
      assert.equal(request.credentials, "omit");
      const serialized = JSON.stringify(request);
      assert.ok(!serialized.includes("never-send"));
      assert.ok(!serialized.includes("never-fallback"));
      assert.ok(!request.url.includes("test-key"));
      if (provider === "anthropic") {
        assert.equal(request.headers["x-api-key"], settings[info.keyField]);
        assert.equal(request.headers["anthropic-dangerous-direct-browser-access"], "true");
        assert.equal(body.model, "text-model-new");
      } else if (provider === "gemini") {
        assert.equal(request.headers["x-goog-api-key"], settings[info.keyField]);
        assert.ok(request.url.endsWith("/models/text-model-new:generateContent"));
        assert.ok(body.contents[0].parts[0].text);
      } else {
        assert.equal(request.headers.Authorization, `Bearer ${settings[info.keyField]}`);
        assert.equal(body.model, "text-model-new");
        assert.ok(body[provider === "openai" ? "max_completion_tokens" : "max_tokens"]);
      }
    }
  });
}

test("legacy Anthropic vault keeps its explicit model or legacy default", () => {
  const { context } = harness();
  assert.equal(context.aiConfigFromSettings({ anthropic: "key" }).model, "claude-sonnet-4-5");
  assert.equal(context.aiConfigFromSettings({ anthropic: "key", claude_model: "legacy-custom" }).model, "legacy-custom");
  assert.equal(context.aiConfigFromSettings({ ai_provider: "openai", openai_key: "key" }).model, "");
  assert.equal(context.aiConfigFromSettings({}).model, "");
});

test("missing selected key never falls back to a saved Anthropic key", async () => {
  const h = harness({ ai_provider: "openai", anthropic: "must-not-send", openai_model: "model" });
  await assert.rejects(h.context.aiImproveLine("text", "", ""), /ai_unavailable_no_key/);
  assert.equal(h.requests.length, 0);
});

test("custom endpoint validation prevents insecure URLs, credentials, fragments and queries", () => {
  const { context } = harness();
  const config = { provider: "custom", key: "key", model: "new-model" };
  for (const baseUrl of ["http://example.test/v1", "https://user:pass@example.test", "https://example.test?key=value", "https://example.test/#fragment", "not a URL"]) {
    assert.throws(() => context.aiValidateConfig({ ...config, baseUrl }), /HTTPS/);
  }
  assert.equal(context.aiValidateConfig({ ...config, baseUrl: "https://example.test/v1/" }), "https://example.test/v1");
  assert.throws(() => context.aiValidateConfig({ ...config, baseUrl: "https://example.test/v1/chat/completions" }), /base URL/);
  assert.throws(() => context.aiConfigFromSettings({ ai_provider: "toString" }), /Unknown/);
});

test("Anthropic model discovery paginates and Gemini uses method metadata and page tokens", async () => {
  for (const provider of ["anthropic", "gemini"]) {
    const h = harness();
    h.context.fetch = async (url, options) => {
      h.requests.push({ url, ...options });
      if (provider === "anthropic") return response(h.requests.length === 1
        ? { data: [{ id: "model-new", display_name: "New Model" }], has_more: true, last_id: "model-new" }
        : { data: [{ id: "model-private" }], has_more: false });
      return response(h.requests.length === 1
        ? { models: [
          { name: "models/gemini-new", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-tts", supportedGenerationMethods: ["generateContent"] },
        ], nextPageToken: "next page" }
        : { models: [{ name: "models/gemini-private", supportedGenerationMethods: ["generateContent"] }] });
    };
    const models = await h.context.aiListModels({ provider, key: "test-key", model: "" });
    assert.equal(models.length, 2);
    assert.equal(h.requests.length, 2);
    assert.ok(!h.requests[0].url.includes("test-key"));
    assert.ok(h.requests[1].url.includes(provider === "anthropic" ? "after_id=model-new" : "pageToken=next+page"));
  }
});

test("OpenRouter catalog filters non-text output and OpenAI filters known non-chat models", async () => {
  const h = harness();
  h.context.fetch = async () => response({ data: [
    { id: "vendor/new-model", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    { id: "vendor/image-only", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
  ] });
  assert.equal((await h.context.aiListModels({ provider: "openrouter", key: "key" })).length, 1);
  h.context.fetch = async () => response({ data: [{ id: "gpt-new" }, { id: "whisper-1" }, { id: "text-embedding-new" }, { id: "gpt-image-new" }] });
  const models = await h.context.aiListModels({ provider: "openai", key: "key" });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "gpt-new");
});

test("discovery fails explicitly on repeated pagination or an invalid catalog", async () => {
  const h = harness();
  h.context.fetch = async () => response({ data: [], has_more: true, last_id: "same" });
  await assert.rejects(h.context.aiListModels({ provider: "anthropic", key: "key" }), /repeated/);
  h.context.fetch = async () => response({ unsupported: true });
  await assert.rejects(h.context.aiListModels({ provider: "custom", key: "key", baseUrl: "https://example.test/v1" }), /catalog/);
});

test("provider failures never return a fake score or unchanged resume as success", async () => {
  const h = harness({ ai_provider: "openai", openai_key: "key", openai_model: "model" });
  h.context.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "secret-key-and-resume" } }) });
  for (const operation of [
    () => h.context.aiScoreAts("resume", "job"),
    () => h.context.aiTailorResume("resume", "job", "title", "company"),
    () => h.context.aiImproveLine("line", "job", "title"),
    () => h.context.aiGenerateResume("description", "title", "job"),
    () => h.context.aiApplyChatInstruction({ instruction: "edit", resume_text: "resume" }),
  ]) await assert.rejects(operation(), error => /HTTP 401/.test(error.message) && !error.message.includes("secret"));
});

test("empty, refused, truncated and malformed ATS outputs fail explicitly", async () => {
  const h = harness({ ai_provider: "openai", openai_key: "key", openai_model: "model" });
  for (const data of [
    { choices: [{ message: { content: "" }, finish_reason: "stop" }] },
    { choices: [{ message: { content: "partial" }, finish_reason: "length" }] },
    { choices: [{ message: { refusal: "No" }, finish_reason: "stop" }] },
    generated("openai", '{"score":120}'),
    generated("openai", "{ not valid JSON }"),
    generated("openai", "null"),
  ]) {
    h.context.fetch = async () => response(data);
    await assert.rejects(h.context.aiScoreAts("resume", "job"));
  }
});

test("system prompts and assistant history map correctly for Gemini", async () => {
  const h = harness({ ai_provider: "gemini", gemini_key: "key", gemini_model: "gemini-new" });
  let body;
  h.context.fetch = async (_, options) => {
    body = JSON.parse(options.body);
    return response(generated("gemini", "ANSWER: Fits."));
  };
  await h.context.aiApplyChatInstruction({
    instruction: "Follow up", resume_text: "Engineer", version: 1,
    chat_history: [{ role: "user", text: "Question" }, { role: "ai", text: "Answer" }],
  });
  assert.ok(body.systemInstruction.parts[0].text.includes("JobsPilot"));
  assert.ok(body.contents.some(m => m.role === "model"));
});

test("Settings preserves provider drafts, job keys, encrypted persistence and cancel behavior", async () => {
  const h = harness({}, true);
  h.storage.setItem("jp_email", "test@example.test");
  await h.context.byokInit();
  h.context._byokFormWrite({ anthropic: "old-key", rapidapi: "job-key", cf_worker_url: "https://worker.example.test" });
  assert.equal(h.element("byok-ai-model").value, "claude-sonnet-4-5");
  h.element("byok-ai-provider").value = "openai";
  h.context.byokChangeAiProvider();
  h.element("byok-ai-key").value = "new-openai-key";
  h.element("byok-ai-model").value = "new-openai-model";
  h.element("byok-ai-provider").value = "custom";
  h.context.byokChangeAiProvider();
  h.element("byok-ai-key").value = "custom-key";
  h.element("byok-ai-model").value = "private-model";
  h.element("byok-ai-base-url").value = "https://models.example.test/v1";
  const form = h.context._byokFormRead();
  assert.equal(form.anthropic, "old-key");
  assert.equal(form.openai_key, "new-openai-key");
  assert.equal(form.openai_model, "new-openai-model");
  assert.equal(form.custom_ai_model, "private-model");
  assert.equal(form.rapidapi, "job-key");
  await h.context.byokSave(form);
  const encrypted = h.storage.getItem("jp_byok_v1");
  assert.ok(!encrypted.includes("custom-key") && !encrypted.includes("old-key"));
  const restored = await h.context._byokDecrypt(encrypted, "test@example.test");
  assert.equal(restored.openai_key, "new-openai-key");
  assert.equal(restored.custom_ai_base_url, "https://models.example.test/v1");
  h.element("byok-ai-key").value = "unsaved-change";
  h.context.closeSettingsModal();
  assert.equal(h.context.getAiSettings().custom_ai_key, "custom-key");
  assert.equal(h.element("byok-ai-key").value, "");
});

test("AI usage migration preserves old counts and does not overwrite an existing total", () => {
  const h = harness({}, true);
  h.storage.setItem("jp_usage_v1", JSON.stringify({ claude_calls: 12, total_searches: 3 }));
  assert.equal(h.context.readUsage().ai_calls, 12);
  h.context.bumpUsage("ai_calls");
  assert.equal(h.context.readUsage().ai_calls, 13);
  assert.equal(h.context.readUsage().total_searches, 3);
  assert.equal(h.context.readUsage().claude_calls, undefined);
  h.storage.setItem("jp_usage_v1", JSON.stringify({ claude_calls: 12, ai_calls: 20 }));
  assert.equal(h.context.readUsage().ai_calls, 20);
});

test("model labels are escaped and stale catalog responses cannot replace a new provider's choices", async () => {
  const h = harness({}, true);
  h.context._byokFormWrite({ ai_provider: "openai", openai_key: "key", openai_model: "saved-model" });
  h.context._byokSetModelOptions([{ id: 'bad"><img>', name: "<script>test</script>" }], "saved-model");
  assert.ok(!h.element("byok-ai-model-list").innerHTML.includes("<script>"));
  let resolve;
  h.context.aiListModels = () => new Promise(done => { resolve = done; });
  const pending = h.context.byokRefreshModels();
  h.element("byok-ai-provider").value = "gemini";
  h.context.byokChangeAiProvider();
  resolve([{ id: "old-provider-model", name: "Old" }]);
  await pending;
  assert.ok(!h.element("byok-ai-model-list").innerHTML.includes("old-provider-model"));
  assert.equal(h.element("byok-model-refresh").disabled, false);
});

test("provider selection synchronizes labels, placeholders, help links and isolated model drafts", () => {
  const h = harness({}, true);
  h.context._byokFormWrite({});
  for (const [provider, info] of Object.entries(h.context.aiProviders)) {
    h.element("byok-ai-provider").value = provider;
    h.context.byokChangeAiProvider(provider);
    assert.equal(h.element("byok-ai-key-label").textContent, `${info.label} API key`);
    assert.equal(h.element("byok-ai-key").placeholder, `Paste your ${info.label} API key`);
    assert.equal(h.element("byok-ai-model-list-label").textContent, `${info.label} models`);
    assert.equal(h.element("byok-ai-model").placeholder, `Enter an exact ${info.label} model ID`);
    assert.equal(h.element("byok-ai-help").hidden, !info.helpUrl);
    if (info.helpUrl) assert.equal(h.element("byok-ai-help").href, info.helpUrl);
    assert.equal(h.element("byok-custom-endpoint").hidden, provider !== "custom");
    assert.equal(h.element("byok-ai-key").value, "");
    assert.equal(h.element("byok-ai-model").value, "");
    h.element("byok-ai-key").value = `fake-${provider}-key`;
    h.element("byok-ai-model").value = `${provider}-model`;
    // Native select controls may emit both input and change for one selection.
    h.context.byokChangeAiProvider(provider);
    assert.equal(h.element("byok-ai-key").value, `fake-${provider}-key`);
    assert.equal(h.element("byok-ai-model").value, `${provider}-model`);
  }
  const saved = h.context._byokFormRead();
  saved.ai_provider = "gemini";
  h.context._byokFormWrite(saved);
  assert.equal(h.element("byok-ai-key-label").textContent, "Google Gemini API key");
  assert.equal(h.element("byok-ai-key").value, "fake-gemini-key");
  assert.equal(h.element("byok-ai-model").value, "gemini-model");
  assert.equal(h.element("byok-ai-help").href, "https://aistudio.google.com/apikey");
});

test("provider control updates on input as well as committed change and starts with neutral copy", () => {
  const template = fs.readFileSync(path.join(root, "jobpilot", "templates", "index.html"), "utf8");
  const select = template.match(/<select\b[^>]*id="byok-ai-provider"[^>]*>/)[0];
  assert.match(select, /oninput="byokChangeAiProvider\(this.value\)"/);
  assert.match(select, /onchange="byokChangeAiProvider\(this.value\)"/);
  assert.ok(!template.includes('for="byok-ai-key">Anthropic API key'));
});

test("app modal and action styles use real theme tokens rather than light-only fallbacks", () => {
  const template = fs.readFileSync(path.join(root, "jobpilot", "templates", "index.html"), "utf8");
  assert.doesNotMatch(template, /var\(--(?:text1|bg1|border1)\b/);
});

test("JobsPilot rebrand is present in source templates and metadata", () => {
  for (const file of ["base.html", "index.html", "landing.html"]) {
    const text = fs.readFileSync(path.join(root, "jobpilot", "templates", file), "utf8");
    assert.ok(text.includes("JobsPilot"));
    assert.ok(!text.includes("JobPilot"));
  }
});

test("landing offers actionable guides and the requested developer and contribution links", () => {
  const template = fs.readFileSync(path.join(root, "jobpilot", "templates", "landing.html"), "utf8");
  for (const id of ["how-it-works", "setup", "career-guides", "developers"]) {
    assert.ok(template.includes(`id="${id}"`), `Missing landing section ${id}`);
  }
  for (const id of ["guide-resume", "guide-routine", "guide-interview", "guide-networking"]) {
    assert.match(template, new RegExp(`<details\\b[^>]*id="${id}"`));
  }
  for (const url of [
    "https://www.linkedin.com/in/rajesh-kodaganti-323118215/",
    "https://www.linkedin.com/in/tarun-sailesh-vangipurapu-2b1892271/",
    "https://github.com/vangipuraputarunsailesh/jobpilot",
    "https://github.com/vangipuraputarunsailesh/jobpilot/issues/new/choose",
  ]) assert.ok(template.includes(`href="${url}"`), `Missing link ${url}`);
  assert.ok(template.includes("Rajesh Kodaganti"));
  assert.ok(template.includes("Tarun Sailesh Vangipurapu"));
  assert.doesNotMatch(template, /passphrase-protected|explore sample data|callback rate|5-min setup/i);
});

const fixedResumes = [
  { id: "r1", name: "Engineering", text: "Engineer. Built services." },
  { id: "r2", name: "Analysis", text: "Analyst. Used SQL." },
  { id: "r3", name: "Operations", text: "Operations. Supported customers." },
];
const supportedJob = {
  url: "https://jobs.lever.co/example/12345678-1234-1234-1234-123456789012",
  title: "Engineer", company: "Example", description: "Build reliable services.",
};

test("agent planner uses selected provider, returns only a fixed resume ID and never rewrites it", async () => {
  const h = harness({ ai_provider: "gemini", gemini_key: "fake-key", gemini_model: "gemini-test" });
  const before = JSON.stringify(fixedResumes);
  h.context.fetch = async (url, options) => {
    h.requests.push({ url, ...options });
    return response(generated("gemini", JSON.stringify({
      resumeId: "r1", reason: "Relevant systems experience.", gaps: ["Scale not demonstrated"],
      rewrittenResume: "Must never be used", firstName: "Invented",
    })));
  };
  const result = await h.context.aiChooseFixedResume(fixedResumes, supportedJob);
  assert.equal(result.resumeId, "r1");
  assert.equal(result.rewrittenResume, undefined);
  assert.equal(result.firstName, undefined);
  assert.equal(JSON.stringify(fixedResumes), before);
  const body = JSON.parse(h.requests[0].body);
  assert.match(body.systemInstruction.parts[0].text, /untrusted data/);
  assert.equal(JSON.parse(body.contents[0].parts[0].text).resumes.length, 3);
  assert.ok(h.requests[0].url.includes("generativelanguage.googleapis.com"));
});

test("agent planner rejects missing/duplicate/oversized resumes and invented model selections", async () => {
  const h = harness({ anthropic: "fake-key" });
  for (const input of [fixedResumes.slice(0, 2), [fixedResumes[0], fixedResumes[0], fixedResumes[2]],
    fixedResumes.map((r, i) => i === 0 ? { ...r, text: "x".repeat(12001) } : r)]) {
    await assert.rejects(h.context.aiChooseFixedResume(input, supportedJob), /three/);
  }
  assert.equal(h.requests.length, 0);
  for (const output of [
    { resumeId: "invented", reason: "Guess", gaps: [] },
    { resumeId: "r1", reason: "", gaps: [] },
    { resumeId: "r1", reason: "Fit", gaps: ["x".repeat(501)] },
    { resumeId: "r1", reason: "Fit", gaps: "None" },
  ]) {
    h.context.fetch = async () => response(generated("anthropic", JSON.stringify(output)));
    await assert.rejects(h.context.aiChooseFixedResume(fixedResumes, supportedJob), /invalid resume selection/);
  }
});

test("agent bundle contains only chosen PDF/contact data, never model keys or other resumes", () => {
  const h = harness({}, true);
  h.context.resumePdfBase64 = text => { assert.equal(text, fixedResumes[1].text); return "JVBERi0xLjc="; };
  const plan = {
    job: supportedJob, candidate: { firstName: "Test", lastName: "Person", email: "test@example.test",
      phone: "", linkedin: "", website: "" },
    resume: fixedResumes[1], selection: { reason: "SQL fit", gaps: [] },
  };
  const bundle = h.context.buildAgentBundle(plan);
  assert.deepEqual(Object.keys(bundle).sort(), ["candidate", "createdAt", "job", "resume", "selection", "version"]);
  assert.equal(bundle.resume.id, "r2");
  assert.equal(bundle.resume.mimeType, "application/pdf");
  assert.ok(bundle.resume.name.endsWith(".pdf"));
  assert.equal(bundle.job.description, undefined);
  assert.ok(!JSON.stringify(bundle).includes(fixedResumes[0].text));
  assert.equal(bundle.resume.text, undefined);
});

test("site-generated bundle is accepted unchanged by the companion validator", () => {
  const companion = require(path.join(root, "companion", "core.js"));
  const h = harness({}, true);
  h.context.resumePdfBase64 = () => Buffer.from("%PDF-1.7\n%offline test fixture\n%%EOF").toString("base64");
  const plan = {
    job: { ...supportedJob, url: "https://boards.greenhouse.io/example/jobs/12345?source=test" },
    candidate: { firstName: "Test", lastName: "Person", email: "test@example.test", phone: "+1 555 010 0200",
      linkedin: "https://www.linkedin.com/in/test-person/", website: "https://example.test" },
    resume: fixedResumes[0], selection: { reason: "Relevant experience", gaps: ["Review eligibility"] },
  };
  const bundle = JSON.parse(JSON.stringify(h.context.buildAgentBundle(plan)));
  const validated = companion.validateBundle(bundle);
  assert.equal(validated.job.url, "https://job-boards.greenhouse.io/example/jobs/12345");
  assert.equal(validated.resume.id, "r1");
  assert.equal(validated.resume.base64, bundle.resume.base64);
});
test("agent URL validation rejects arbitrary origins, credentials and listing pages", () => {
  const h = harness({}, true);
  assert.equal(h.context.canonicalAgentJobUrl(supportedJob.url + "/apply?source=tracking#x"), supportedJob.url);
  assert.equal(h.context.canonicalAgentJobUrl("https://job-boards.greenhouse.io/example/jobs/123?source=x"),
    "https://job-boards.greenhouse.io/example/jobs/123");
  for (const url of ["javascript:alert(1)", "http://jobs.lever.co/example/a",
    "https://jobs.lever.co.evil.test/example/x", "https://user:pass@jobs.lever.co/example/x",
    "https://jobs.lever.co/example", "https://example.test/jobs/123",
    "https://boards.greenhouse.io/example/jobs/123/extra"]) {
    assert.throws(() => h.context.canonicalAgentJobUrl(url));
  }
});

test("activating resumes freezes exactly three texts and persists IDs only", async () => {
  const h = harness({}, true);
  h.storage.setItem("jp_email", "test@example.test");
  h.context.listResumesFromDrive = async () => fixedResumes;
  h.context.getResumeFromDrive = async id => fixedResumes.find(r => r.id === id).text;
  await h.context.loadAgentResumes();
  for (let i = 0; i < 3; i++) h.element("agent-resume-" + i).value = fixedResumes[i].id;
  await h.context.activateAgentResumes();
  assert.equal(h.evaluate("_agentResumes.length"), 3);
  assert.equal(h.evaluate("Object.isFrozen(_agentResumes[0])"), true);
  const persisted = h.storage.getItem("jp_agent_resumes_v1:test@example.test");
  assert.equal(persisted, '["r1","r2","r3"]');
  h.context.invalidateAgentResumes();
  assert.equal(h.evaluate("_agentResumes.length"), 0);
  assert.equal(h.element("agent-result").hidden, true);
});

test("changing application input discards a late model response", async () => {
  const h = harness({}, true);
  h.evaluate(`_byokLoaded=true; _byokReady=Promise.resolve(); _byokPlain={anthropic:"fake"};`);
  h.evaluate(`_agentResumes=${JSON.stringify(fixedResumes)};`);
  for (const [id, value] of Object.entries({
    "first-name": "Test", "last-name": "Person", email: "test@example.test",
    "job-url": supportedJob.url, "job-title": "Engineer", "job-company": "Example",
    "job-description": supportedJob.description,
  })) h.element("agent-" + id).value = value;
  h.element("agent-share-consent").checked = true;
  let resolve;
  h.context.aiChooseFixedResume = () => new Promise(done => { resolve = done; });
  const pending = h.context.prepareAgentApplication();
  await new Promise(done => setImmediate(done));
  h.context.invalidateAgentPlan();
  resolve({ resumeId: "r1", reason: "Fit", gaps: [] });
  await pending;
  assert.equal(h.evaluate("_agentPlan"), null);
  assert.equal(h.evaluate("_agentPrepared.length"), 0);
});

test("sorted job card selects the displayed job rather than an unrelated source index", () => {
  const h = harness({}, true);
  const jobs = [
    { id: "a", title: "Engineer", company: "Zulu", location: "US", source: "Test", posted: "Today", salary: "$100" },
    { id: "b", title: "Engineer", company: "Alpha", location: "US", source: "Test", posted: "Today", salary: "$200" },
  ];
  h.evaluate(`allJobs=${JSON.stringify(jobs)};`);
  h.context.renderJobList(jobs);
  h.context.sortJobs("company", { classList: { add() {} } });
  h.context.renderRightPanel = () => {};
  h.context.openJob(0);
  assert.equal(h.evaluate("selectedJob.id"), "b");
  h.context.sortJobs("newest", { classList: { add() {} } });
  h.context.openJob(0);
  assert.equal(h.evaluate("selectedJob.id"), "a");
});

test("search failure exits spinner and stale searches cannot overwrite a newer result", async () => {
  const h = harness({}, true);
  h.evaluate('_byokLoaded=true; _byokReady=Promise.resolve(); _byokPlain={cf_worker_url:"https://worker.example.test"};');
  h.element("job-title-input").value = "Engineer";
  h.context.showToast = () => {};
  const pending = [];
  h.context.searchJobsViaWorker = opts => new Promise((resolve, reject) => pending.push({ opts, resolve, reject }));
  const first = h.context.searchJobs();
  await new Promise(done => setImmediate(done));
  const second = h.context.searchJobs();
  await new Promise(done => setImmediate(done));
  assert.equal(pending[0].opts.signal.aborted, true);
  pending[1].resolve({ jobs: [{ id: "new", title: "Engineer", company: "New" }], sources: ["Test"] });
  await second;
  pending[0].resolve({ jobs: [{ id: "old", title: "Engineer", company: "Old" }], sources: ["Test"] });
  await first;
  assert.equal(h.evaluate("allJobs[0].id"), "new");
  h.context.searchJobsViaWorker = async () => { throw new Error("Provider unavailable"); };
  await h.context.searchJobs();
  assert.match(h.element("job-list").innerHTML, /Search could not complete/);
  assert.doesNotMatch(h.element("job-list").innerHTML, /search-spinner/);
  assert.equal(h.element("search-btn-text").textContent, "Find jobs now");
});

test("site-wide theme persists choices and responds to system and cross-tab changes", () => {
  const callbacks = {};
  const media = { matches: true, addEventListener: (name, fn) => { callbacks.media = fn; } };
  const attributes = {};
  const values = new Map();
  const selects = [0, 1].map(() => ({ value: "", addEventListener(name, fn) { this.change = fn; } }));
  const context = vm.createContext({
    console, matchMedia: () => media,
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    document: {
      documentElement: { dataset: {}, style: {}, setAttribute: (key, value) => { attributes[key] = value; } },
      body: { setAttribute() {} },
      readyState: "complete",
      querySelectorAll: () => selects,
      addEventListener: (name, fn) => { callbacks[name] = fn; },
    },
    addEventListener: (name, fn) => { callbacks[name] = fn; },
  });

  test("local active resume uses memory without duplicating the capped persistent library", () => {
    const h = harness({}, true);
    h.context.getActiveResumeId = () => "local_test";
    h.storage.setItem("jp_resume_text", "stale duplicate");
    h.storage.setItem("jp_resume_name", "stale");
    h.context.setStoredResume("local resume body", "Browser resume");
    assert.equal(h.context.getStoredResume().text, "local resume body");
    assert.equal(h.storage.getItem("jp_resume_text"), null);
    assert.equal(h.storage.getItem("jp_resume_name"), null);
    h.context.clearStoredResume();
    assert.equal(h.context.getStoredResume(), null);
  });

  test("resume storage status is shown consistently in library, welcome and agent surfaces", () => {
    const h = harness({}, true);
    h.context.getResumeStorageStatus = () => ({
      mode: "local", message: "Browser-only; not synced.", usedBytes: 5432, limitBytes: 1000000,
    });

    test("Google token renewal resolves every request and coalesces concurrent library access", async () => {
      const h = harness({}, true);
      h.context.JOBSPILOT_GOOGLE_CLIENT_ID = "fixture.apps.googleusercontent.com";
      let requests = 0;
      h.context.google = { accounts: { oauth2: { initTokenClient(config) {
        return { requestAccessToken() {
          requests++;
          queueMicrotask(() => config.callback({ access_token: "fake-token-" + requests, expires_in: 3600 }));
        } };
      } } } };
      const first = await Promise.all([h.context.getGoogleToken(), h.context.getGoogleToken()]);
      assert.equal(requests, 1);
      assert.equal(first[0], first[1]);
      h.storage.setItem("jp_gtoken_expiry", "0");
      const second = await h.context.getGoogleToken();
      assert.equal(requests, 2);
      assert.equal(second, "fake-token-2");
      const template = fs.readFileSync(path.join(root, "jobpilot", "templates", "index.html"), "utf8");
      assert.ok(template.includes('<meta name="google-client-id" content="{{ google_client_id }}"/>'));
    });
    h.context.renderResumeStorageStatus();
    for (const id of ["library-storage-status", "welcome-storage-status", "agent-storage-status"]) {
      assert.match(h.element(id).textContent, /Browser-only; not synced/);
      assert.match(h.element(id).textContent, /5\.4 \/ 1000 KB/);
    }
  });
  context.window = context;
  vm.runInContext(source("theme.js"), context);
  const theme = context.JobsPilotTheme;
  theme.initControls();
  assert.equal(theme.preference(), "system");
  assert.equal(attributes["data-theme"], "dark");
  theme.apply("light", true);
  assert.equal(values.get("jobpilot-theme"), "light");
  assert.equal(attributes["data-theme"], "light");
  assert.ok(selects.every(select => select.value === "light"));
  theme.apply("dark-pro", true);
  assert.equal(attributes["data-theme"], "dark");
  theme.apply("system", true);
  media.matches = false;
  callbacks.media({ matches: false });
  assert.equal(attributes["data-theme"], "light");
  values.set("jobpilot-theme", "dark");
  callbacks.storage({ key: "jobpilot-theme", newValue: "dark" });
  assert.equal(attributes["data-theme"], "dark");
});
