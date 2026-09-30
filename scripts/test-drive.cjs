const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "jobpilot", "static", "js", "drive.js"), "utf8");
const LIMIT = 1000000;
const key = email => "jp_resume_library_v1:" + encodeURIComponent(email.toLowerCase());
const timestamp = "2026-09-30T12:00:00.000Z";
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");

function harness(data = new Map([["jp_email", "alice@example.com"]]), options = {}) {
  const calls = [];
  const warnings = [];
  const events = [];
  let sequence = options.sequence || 0;
  const controls = {
    available: false,
    writeError: null,
    removeError: null,
    fetchError: null,
    response: null,
    tokenCalls: 0,
  };
  const localStorage = {
    getItem: name => data.has(name) ? data.get(name) : null,
    setItem(name, value) {
      if (controls.writeError) throw controls.writeError;
      data.set(name, String(value));
    },
    removeItem(name) {
      if (controls.removeError) throw controls.removeError;
      return data.delete(name);
    },
  };
  const context = vm.createContext({
    localStorage,
    TextEncoder,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [timestamp])); } },
    crypto: { randomUUID: () => "uuid-" + (++sequence) },
    console: { warn: text => warnings.push(text) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    async getGoogleToken() {
      controls.tokenCalls++;
      if (!controls.available) throw new Error("GOOGLE_CLIENT_ID not configured");
      return "token-for-tests";
    },
    async fetch(url, opts) {
      calls.push({ url, opts });
      if (controls.fetchError) throw controls.fetchError;
      if (controls.response) return controls.response;
      return {
        ok: true,
        status: 200,
        async json() {
          const remote = { id: "drive-id", name: "Remote", createdTime: timestamp, size: "7", appProperties: { source: "upload" } };
          return opts.method === "POST" ? remote : { files: [remote] };
        },
        async text() { return "remote content"; },
      };
    },
  });
  context.window = context;
  context.dispatchEvent = event => events.push(event);
  vm.runInContext(source, context);
  return { api: context, controls, data, calls, warnings, events };
}

test("missing client uses persistent, account-scoped local storage and reads without OAuth", async () => {
  const h = harness();
  assert.equal((await h.api.listResumesFromDrive()).length, 0);
  const saved = await h.api.saveResumeToDrive("My resume", "private résumé 😀", "upload");
  assert.equal(saved.storage, "local");
  assert.match(saved.id, /^local_/);
  assert.equal(h.calls.length, 0);
  h.api.setActiveResumeId(saved.id);
  const reload = harness(h.data);
  const tokenCalls = reload.controls.tokenCalls;
  assert.equal(await reload.api.getResumeFromDrive(saved.id), "private résumé 😀");
  assert.equal(reload.controls.tokenCalls, tokenCalls);
  assert.equal(reload.api.getActiveResumeId(), saved.id);
  const listed = await reload.api.listResumesFromDrive();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].is_active, true);
  const status = reload.api.getResumeStorageStatus();
  assert.equal(status.mode, "local");
  assert.equal(status.limitBytes, LIMIT);
  assert.equal(status.usedBytes, Buffer.byteLength(h.data.get(key("alice@example.com")), "utf8"));
  assert.match(status.message, /1000 KB \(1,000,000 UTF-8 bytes/);
  assert.match(status.message, /not synced/);
  assert.ok(reload.events.some(event => event.type === "jobspilot:resume-storage"));
  assert.ok(h.warnings.every(warning => !warning.includes("private") && !warning.includes("token-for-tests")));
});

