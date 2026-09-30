'use strict';
importScripts('core.js', 'fill.js');

const core = JobsPilotCompanion;
const quota = core.createQuotaManager({
  get: async () => (await chrome.storage.local.get(core.LEDGER_KEY))[core.LEDGER_KEY],
  set: ledger => chrome.storage.local.set({ [core.LEDGER_KEY]: ledger })
});

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid request.');
  const allowed = { status: ['type'], validate: ['type', 'bundle'], fill: ['type', 'bundle', 'consent'] };
  if (!Object.hasOwn(allowed, message.type) || Object.keys(message).some(key => !allowed[message.type].includes(key))) {
    throw new Error('Unsupported request arguments.');
  }
  if (message.type === 'status') {
    const ledger = await quota.status();
    return {
      used: ledger.records.filter(record => core.utcDay(record.attemptedAt) === core.utcDay(ledger.lastSeen)).length,
      day: core.utcDay(ledger.lastSeen), records: ledger.records.slice(-30).reverse()
    };
  }
  const bundle = core.validateBundle(message.bundle);
  if (message.type === 'validate') return { bundle };
  if (message.consent !== true) throw new Error('Explicit consent to fill and attach this PDF is required.');
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tabs.length !== 1 || !Number.isInteger(tab?.id) || core.normalizeJobUrl(tab.url || '') !== bundle.job.url) {
    throw new Error('Open the exact supported job in the active tab before preparing.');
  }
  await quota.reserve(bundle.job.url);
  let result;
  try {
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active.length !== 1 || active[0].id !== tab.id || core.normalizeJobUrl(active[0].url || '') !== bundle.job.url) {
      throw new Error('Active tab changed after reservation');
    }
    const injections = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'ISOLATED',
      func: prepareJobsPilotApplication,
      args: [{ jobUrl: bundle.job.url, candidate: bundle.candidate, resume: bundle.resume }]
    });
    result = injections.length === 1 && injections[0].frameId === 0 ? injections[0].result : null;
    if (!result || !['prepared', 'review-needed', 'failed'].includes(result.state) || result.submitted !== false) {
      throw new Error('Uncertain injection result');
    }
  } catch (_) {
    result = { state: 'failed', filled: [], resumeStatus: 'uncertain', submitted: false,
      notes: ['Preparation failed or its result is uncertain. This attempt counts. Inspect the page manually; do not retry.'] };
  }
  await quota.finish(bundle.job.url, result.state);
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) {
    respond({ ok: false, error: 'Only the companion popup may request preparation.' });
    return false;
  }
  handleMessage(message).then(data => respond({ ok: true, data }),
    error => respond({ ok: false, error: error.message || 'Unable to prepare. Review manually.' }));
  return true;
});
