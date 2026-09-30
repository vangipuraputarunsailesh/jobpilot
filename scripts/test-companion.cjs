'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../companion/core.js');
const prepareApplication = require('../companion/fill.js');
const companion = path.resolve(__dirname, '..', 'companion');
const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const LEVER = 'https://jobs.lever.co/example/01234567-89ab-cdef-0123-456789abcdef';
const GH = 'https://job-boards.greenhouse.io/example/jobs/123';
const pdf = Buffer.from('%PDF-1.7\nexact selected resume bytes\n%%EOF');
const clone = value => structuredClone(value);

function bundle(url = GH) {
  return {
    version: 1, createdAt: new Date(NOW).toISOString(),
    job: { url, title: 'Engineer', company: 'Example' },
    candidate: { firstName: 'Alex', lastName: 'Example', email: 'alex@example.com',
      phone: '+1 (555) 123-4567', linkedin: 'https://www.linkedin.com/in/alex', website: 'https://example.com/' },
    resume: { id: 'resume-2', name: 'Alex.pdf', mimeType: 'application/pdf', base64: pdf.toString('base64') },
    selection: { reason: 'Reviewed alignment', gaps: ['Review additional employer questions.'] }
  };
}

test('strict supported job identity, query/hash stripping and Greenhouse alias deduplication', () => {
  assert.equal(core.normalizeJobUrl(`${LEVER}/apply/?source=jobs#form`), LEVER);
  assert.equal(core.normalizeJobUrl(LEVER.replace('jobs.lever.co', 'jobs.eu.lever.co')), LEVER.replace('jobs.lever.co', 'jobs.eu.lever.co'));
  assert.equal(core.normalizeJobUrl('https://boards.greenhouse.io/example/jobs/123/?gh_src=tracker#form'), GH);
  for (const url of [
    'http://job-boards.greenhouse.io/example/jobs/123', 'https://example.com/example/jobs/123',
    'https://job-boards.greenhouse.io.evil.test/example/jobs/123', 'https://jobs.lever.co.evil.test/example/a',
    'https://user:pass@job-boards.greenhouse.io/example/jobs/123', 'https://job-boards.greenhouse.io:8443/example/jobs/123',
    'https://boards.greenhouse.io/embed/job_app?for=example&token=123', `${GH}/apply`,
    `${GH}/extra`, 'https://jobs.lever.co/example/not-a-uuid', 'https://jobs.eu.lever.co/example',
    'https://boards.eu.greenhouse.io/example/jobs/123', 'https://boards.greenhouse.io//example/jobs/123',
    'https://boards.greenhouse.io/example/jobs/%31%32%33', 'https://boards.greenhouse.io/example/foo/../jobs/123',
    'https://boards.greenhouse.io/example/foo/%2e%2e/jobs/123', 'https:\\\\boards.greenhouse.io\\example\\jobs\\123',
    'javascript:alert(1)', `https://boards.greenhouse.io/exa\nmple/jobs/123`
  ]) assert.throws(() => core.normalizeJobUrl(url), undefined, url);
});

test('bundle strips extras including model/key data and sanitizes the filename', () => {
  const input = bundle();
  input.model = 'untrusted-model';
  input.apiKey = 'DO-NOT-SEND';
  input.candidate.apiKey = 'DO-NOT-SEND';
  input.resume.name = '../private\\bad:<name>.PDF';
  input.resume.provider = 'untrusted-provider';
  const valid = core.validateBundle(input, NOW);
  assert.equal(valid.resume.name, 'bad__name_.pdf');
  assert.equal(valid.resume.base64, input.resume.base64);
  assert.ok(!JSON.stringify(valid).includes('DO-NOT-SEND'));
  assert.ok(!JSON.stringify(valid).includes('untrusted-'));
  assert.equal(valid.candidate.firstName, 'Alex');
  const seconds = bundle(); seconds.createdAt = '2026-09-30T12:00:00Z';
  assert.equal(core.validateBundle(seconds, NOW).createdAt, '2026-09-30T12:00:00.000Z');
});

