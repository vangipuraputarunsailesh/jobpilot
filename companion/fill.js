(function (root, factory) {
  const fill = factory();
  if (typeof module === 'object' && module.exports) module.exports = fill;
  else root.prepareJobsPilotApplication = fill;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Self-contained because Chrome serializes this function into an isolated, top-frame world.
  return function prepareApplication(payload) {
    const notes = [];
    const filled = [];
    function result(state, resumeStatus = 'not-attached') {
      return { state, filled, resumeStatus, notes, submitted: false };
    }
    function currentJob(href = location.href) {
      const url = new URL(href);
      if (window.top !== window.self || url.protocol !== 'https:' || url.username || url.password || url.port) return '';
      const company = '[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}';
      if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(url.hostname)) {
        const match = url.pathname.match(new RegExp(`^/(${company})/([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})(?:/apply)?/?$`));
        return match ? `https://${url.hostname}/${match[1]}/${match[2].toLowerCase()}` : '';
      }
      if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname)) {
        const match = url.pathname.match(new RegExp(`^/(${company})/jobs/([0-9]{1,20})/?$`));
        return match ? `https://job-boards.greenhouse.io/${match[1]}/jobs/${match[2]}` : '';
      }
      return '';
    }
    if (!payload || !payload.jobUrl || currentJob() !== payload.jobUrl) {
      notes.push('The top-level job URL changed or is unsupported. Continue manually.');
      return result('failed');
    }
    const lever = new URL(payload.jobUrl).hostname.endsWith('lever.co');
    const forms = Array.from(document.querySelectorAll(lever ? 'form#application-form' : 'form#application_form, form#application-form'));
    if (forms.length !== 1) {
      notes.push('No single supported top-level application form. Open the application form manually; login, embedded forms and changed layouts are unsupported.');
      return result('failed');
    }
    const form = forms[0];
    const action = form.getAttribute('action');
    if (action) {
      try {
        const target = new URL(action, location.href);
        if (target.origin !== new URL(location.href).origin || currentJob(target.href) !== payload.jobUrl) {
          throw new Error('Unexpected form target');
        }
      } catch (_) {
        notes.push('The form targets another job or an unsupported endpoint. Continue manually.');
        return result('failed');
      }
    }
    function labelFor(input) {
      return Array.from(input.labels || []).map(label => label.textContent).join(' ')
        .trim().toLowerCase().replace(/\s+/g, ' ').replace(/[\s*:]+$/, '');
    }
    const files = Array.from(form.querySelectorAll('input[type="file"]')).filter(input =>
      input.form === form && !input.disabled && !input.multiple
      && (lever ? input.name === 'resume' : input.id === 'resume' && ['resume', 'job_application[resume]'].includes(input.name))
      && (!labelFor(input) || ['resume', 'resume/cv', 'resume / cv', 'cv', 'attach resume/cv'].includes(labelFor(input))));
    if (files.length !== 1) {
      notes.push('No unambiguous supported resume upload. No fields were changed; upload and complete manually.');
      return result('failed');
    }
    const candidate = payload.candidate;
    const values = { ...candidate, fullName: `${candidate.firstName} ${candidate.lastName}` };
    const labels = {
      fullName: ['name', 'full name'], firstName: ['first name'], lastName: ['last name'],
      email: ['email', 'email address'], phone: ['phone', 'phone number'],
      linkedin: ['linkedin', 'linkedin profile', 'linkedin profile url'],
      website: ['website', 'personal website', 'website url']
    };
    const leverNames = { name: 'fullName', email: 'email', phone: 'phone', 'urls[LinkedIn]': 'linkedin', 'urls[Website]': 'website' };
    const greenhouseIds = { first_name: 'firstName', last_name: 'lastName', email: 'email', phone: 'phone', linkedin: 'linkedin', website: 'website' };
    const groups = {};
    for (const input of form.querySelectorAll('input')) {
      if (input.form !== form || input.disabled || input.readOnly || !input.getClientRects().length
        || !['text', 'email', 'tel', 'url'].includes(input.type)) continue;
      const key = lever ? Object.hasOwn(leverNames, input.name) && leverNames[input.name]
        : Object.hasOwn(greenhouseIds, input.id) && greenhouseIds[input.id];
      if (!key || !lever && ![input.id, `job_application[${input.id}]`].includes(input.name)) continue;
      const label = labelFor(input);
      if (label && !labels[key].includes(label)) continue;
      (groups[key] ||= []).push(input);
    }
    let resumeStatus = 'not-attached';
    try {
      for (const [key, inputs] of Object.entries(groups)) {
        if (inputs.length !== 1) { notes.push(`Ambiguous ${key} fields were left unchanged.`); continue; }
        const input = inputs[0];
        if (!values[key] || input.value !== '') continue;
        if (currentJob() !== payload.jobUrl || !form.isConnected || !input.isConnected) throw new Error('Form changed');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, values[key]);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        filled.push(key);
      }
      const fileInput = files[0];
      if (currentJob() !== payload.jobUrl || !form.isConnected || !fileInput.isConnected) throw new Error('Form changed');
      if (fileInput.files.length > 0 || fileInput.value !== '') {
        resumeStatus = 'existing-file';
        notes.push('An existing attachment was not replaced. Confirm it is the exact selected resume.');
      } else {
        const binary = atob(payload.resume.base64);
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], payload.resume.name, { type: 'application/pdf' }));
        fileInput.files = transfer.files;
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        resumeStatus = fileInput.files.length === 1 && fileInput.files[0].size === bytes.length ? 'attached' : 'uncertain';
        if (resumeStatus === 'uncertain') notes.push('Attachment could not be confirmed. Upload manually.');
      }
      if (currentJob() !== payload.jobUrl || !form.isConnected) throw new Error('Form changed');
      let missing = 0;
      for (const input of form.querySelectorAll('input, select, textarea')) {
        if (input.disabled || !(input.required || input.getAttribute('aria-required') === 'true')) continue;
        const empty = ['checkbox', 'radio'].includes(input.type) ? !input.checked
          : input.type === 'file' ? !input.files.length : !String(input.value || '').trim();
        if (empty || input.validity && !input.validity.valid) missing++;
      }
      if (missing) notes.push(`${missing} required or invalid field(s) still need manual attention.`);
      if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha, [data-sitekey]')) {
        notes.push('CAPTCHA or verification requires manual action.');
      }
      for (const [key, inputs] of Object.entries(groups)) {
        if (filled.includes(key) && (!inputs[0].isConnected || inputs[0].value !== values[key])) {
          notes.push(`The ${key} field changed after filling. Check it manually.`);
        }
      }
    } catch (_) {
      notes.push('The form changed or rejected a value. The attempt counts; inspect all fields and finish manually.');
      return result('failed', resumeStatus);
    }
    notes.push('Not submitted. Review every field, attachment, extra question and consent, then submit yourself. Upload acceptance is not verified.');
    return result(notes.length > 1 ? 'review-needed' : 'prepared', resumeStatus);
  };
});
