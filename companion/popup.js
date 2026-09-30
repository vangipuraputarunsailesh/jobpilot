'use strict';
const byId = id => document.getElementById(id);
let imported = null;
let busy = false;
let importSequence = 0;

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'The worker did not respond. An attempt may already count; review manually.');
  return response.data;
}

function controls() {
  byId('fill').disabled = busy || !imported || !byId('consent').checked;
  byId('consent').disabled = busy || !imported;
  byId('bundle').disabled = busy;
}

async function refreshHistory() {
  try {
    const status = await request({ type: 'status' });
    byId('quota').textContent = `${status.used}/20 fill attempts used on ${status.day} (UTC). This installation only.`;
    byId('history').replaceChildren();
    for (const record of status.records) {
      const li = document.createElement('li');
      li.textContent = `${new Date(record.attemptedAt).toISOString()} — ${record.state} — ${record.jobUrl}`;
      byId('history').append(li);
    }
  } catch (error) {
    byId('quota').textContent = error.message;
  }
}

byId('theme').addEventListener('change', event => {
  document.documentElement.dataset.theme = event.target.value;
});
byId('consent').addEventListener('change', controls);
byId('bundle').addEventListener('change', async event => {
  const sequence = ++importSequence;
  imported = null;
  byId('review').hidden = true;
  byId('consent').checked = false;
  byId('result').textContent = '';
  controls();
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > JobsPilotCompanion.MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds 3 MiB.');
    const input = JSON.parse(await file.text());
    const { bundle } = await request({ type: 'validate', bundle: input });
    if (sequence !== importSequence) return;
    imported = bundle;
    byId('job').textContent = `${bundle.job.title} — ${bundle.job.company}`;
    byId('job-link').href = bundle.job.url;
    byId('candidate').textContent = `${bundle.candidate.firstName} ${bundle.candidate.lastName} — ${bundle.candidate.email}`;
    byId('resume').textContent = `Selected PDF: ${bundle.resume.name} (${bundle.resume.id})`;
    byId('reason').textContent = bundle.selection.reason;
    byId('gaps').replaceChildren();
    for (const gap of bundle.selection.gaps) {
      const li = document.createElement('li');
      li.textContent = gap;
      byId('gaps').append(li);
    }
    byId('review').hidden = false;
    byId('result').textContent = 'Imported for review only. No application has been submitted.';
  } catch (error) {
    if (sequence !== importSequence) return;
    byId('result').textContent = `Import rejected: ${error instanceof SyntaxError ? 'Invalid JSON.' : error.message}`;
  }
  controls();
});

byId('fill').addEventListener('click', async () => {
  if (busy || !imported || !byId('consent').checked) return;
  busy = true;
  controls();
  byId('result').textContent = 'Reserving one attempt, then preparing the matching active tab…';
  try {
    const result = await request({ type: 'fill', bundle: imported, consent: true });
    byId('result').textContent = `${result.state}. Fields filled: ${result.filled.join(', ') || 'none'}. Resume: ${result.resumeStatus}.\n${result.notes.join('\n')}`;
  } catch (error) {
    byId('result').textContent = `${error.message}\nNo submission is claimed. Any reserved attempt still counts.`;
  } finally {
    busy = false;
    byId('consent').checked = false;
    controls();
    await refreshHistory();
  }
});
refreshHistory();