test('schema rejects missing/wrong values, malformed dates and stale/future bundles', () => {
  const mutations = [
    input => { input.version = '1'; },
    input => { input.createdAt = '2026-02-30T12:00:00.000Z'; },
    input => { input.createdAt = 'not-a-date'; },
    input => { input.createdAt = '2026-09-30T12:00:00+00:00'; },
    input => { input.createdAt = new Date(NOW + 1).toISOString(); },
    input => { input.createdAt = new Date(NOW - core.MAX_AGE_MS - 1).toISOString(); },
    input => { input.candidate.firstName = ''; },
    input => { input.candidate.lastName = 'x'.repeat(101); },
    input => { delete input.candidate.phone; },
    input => { input.candidate.phone = { value: '123' }; },
    input => { input.candidate.phone = 'Call me'; },
    input => { input.candidate.email = 'not an email'; },
    input => { input.candidate.linkedin = 'https://linkedin.com.evil.test/in/alex'; },
    input => { input.candidate.linkedin = 'https://linkedin.com/company/example'; },
    input => { input.candidate.website = 'javascript:alert(1)'; },
    input => { input.candidate.website = 'https://password@example.com/'; },
    input => { input.job = []; },
    input => { input.job.company = null; },
    input => { input.resume.id = '../resume'; },
    input => { input.resume.name = 'bad\nfile.pdf'; },
    input => { input.resume.mimeType = 'text/html'; },
    input => { input.selection.reason = 'x'.repeat(4001); },
    input => { input.selection.reason = 'line\nbreak'; },
    input => { input.selection.gaps = ['']; },
    input => { input.selection.gaps = [7]; },
    input => { input.selection.gaps = Array(21).fill('gap'); },
    input => { input.selection.gaps = ['x'.repeat(301)]; }
  ];
  for (const mutate of mutations) {
    const input = bundle(); mutate(input);
    assert.throws(() => core.validateBundle(input, NOW));
  }
  for (const value of [null, [], 'hello', 1]) assert.throws(() => core.validateBundle(value, NOW));
  for (const now of [NaN, Infinity, 0, -1, 1.5]) assert.throws(() => core.validateBundle(bundle(), now));
  const optional = bundle();
  optional.candidate.phone = optional.candidate.linkedin = optional.candidate.website = '';
  assert.equal(core.validateBundle(optional, NOW).candidate.phone, '');
});

test('PDF byte limit, exact base64 and PDF signature validated without dependencies', () => {
  const input = bundle();
  for (const encoding of ['', 'JVBERi0', 'data:application/pdf;base64,JVBERi0=', 'JVBERi0=\n', '!!!!',
    Buffer.from('<html>not a PDF</html>').toString('base64'), 'JVBERi1=']) {
    input.resume.base64 = encoding;
    assert.throws(() => core.validateBundle(input, NOW), undefined, encoding);
  }
  const maximum = Buffer.alloc(core.MAX_PDF_BYTES, 32);
  maximum.write('%PDF-');
  input.resume.base64 = maximum.toString('base64');
  assert.equal(core.validateBundle(input, NOW).resume.base64, input.resume.base64);
  input.resume.base64 = Buffer.concat([maximum, Buffer.from(' ')]).toString('base64');
  assert.throws(() => core.validateBundle(input, NOW), /oversized|at most/);
  const oversized = bundle(); oversized.ignored = 'x'.repeat(core.MAX_BUNDLE_BYTES);
  assert.throws(() => core.validateBundle(oversized, NOW), /3 MiB/);
});