test("exact aggregate UTF-8 byte boundary accepts at cap and rejects overflow unchanged", async () => {
  const h = harness();
  const first = await h.api.saveResumeToDrive("Existing", "keep me", "upload");
  const library = JSON.parse(h.data.get(key("alice@example.com")));
  const candidate = {
    id: "local_uuid-2", name: "Unicode 😀", source: "upload",
    content: "é😀".repeat(5000), createdTime: timestamp, size: 15000,
  };
  let padding = LIMIT - bytes([...library, candidate]);
  candidate.content += "x".repeat(padding);
  candidate.size = candidate.content.length;
  padding = LIMIT - bytes([...library, candidate]);
  candidate.content = candidate.content.slice(0, candidate.content.length + padding);
  candidate.size = candidate.content.length;
  assert.equal(bytes([...library, candidate]), LIMIT);
  await h.api.saveResumeToDrive(candidate.name, candidate.content, candidate.source);
  assert.equal(h.api.getResumeStorageStatus().usedBytes, LIMIT);
  const before = h.data.get(key("alice@example.com"));
  await assert.rejects(h.api.saveResumeToDrive("Overflow", "é", "upload"), /1000 KB/);
  assert.equal(h.data.get(key("alice@example.com")), before);
  assert.equal(await h.api.getResumeFromDrive(first.id), "keep me");
  h.api.setActiveResumeId(first.id);
  const tokens = h.controls.tokenCalls;
  await h.api.deleteResumeFromDrive(first.id);
  assert.equal(h.controls.tokenCalls, tokens);
  assert.equal(h.api.getActiveResumeId(), "");
  assert.ok(h.api.getResumeStorageStatus().usedBytes < LIMIT);
});

test("a single oversized resume is rejected without creating a library", async () => {
  const h = harness();
  await assert.rejects(h.api.saveResumeToDrive("Too large", "😀".repeat(250000)), /1000 KB/);
  assert.equal(h.data.has(key("alice@example.com")), false);
});

test("no legacy 20-item eviction, including demo users", async () => {
  for (const demo of [false, true]) {
    const h = harness();
    if (demo) h.data.set("jp_demo", "1");
    const first = await h.api.saveResumeToDrive("First", "retained");
    for (let i = 0; i < 21; i++) await h.api.saveResumeToDrive("Resume " + i, "content");
    assert.equal((await h.api.listResumesFromDrive()).length, 22);
    assert.equal(await h.api.getResumeFromDrive(first.id), "retained");
  }
});

test("accounts, demo content, and active pointers remain isolated", async () => {
  const h = harness();
  const alice = await h.api.saveResumeToDrive("Alice", "alice-private");
  h.api.setActiveResumeId(alice.id);
  h.data.set("jp_email", "bob@example.com");
  assert.equal((await h.api.listResumesFromDrive()).length, 0);
  assert.equal(h.api.getActiveResumeId(), "");
  await assert.rejects(h.api.getResumeFromDrive(alice.id), /not found/);
  const bob = await h.api.saveResumeToDrive("Bob", "bob-private");
  h.api.setActiveResumeId(bob.id);
  h.data.set("jp_demo", "1");
  assert.equal((await h.api.listResumesFromDrive()).length, 0);
  h.data.delete("jp_demo");
  h.data.set("jp_email", "ALICE@example.com");
  assert.equal((await h.api.listResumesFromDrive()).length, 1);
  assert.equal(h.api.getActiveResumeId(), alice.id);
});

test("browser quota and blocked writes surface actionable errors without changing data", async () => {
  const h = harness();
  await h.api.saveResumeToDrive("Existing", "retained");
  const before = h.data.get(key("alice@example.com"));
  for (const name of ["QuotaExceededError", "SecurityError"]) {
    h.controls.writeError = Object.assign(new Error("sensitive failure detail"), { name });
    await assert.rejects(h.api.saveResumeToDrive("New", "not saved"), error => {
      assert.match(error.message, /not saved locally/);
      if (name === "QuotaExceededError") assert.equal(error.name, name);
      assert.ok(!error.message.includes("sensitive"));
      return true;
    });
    assert.equal(h.data.get(key("alice@example.com")), before);
  }
});

