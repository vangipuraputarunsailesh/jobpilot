(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobsPilotCompanion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_BUNDLE_BYTES = 3 * 1024 * 1024;
  const MAX_PDF_BYTES = 2 * 1024 * 1024;
  const DAILY_LIMIT = 20;
  const MAX_AGE_MS = 30 * 86400000;
  const MIN_TIME = Date.UTC(2020, 0, 1);
  const MAX_RECORDS = 10000;
  const LEDGER_KEY = 'jp_companion_attempts_v1';
  const states = ['reserved', 'prepared', 'review-needed', 'failed'];

  function requireValue(condition, message) {
    if (!condition) throw new Error(message);
  }

  function object(value, label) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
    return value;
  }

  function text(value, label, max, optional = false) {
    requireValue(typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value),
      `${label} is invalid or too long.`);
    const result = value.trim();
    requireValue(optional || result.length > 0, `${label} is required.`);
    return result;
  }

  function normalizeJobUrl(value) {
    const raw = text(value, 'Job URL', 2048);
    requireValue(!raw.includes('\\') && !/\/(?:\.|%2e){1,2}(?:\/|%2f)/i.test(raw), 'Malformed job URL.');
    const url = new URL(raw);
    requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.port,
      'Only supported HTTPS job URLs are allowed.');
    const company = '[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}';
    if (url.hostname === 'jobs.lever.co' || url.hostname === 'jobs.eu.lever.co') {
      const match = url.pathname.match(new RegExp(`^/(${company})/([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})(?:/apply)?/?$`));
      requireValue(match, 'Unsupported Lever job URL.');
      return `https://${url.hostname}/${match[1]}/${match[2].toLowerCase()}`;
    }
    if (url.hostname === 'boards.greenhouse.io' || url.hostname === 'job-boards.greenhouse.io') {
      const match = url.pathname.match(new RegExp(`^/(${company})/jobs/([0-9]{1,20})/?$`));
      requireValue(match, 'Unsupported Greenhouse job URL.');
      return `https://job-boards.greenhouse.io/${match[1]}/jobs/${match[2]}`;
    }
    throw new Error('Unsupported job host. Custom domains and embedded forms require manual action.');
  }

  function optionalUrl(value, label, linkedin = false) {
    const raw = text(value, label, 2048, true);
    if (!raw) return '';
    const url = new URL(raw);
    requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.port,
      `${label} must be an HTTPS URL without credentials or a custom port.`);
    if (linkedin) requireValue(['linkedin.com', 'www.linkedin.com'].includes(url.hostname)
      && /^\/in\/[^/]+\/?$/.test(url.pathname), 'LinkedIn must be a linkedin.com/in/ profile URL.');
    return url.href;
  }

  function checkedNow(now) {
    requireValue(Number.isSafeInteger(now) && now >= MIN_TIME && now <= 8640000000000000,
      'Invalid system clock. Correct your clock before continuing.');
    return now;
  }

  function validateBundle(input, now = Date.now()) {
    checkedNow(now);
    object(input, 'Bundle');
    requireValue(new TextEncoder().encode(JSON.stringify(input)).length <= MAX_BUNDLE_BYTES, 'Bundle exceeds 3 MiB.');
    requireValue(input.version === 1, 'Unsupported bundle version.');
    const createdAt = text(input.createdAt, 'Creation time', 24);
    requireValue(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(createdAt), 'Creation time must be a UTC ISO timestamp.');
    const timestamp = Date.parse(createdAt);
    requireValue(Number.isFinite(timestamp) && new Date(timestamp).toISOString() === createdAt.replace(/Z$/, createdAt.includes('.') ? 'Z' : '.000Z'),
      'Malformed creation time.');
    requireValue(timestamp <= now && timestamp >= now - MAX_AGE_MS, 'Bundle is future-dated or older than 30 days. Export it again.');
    const job = object(input.job, 'Job');
    const candidate = object(input.candidate, 'Candidate');
    const resume = object(input.resume, 'Resume');
    const selection = object(input.selection, 'Selection');
    const email = text(candidate.email, 'Email', 254);
    requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Invalid email.');
    const phone = text(candidate.phone, 'Phone', 40, true);
    requireValue(!phone || /^[+\d()\s.-]+$/.test(phone) && /\d/.test(phone), 'Invalid phone.');
    const id = text(resume.id, 'Resume ID', 100);
    requireValue(/^[a-zA-Z0-9_-]+$/.test(id), 'Invalid resume ID.');
    const originalName = text(resume.name, 'Resume filename', 160);
    requireValue(resume.mimeType === 'application/pdf', 'Only a PDF resume is supported.');
    requireValue(typeof resume.base64 === 'string' && resume.base64.length <= Math.ceil(MAX_PDF_BYTES / 3) * 4
      && resume.base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(resume.base64),
    'Invalid or oversized PDF encoding.');
    const binary = atob(resume.base64);
    requireValue(binary.length >= 5 && binary.length <= MAX_PDF_BYTES && binary.startsWith('%PDF-')
      && btoa(binary) === resume.base64, 'Resume must be a PDF of at most 2 MiB.');
    const basename = originalName.split(/[\\/]/).pop().replace(/\.pdf$/i, '')
      .replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/^[ .]+/, '').slice(0, 120) || 'resume';
    requireValue(Array.isArray(selection.gaps) && selection.gaps.length <= 20, 'Selection gaps must contain at most 20 entries.');
    return {
      version: 1, createdAt: new Date(timestamp).toISOString(),
      job: { url: normalizeJobUrl(job.url), title: text(job.title, 'Job title', 200), company: text(job.company, 'Company', 200) },
      candidate: {
        firstName: text(candidate.firstName, 'First name', 100),
        lastName: text(candidate.lastName, 'Last name', 100),
        email, phone,
        linkedin: optionalUrl(candidate.linkedin, 'LinkedIn', true),
        website: optionalUrl(candidate.website, 'Website')
      },
      resume: { id, name: `${basename}.pdf`, mimeType: 'application/pdf', base64: resume.base64 },
      selection: {
        reason: text(selection.reason, 'Selection reason', 4000),
        gaps: selection.gaps.map(gap => text(gap, 'Selection gap', 300))
      }
    };
  }

  function validateLedger(input, now) {
    checkedNow(now);
    if (input === undefined) return { version: 1, lastSeen: now, records: [] };
    object(input, 'Attempt history');
    requireValue(input.version === 1 && Number.isSafeInteger(input.lastSeen) && input.lastSeen >= MIN_TIME
      && Array.isArray(input.records) && input.records.length <= MAX_RECORDS, 'Invalid attempt history; filling is blocked.');
    requireValue(now >= input.lastSeen, 'Clock moved backward; filling is blocked until the stored time is reached.');
    const seen = new Set();
    const records = input.records.map(record => {
      object(record, 'Attempt');
      requireValue(Number.isSafeInteger(record.attemptedAt) && record.attemptedAt >= MIN_TIME
        && record.attemptedAt <= input.lastSeen && states.includes(record.state), 'Invalid attempt history; filling is blocked.');
      requireValue(typeof record.jobUrl === 'string' && normalizeJobUrl(record.jobUrl) === record.jobUrl
        && !seen.has(record.jobUrl), 'Invalid or duplicate attempt history; filling is blocked.');
      seen.add(record.jobUrl);
      return { jobUrl: record.jobUrl, attemptedAt: record.attemptedAt, state: record.state };
    });
    return { version: 1, lastSeen: now, records };
  }

  function utcDay(timestamp) { return new Date(timestamp).toISOString().slice(0, 10); }

  function reserveAttempt(input, jobUrl, now = Date.now()) {
    const ledger = validateLedger(input, now);
    const canonical = normalizeJobUrl(jobUrl);
    requireValue(!ledger.records.some(record => record.jobUrl === canonical), 'This job already has an attempt. Review it manually; retries are blocked.');
    requireValue(ledger.records.filter(record => utcDay(record.attemptedAt) === utcDay(now)).length < DAILY_LIMIT,
      'The 20-attempt UTC daily limit has been reached.');
    requireValue(ledger.records.length < MAX_RECORDS, 'Attempt history is full; filling is blocked.');
    ledger.records.push({ jobUrl: canonical, attemptedAt: now, state: 'reserved' });
    return ledger;
  }

  // A single service-worker queue serializes read-modify-write operations, including result updates.
  function createQuotaManager(storage, clock = Date.now) {
    let tail = Promise.resolve();
    function transact(operation) {
      const next = tail.then(async () => {
        const now = checkedNow(clock());
        const current = await storage.get();
        const ledger = operation(current, now);
        await storage.set(ledger);
        return ledger;
      });
      tail = next.catch(() => {});
      return next;
    }
    return {
      reserve: jobUrl => transact((ledger, now) => reserveAttempt(ledger, jobUrl, now)),
      finish: (jobUrl, state) => transact((input, now) => {
        requireValue(states.includes(state) && state !== 'reserved', 'Invalid result state.');
        const ledger = validateLedger(input, now);
        const record = ledger.records.find(item => item.jobUrl === jobUrl);
        requireValue(record && record.state === 'reserved', 'No pending reservation.');
        record.state = state;
        return ledger;
      }),
      status: () => transact(validateLedger)
    };
  }

  return { MAX_BUNDLE_BYTES, MAX_PDF_BYTES, MAX_AGE_MS, DAILY_LIMIT, LEDGER_KEY,
    normalizeJobUrl, validateBundle, validateLedger, reserveAttempt, createQuotaManager, utcDay };
});