test('20th attempt succeeds, 21st fails; UTC rollover retains permanent deduplication', () => {
  let ledger;
  for (let id = 1; id <= 20; id++) ledger = core.reserveAttempt(ledger, GH.replace('123', String(id)), NOW + id);
  assert.equal(ledger.records.length, 20);
  assert.throws(() => core.reserveAttempt(ledger, GH.replace('123', '21'), NOW + 21), /20-attempt/);
  assert.throws(() => core.reserveAttempt(ledger, 'https://boards.greenhouse.io/example/jobs/1/?tracking=1', NOW + 21), /already/);
  const nextDay = Date.parse('2026-10-01T00:00:00.000Z');
  ledger = core.reserveAttempt(ledger, GH.replace('123', '21'), nextDay);
  assert.equal(ledger.records.length, 21);
  assert.throws(() => core.reserveAttempt(ledger, GH.replace('123', '1'), nextDay + 1), /already/);
  const beforeMidnight = core.reserveAttempt(undefined, GH, Date.parse('2026-09-30T23:59:59.999Z'));
  assert.equal(core.reserveAttempt(beforeMidnight, GH.replace('123', '2'), nextDay).records.length, 2);
});

test('clock rollback, corrupt history, invalid timestamps fail closed', () => {
  const valid = core.reserveAttempt(undefined, GH, NOW);
  assert.throws(() => core.reserveAttempt(valid, LEVER, NOW - 1), /backward/);
  for (const corrupt of [
    null, [], {}, { ...valid, version: 2 }, { ...valid, lastSeen: Infinity },
    { ...valid, lastSeen: -1 }, { ...valid, records: [{ ...valid.records[0], attemptedAt: NOW + 1 }] },
    { ...valid, records: [{ ...valid.records[0], attemptedAt: '2026-09-30' }] },
    { ...valid, records: [{ ...valid.records[0], attemptedAt: 0 }] },
    { ...valid, records: [{ ...valid.records[0], state: 'submitted' }] },
    { ...valid, records: [{ ...valid.records[0], jobUrl: 'https://evil.test/' }] },
    { ...valid, records: [valid.records[0], valid.records[0]] }
  ]) assert.throws(() => core.reserveAttempt(corrupt, LEVER, NOW + 1));
  assert.equal(core.reserveAttempt(valid, LEVER, NOW + 1).records.length, 2);
  assert.equal(valid.records.length, 1, 'pure reservation must not mutate input');
});

function memoryStorage(initial) {
  let saved = initial;
  return {
    get: async () => { await Promise.resolve(); return clone(saved); },
    set: async value => { await Promise.resolve(); saved = clone(value); },
    value: () => clone(saved)
  };
}

test('serialized concurrent reservations and completions cannot exceed 20 or lose history', async () => {
  const store = memoryStorage();
  const manager = core.createQuotaManager(store, () => NOW);
  const attempts = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => manager.reserve(GH.replace('123', String(i + 1)))));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 20);
  assert.equal(store.value().records.length, 20);
  await Promise.all(store.value().records.map((record, i) => manager.finish(record.jobUrl, i % 2 ? 'failed' : 'review-needed')));
  assert.equal(store.value().records.filter(record => record.state === 'reserved').length, 0);
  const restarted = core.createQuotaManager(store, () => NOW);
  await assert.rejects(restarted.reserve(GH.replace('123', '1')), /already/);
  await assert.rejects(restarted.reserve(GH.replace('123', '99')), /20-attempt/);
  await assert.rejects(restarted.finish(GH.replace('123', '1'), 'prepared'), /No pending/);
});

test('simultaneous duplicate imports/reservations consume only one; imports alone consume none', async () => {
  const store = memoryStorage();
  const manager = core.createQuotaManager(store, () => NOW);
  for (let i = 0; i < 3; i++) core.validateBundle(bundle(), NOW);
  assert.equal(store.value(), undefined);
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => manager.reserve(GH)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(store.value().records.length, 1);
  await manager.finish(GH, 'failed');
  await assert.rejects(manager.reserve(GH), /already/);
});

test('storage rejection blocks reservation without defeating later queue operations', async () => {
  const store = memoryStorage();
  let reject = true;
  const manager = core.createQuotaManager({
    get: store.get, set: async ledger => { if (reject) throw new Error('Storage unavailable'); await store.set(ledger); }
  }, () => NOW);
  await assert.rejects(manager.reserve(GH), /Storage unavailable/);
  assert.equal(store.value(), undefined);
  reject = false;
  await manager.reserve(GH);
  assert.equal(store.value().records.length, 1);
});