test("Drive recovery merges local entries without uploading them, preserving Drive operations", async () => {
  const h = harness();
  const local = await h.api.saveResumeToDrive("Local", "local-only");
  h.controls.available = true;
  const items = await h.api.listResumesFromDrive();
  assert.equal(items.length, 2);
  assert.equal(items.find(item => item.id === local.id).storage, "local");
  assert.equal(items.find(item => item.id === "drive-id").storage, "drive");
  assert.equal(h.api.getResumeStorageStatus().mode, "mixed");
  assert.ok(h.calls.every(call => call.opts.method === "GET"));
  assert.equal(await h.api.getResumeFromDrive(local.id), "local-only");
  const remote = await h.api.saveResumeToDrive("Remote", "remote-only");
  assert.equal(remote.id, "drive-id");
  assert.equal(remote.storage, "drive");
  assert.equal(h.calls.filter(call => call.opts.method === "POST").length, 1);
  assert.ok(!h.calls.find(call => call.opts.method === "POST").opts.body.includes("local-only"));
  assert.equal(await h.api.getResumeFromDrive(remote.id), "remote content");
  await h.api.deleteResumeFromDrive(remote.id);
  assert.ok(h.calls.some(call => call.opts.method === "DELETE"));
  await h.api.deleteResumeFromDrive(local.id);
  assert.equal(h.api.getResumeStorageStatus().mode, "drive");
});

test("Drive-only successes retain Drive status and do not create browser copies", async () => {
  const h = harness();
  h.controls.available = true;
  assert.equal((await h.api.listResumesFromDrive())[0].storage, "drive");
  assert.equal(h.api.getResumeStorageStatus().mode, "drive");
  await h.api.saveResumeToDrive("Remote", "content");
  assert.equal(h.data.has(key("alice@example.com")), false);
});

test("Drive authorization retries once on an explicit 401 before falling back", async () => {
  const h = harness();
  h.controls.available = true;
  h.data.set("jp_gtoken", "expired-test-token");
  h.data.set("jp_gtoken_expiry", "expired");
  h.controls.response = { ok: false, status: 401, async json() { return {}; } };
  assert.equal((await h.api.saveResumeToDrive("Resume", "content")).storage, "local");
  assert.equal(h.calls.length, 2);
  assert.equal(h.controls.tokenCalls, 2);
  assert.equal(h.data.has("jp_gtoken"), false);
  assert.equal(h.data.has("jp_gtoken_expiry"), false);
});

test("network and unavailable API failures fall back; uncertain writes never retry", async () => {
  for (const status of [null, 403, 429, 503]) {
    const h = harness();
    h.controls.available = true;
    if (status === null) h.controls.fetchError = new TypeError("network-private-detail");
    else h.controls.response = { ok: false, status, async json() { return { error: { message: "private-detail" } }; } };
    assert.equal((await h.api.listResumesFromDrive()).length, 0);
    h.calls.length = 0;
    assert.equal((await h.api.saveResumeToDrive("Fallback", "content")).storage, "local");
    assert.equal(h.calls.length, 1);
    if (status === null || status === 503) assert.match(h.api.getResumeStorageStatus().message, /copy may also exist in Drive/);
    assert.ok(h.warnings.every(warning => !warning.includes("private-detail")));
  }
});

test("invalid upload acknowledgments save locally and warn about uncertain remote copy", async () => {
  const h = harness();
  h.controls.available = true;
  h.controls.response = { ok: true, status: 200, async json() { return {}; } };
  assert.equal((await h.api.saveResumeToDrive("Resume", "content")).storage, "local");
  assert.equal(h.calls.length, 1);
  assert.match(h.api.getResumeStorageStatus().message, /could not be confirmed/);
});

test("non-availability Drive errors are not silently treated as local success", async () => {
  const h = harness();
  h.controls.available = true;
  h.controls.response = { ok: false, status: 400, async json() { return { error: { message: "Invalid request" } }; } };
  await assert.rejects(h.api.saveResumeToDrive("Resume", "content"), /Invalid request/);
  assert.equal(h.data.has(key("alice@example.com")), false);
});

test("malformed caches fail explicitly without overwriting existing data", async () => {
  for (const raw of ["{bad", "{}", "null", '[{"id":"local_a","name":"Resume","content":7}]']) {
    const h = harness();
    h.data.set(key("alice@example.com"), raw);
    await assert.rejects(h.api.listResumesFromDrive(), /malformed/);
    await assert.rejects(h.api.saveResumeToDrive("Resume", "content"), /malformed/);
    assert.equal(h.data.get(key("alice@example.com")), raw);
  }
});

