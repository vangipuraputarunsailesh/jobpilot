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
      disabled: false, style: {}, classList: { add() {}, remove() {} },
      removeAttribute(name) { delete this[name]; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    URL, AbortController, AbortSignal, TextEncoder, TextDecoder, crypto: webcrypto, btoa, atob,
    setTimeout, clearTimeout, console: { warn() {}, error() {} },
    localStorage: storage, sessionStorage: { ...storage },
    document: { addEventListener() {}, getElementById: element, querySelectorAll: () => [], body: { style: {} } },
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

test("JobsPilot rebrand is present in source templates and metadata", () => {
  for (const file of ["base.html", "index.html", "landing.html"]) {
    const text = fs.readFileSync(path.join(root, "jobpilot", "templates", file), "utf8");
    assert.ok(text.includes("JobsPilot"));
    assert.ok(!text.includes("JobPilot"));
  }
});