function runFill(options = {}) {
  const url = options.url || GH;
  const lever = url.includes('lever.co');
  let submitCalls = 0;
  const events = [];
  class Input {
    constructor(spec) {
      Object.assign(this, {
        id: '', name: '', type: 'text', disabled: false, readOnly: false, required: false,
        multiple: false, checked: false, files: [], isConnected: true, visible: true,
        validity: { valid: true }, attributes: {}, labels: []
      }, spec);
      this._value = spec.value || '';
      this.labels = spec.label ? [{ textContent: spec.label }] : [];
    }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    getClientRects() { return this.visible ? [1] : []; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    dispatchEvent(event) { events.push([this.name, event.type]); options.onEvent?.(this, event, form); return true; }
    click() { submitCalls++; throw new Error('Must never click'); }
  }
  const defaultFields = lever ? [
    { name: 'name', label: 'Full name', required: true }, { name: 'email', type: 'email', label: 'Email', required: true },
    { name: 'phone', type: 'tel', label: 'Phone' }, { name: 'urls[LinkedIn]', label: 'LinkedIn' },
    { name: 'urls[Website]', label: 'Website' }, { name: 'resume', type: 'file', label: 'Resume/CV', required: true }
  ] : [
    { id: 'first_name', name: 'first_name', label: 'First Name', required: true },
    { id: 'last_name', name: 'job_application[last_name]', label: 'Last Name', required: true },
    { id: 'email', name: 'email', type: 'email', label: 'Email', required: true },
    { id: 'phone', name: 'phone', type: 'tel', label: 'Phone' },
    { id: 'linkedin', name: 'linkedin', label: 'LinkedIn' }, { id: 'website', name: 'website', label: 'Website' },
    { id: 'resume', name: 'job_application[resume]', type: 'file', label: 'Resume/CV', required: true }
  ];
  const inputs = (options.fields || defaultFields).concat(options.extra || []).map(spec => new Input(spec));
  const form = {
    isConnected: true,
    getAttribute: name => name === 'action' ? options.action || '' : null,
    querySelectorAll: selector => selector === 'input[type="file"]' ? inputs.filter(input => input.type === 'file') : inputs,
    submit: () => { submitCalls++; throw new Error('Must never submit'); },
    requestSubmit: () => { submitCalls++; throw new Error('Must never submit'); }
  };
  for (const input of inputs) input.form = form;
  const window = {}; window.self = window; window.top = options.iframe ? {} : window;
  class TestFile {
    constructor(parts, name, settings) { this.bytes = parts[0]; this.name = name; this.type = settings.type; this.size = this.bytes.length; }
  }
  class TestTransfer {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
  }
  const payload = core.validateBundle(bundle(options.expectedUrl || (lever ? LEVER : GH)), NOW);
  const context = vm.createContext({
    URL, Uint8Array, atob, File: TestFile, DataTransfer: TestTransfer,
    Event: class { constructor(type) { this.type = type; } }, HTMLInputElement: Input,
    window, location: { href: url },
    document: {
      querySelectorAll: () => options.noForm ? [] : options.multipleForms ? [form, form] : [form],
      querySelector: () => options.captcha ? {} : null
    },
    payload: { jobUrl: payload.job.url, candidate: payload.candidate, resume: payload.resume }
  });
  const result = vm.runInContext(`(${prepareApplication.toString()})(payload)`, context);
  return { result, inputs, events, submitCalls };
}

test('Greenhouse fills exact known fields and PDF; never clicks or submits', () => {
  const { result, inputs, events, submitCalls } = runFill();
  assert.equal(result.state, 'prepared');
  assert.equal(result.submitted, false);
  assert.equal(submitCalls, 0);
  assert.equal(inputs.find(input => input.id === 'first_name').value, 'Alex');
  assert.equal(inputs.find(input => input.id === 'email').value, 'alex@example.com');
  const file = inputs.find(input => input.type === 'file').files[0];
  assert.equal(file.name, 'Alex.pdf');
  assert.equal(file.type, 'application/pdf');
  assert.deepEqual(Buffer.from(file.bytes), pdf);
  assert.equal(events.length, 14);
  assert.ok(result.notes.join(' ').includes('Not submitted'));
});

test('Lever full name, /apply, EU host, and Greenhouse aliases are recognized', () => {
  const lever = runFill({ url: `${LEVER}/apply?source=test` });
  assert.equal(lever.result.state, 'prepared');
  assert.equal(lever.inputs.find(input => input.name === 'name').value, 'Alex Example');
  const eu = LEVER.replace('jobs.lever.co', 'jobs.eu.lever.co');
  assert.equal(runFill({ url: `${eu}/apply`, expectedUrl: eu }).result.state, 'prepared');
  assert.equal(runFill({ url: GH.replace('job-boards', 'boards') }).result.state, 'prepared');
});

test('wrong job, iframe, unknown form, duplicate forms and cross-origin action reject before mutations', () => {
  for (const options of [
    { url: GH.replace('123', '124') }, { url: 'https://evil.test/example/jobs/123' },
    { iframe: true }, { noForm: true }, { multipleForms: true }, { action: 'https://evil.test/collect' },
    { action: '/example/jobs/124' }, { action: '/api/applications' }, { action: 'http://[' }
  ]) {
    const attempt = runFill(options);
    assert.equal(attempt.result.state, 'failed');
    assert.equal(attempt.events.length, 0);
    assert.equal(attempt.submitCalls, 0);
  }
  assert.equal(runFill({ action: '/example/jobs/123?source=jobs' }).result.state, 'prepared');
});

test('cover letter, missing/ambiguous resume, and unexpected labels are never used', () => {
  for (const fields of [
    [{ id: 'cover_letter', name: 'job_application[cover_letter]', type: 'file' }],
    [{ id: 'resume', name: 'job_application[resume]', type: 'file', label: 'Cover letter' }],
    [{ id: 'resume', name: 'job_application[resume]', type: 'file', multiple: true }],
    [{ id: 'resume', name: 'job_application[resume]', type: 'file' }, { id: 'resume', name: 'resume', type: 'file' }]
  ]) {
    const attempt = runFill({ fields });
    assert.equal(attempt.result.state, 'failed');
    assert.equal(attempt.events.length, 0);
    assert.ok(attempt.inputs.every(input => input.files.length === 0));
  }
  const attempt = runFill({ extra: [{ id: 'cover_letter', name: 'job_application[cover_letter]', type: 'file' }] });
  assert.equal(attempt.inputs.find(input => input.id === 'cover_letter').files.length, 0);
  assert.equal(attempt.result.state, 'prepared');
});

test('existing fields/files are unchanged; unknown, hidden, disabled, legal and consent fields stay manual', () => {
  const existingFile = { name: 'my-existing.pdf', size: 20 };
  const fields = [
    { id: 'first_name', name: 'first_name', value: 'Existing' },
    { id: 'last_name', name: 'last_name', readOnly: true },
    { id: 'email', name: 'email', value: ' ' },
    { id: 'phone', name: 'phone', visible: false },
    { id: 'linkedin', name: 'linkedin', disabled: true },
    { id: 'website', name: 'website', label: 'Work authorization' },
    { id: 'resume', name: 'resume', type: 'file', files: [existingFile], value: 'existing.pdf' },
    { id: 'salary', name: 'salary', required: true },
    { id: 'sponsorship', name: 'sponsorship' }, { id: 'demographics', name: 'demographics' },
    { id: 'disability', name: 'disability' }, { id: 'legal', name: 'legal', type: 'checkbox', required: true },
    { id: 'consent', name: 'consent', type: 'checkbox' }, { id: 'gender', name: 'gender', type: 'radio' },
    { id: 'constructor', name: '__proto__' }
  ];
  const attempt = runFill({ fields });
  assert.equal(attempt.result.state, 'review-needed');
  assert.equal(attempt.result.resumeStatus, 'existing-file');
  assert.equal(attempt.events.length, 0);
  assert.equal(attempt.inputs[0].value, 'Existing');
  assert.equal(attempt.inputs[2].value, ' ');
  assert.equal(attempt.inputs[6].files[0], existingFile);
  assert.ok(attempt.inputs.filter(input => ['checkbox', 'radio'].includes(input.type)).every(input => !input.checked));
});

test('required unknowns, CAPTCHA, invalid values and ambiguous fields report review-needed', () => {
  for (const options of [
    { extra: [{ name: 'custom_answer', required: true }] }, { captcha: true },
    { extra: [{ name: 'custom_answer', attributes: { 'aria-required': 'true' } }] },
    { extra: [{ name: 'custom_answer', required: true, value: 'bad', validity: { valid: false } }] },
    { extra: [{ id: 'first_name', name: 'first_name' }] }
  ]) {
    const attempt = runFill(options);
    assert.equal(attempt.result.state, 'review-needed');
    assert.equal(attempt.result.submitted, false);
    assert.equal(attempt.submitCalls, 0);
  }
});

test('form replacement during input events fails and does not attach to a stale form', () => {
  const attempt = runFill({ onEvent: (_input, _event, form) => { form.isConnected = false; } });
  assert.equal(attempt.result.state, 'failed');
  assert.equal(attempt.inputs.find(input => input.type === 'file').files.length, 0);
  assert.equal(attempt.submitCalls, 0);
});

function workerHarness(options = {}) {
  let listener;
  let ledger;
  let queryCount = 0;
  const injections = [];
  const clock = class extends Date { static now() { return NOW; } };
  const chrome = {
    runtime: { id: 'test-extension', getURL: name => `chrome-extension://test-extension/${name}`,
      onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: {
      get: async key => { await Promise.resolve(); return { [key]: clone(ledger) }; },
      set: async input => { if (options.storageFailure) throw new Error('Storage failure'); await Promise.resolve(); ledger = clone(input[core.LEDGER_KEY]); }
    } },
    tabs: { query: async () => {
      queryCount++;
      return [{ id: options.changedTab && queryCount > 1 ? 8 : 7, url: options.tabUrl || GH }];
    } },
    scripting: { executeScript: async args => {
      assert.ok(ledger.records.some(record => record.jobUrl === args.args[0].jobUrl && record.state === 'reserved'), 'reservation must precede injection');
      injections.push(args);
      if (options.injectionFailure) throw new Error('Tab navigated');
      return [{ frameId: 0, result: { state: 'prepared', filled: ['email'], resumeStatus: 'attached', notes: ['Not submitted.'], submitted: false } }];
    } }
  };
  const context = vm.createContext({ chrome, Date: clock, URL, TextEncoder, atob, btoa, structuredClone });
  context.importScripts = (...files) => { for (const file of files) vm.runInContext(fs.readFileSync(path.join(companion, file), 'utf8'), context); };
  vm.runInContext(fs.readFileSync(path.join(companion, 'worker.js'), 'utf8'), context);
  return {
    injections,
    ledger: () => clone(ledger),
    send: (message, sender = { id: 'test-extension', url: chrome.runtime.getURL('popup.html') }) =>
      new Promise(resolve => listener(message, sender, resolve))
  };
}

test('worker owns validation, consent, matching-tab check, payload minimization and persistent reservation', async () => {
  const worker = workerHarness();
  const input = bundle(); input.model = 'NEVER-SEND'; input.apiKey = 'NEVER-SEND';
  input.selection.reason = 'ALSO-NOT-INJECTED';
  const imported = await worker.send({ type: 'validate', bundle: input });
  assert.equal(imported.ok, true);
  assert.equal(worker.ledger(), undefined, 'import does not reserve an attempt');
  assert.equal((await worker.send({ type: 'fill', bundle: input })).ok, false);
  assert.equal(worker.ledger(), undefined);
  const result = await worker.send({ type: 'fill', bundle: input, consent: true });
  assert.equal(result.ok, true);
  assert.equal(result.data.submitted, false);
  assert.equal(worker.ledger().records[0].state, 'prepared');
  assert.equal(worker.injections.length, 1);
  const injection = worker.injections[0];
  assert.equal(injection.world, 'ISOLATED');
  assert.equal(injection.target.frameIds.length, 1);
  assert.equal(injection.target.frameIds[0], 0);
  assert.equal(injection.target.tabId, 7);
  assert.ok(!JSON.stringify(injection.args).includes('NEVER-SEND'));
  assert.ok(!JSON.stringify(injection.args).includes('ALSO-NOT-INJECTED'));
  assert.ok(!JSON.stringify(worker.ledger()).includes('Alex'));
  assert.ok(!JSON.stringify(worker.ledger()).includes(input.resume.base64));
  const repeat = await worker.send({ type: 'fill', bundle: input, consent: true });
  assert.equal(repeat.ok, false);
  assert.match(repeat.error, /already/);
  assert.equal(worker.injections.length, 1);
});

test('worker rejects arbitrary action args, other extension pages and content-script senders', async () => {
  const worker = workerHarness();
  const message = { type: 'fill', bundle: bundle(), consent: true };
  for (const input of [{ ...message, tabId: 7 }, { ...message, script: 'submit()' }, { type: 'submit' }, { type: '__proto__' }, null]) {
    assert.equal((await worker.send(input)).ok, false);
  }
  for (const sender of [
    { id: 'other', url: 'chrome-extension://test-extension/popup.html' },
    { id: 'test-extension', url: 'https://jobspilot.site/' },
    { id: 'test-extension', url: 'chrome-extension://test-extension/other.html' },
    { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html', tab: { id: 7 } }
  ]) assert.equal((await worker.send(message, sender)).ok, false);
  assert.equal(worker.injections.length, 0);
  assert.equal(worker.ledger(), undefined);
});

test('worker mismatch does not reserve; changed tab, failed injection and uncertain outcomes consume one', async () => {
  const mismatch = workerHarness({ tabUrl: LEVER });
  assert.equal((await mismatch.send({ type: 'fill', bundle: bundle(), consent: true })).ok, false);
  assert.equal(mismatch.ledger(), undefined);
  for (const options of [{ changedTab: true }, { injectionFailure: true }]) {
    const worker = workerHarness(options);
    const response = await worker.send({ type: 'fill', bundle: bundle(), consent: true });
    assert.equal(response.ok, true);
    assert.equal(response.data.state, 'failed');
    assert.equal(worker.ledger().records.length, 1);
    assert.equal(worker.ledger().records[0].state, 'failed');
    assert.equal((await worker.send({ type: 'fill', bundle: bundle(), consent: true })).ok, false);
  }
  const unavailable = workerHarness({ storageFailure: true });
  assert.equal((await unavailable.send({ type: 'fill', bundle: bundle(), consent: true })).ok, false);
  assert.equal(unavailable.injections.length, 0);
});

test('concurrent popup worker requests for same job reserve and inject only once', async () => {
  const worker = workerHarness();
  const results = await Promise.all(Array.from({ length: 25 }, () => worker.send({ type: 'fill', bundle: bundle(), consent: true })));
  assert.equal(results.filter(response => response.ok).length, 1);
  assert.equal(worker.injections.length, 1);
  assert.equal(worker.ledger().records.length, 1);
});

test('manifest and code have no broad access, submission actions, model client or unsafe HTML', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(companion, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.slice().sort(), ['activeTab', 'scripting', 'storage']);
  for (const key of ['host_permissions', 'optional_host_permissions', 'content_scripts', 'externally_connectable']) assert.equal(manifest[key], undefined);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
  for (const file of ['core.js', 'fill.js', 'worker.js', 'popup.js']) {
    const source = fs.readFileSync(path.join(companion, file), 'utf8');
    assert.doesNotMatch(source, /\.innerHTML|insertAdjacentHTML|eval\s*\(|new Function|fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
    assert.doesNotMatch(source, /\.click\s*\(|\.submit\s*\(|\.requestSubmit\s*\(/);
  }
  const popup = fs.readFileSync(path.join(companion, 'popup.html'), 'utf8');
  assert.doesNotMatch(popup, /\son\w+=|https?:\/\/.*\.js/);
  assert.match(popup, /may upload it immediately/);
});