test("failed local deletion preserves the library and active pointer", async () => {
  const h = harness();
  const saved = await h.api.saveResumeToDrive("Existing", "retained");
  h.api.setActiveResumeId(saved.id);
  const before = h.data.get(key("alice@example.com"));
  h.controls.writeError = Object.assign(new Error("blocked"), { name: "SecurityError" });
  await assert.rejects(h.api.deleteResumeFromDrive(saved.id), /Browser storage/);
  assert.equal(h.data.get(key("alice@example.com")), before);
  assert.equal(h.api.getActiveResumeId(), saved.id);
});

test("missing signed-in account does not create a shared anonymous resume library", async () => {
  const h = harness(new Map());
  await assert.rejects(h.api.saveResumeToDrive("Resume", "private"), /Sign in/);
  assert.equal(h.data.size, 0);
});

test("legacy demo resumes and their IDs remain readable without migration or deletion", async () => {
  const h = harness();
  h.data.set("jp_demo", "1");
  h.data.set("jp_demo_library", JSON.stringify([{ id: "old-uuid", name: "Legacy", content: "retained", createdTime: timestamp, size: 8 }]));
  assert.equal(await h.api.getResumeFromDrive("old-uuid"), "retained");
  await h.api.saveResumeToDrive("New", "new content");
  assert.equal((await h.api.listResumesFromDrive()).length, 2);
  assert.equal(await h.api.getResumeFromDrive("old-uuid"), "retained");
});

test("explicit local clear affects only this account and emits refreshed usage", async () => {
  const h = harness();
  const alice = await h.api.saveResumeToDrive("Alice", "alice-private");
  h.api.setActiveResumeId(alice.id);
  h.data.set("jp_email", "bob@example.com");
  const bob = await h.api.saveResumeToDrive("Bob", "bob-private");
  h.api.setActiveResumeId(bob.id);
  h.data.set("jp_demo_library", "legacy-demo-data");
  h.data.set("jp_byok_v1", "encrypted-settings");
  h.data.set("jp_email", "alice@example.com");
  h.controls.available = true;
  await h.api.listResumesFromDrive();
  const callsBeforeClear = h.calls.length;
  assert.equal(h.api.clearLocalResumeLibrary(), true);
  assert.equal(h.calls.length, callsBeforeClear);
  assert.equal(h.data.has(key("alice@example.com")), false);
  assert.equal(h.api.getActiveResumeId(), "");
  assert.equal(h.api.getResumeStorageStatus().mode, "drive");
  assert.equal(h.api.getResumeStorageStatus().usedBytes, bytes([]));
  assert.match(h.events.at(-1).detail.message, /Google Drive resumes were not deleted/);
  assert.equal(h.events.at(-1).detail.usedBytes, bytes([]));
  assert.equal(h.data.get("jp_demo_library"), "legacy-demo-data");
  assert.equal(h.data.get("jp_byok_v1"), "encrypted-settings");
  h.data.set("jp_email", "bob@example.com");
  assert.equal(await h.api.getResumeFromDrive(bob.id), "bob-private");
  assert.equal(h.api.getActiveResumeId(), bob.id);
});

test("explicit local clear preserves remote pointers and can recover malformed cache", () => {
  const h = harness();
  h.data.set(key("alice@example.com"), "{malformed");
  h.api.setActiveResumeId("drive-id");
  h.api.clearLocalResumeLibrary();
  assert.equal(h.api.getActiveResumeId(), "drive-id");
  assert.equal(h.data.has(key("alice@example.com")), false);
  assert.equal(h.calls.length, 0);
});

test("failed explicit clear surfaces failure and preserves cached resumes", async () => {
  const h = harness();
  const saved = await h.api.saveResumeToDrive("Existing", "retained");
  h.api.setActiveResumeId(saved.id);
  const before = h.data.get(key("alice@example.com"));
  h.controls.removeError = new Error("Storage disabled");
  assert.throws(() => h.api.clearLocalResumeLibrary(), /could not be completely cleared/);
  assert.equal(h.data.get(key("alice@example.com")), before);
  assert.equal(h.api.getActiveResumeId(), saved.id);
});
