# JobsPilot Review Companion — BETA (Chrome / Edge)

**Review-first beta, not automatic submission or unattended auto-apply. It never submits or clicks a submit button.**
JobsPilot's website uses your selected model/provider to recommend one of your three fixed resumes and export a bundle you review. This extension has no model, API key, credential vault, or networking client. It deterministically fills a few basic fields and attaches exactly the PDF in that bundle. An import, opened job, or prepared form is **not a completed application**.

## Install and use

1. In Chrome open `chrome://extensions`, or in Edge `edge://extensions`. Enable **Developer mode**, choose **Load unpacked**, and select this `companion` folder. No build, store account or dependency installation is needed.
2. On JobsPilot, review the selected resume, candidate details, rationale and gaps; download the reviewed application JSON bundle.
3. Open the supported job **manually** and navigate to its application form. Finish any login first. Pin/click this extension on that tab.
4. Import the JSON file. Verify its displayed identity and selected PDF. Bundles are held **only in popup memory**, not stored. Closing the popup (including to open its job link) loses the import; reopen and import again.
5. Check the consent box, then click **Prepare for my review**. File attachment may immediately upload your PDF to the ATS, even before you submit. Only consent if you accept that transfer.
6. Inspect every field and the actual attached resume. Answer remaining questions and CAPTCHA yourself, then use the site's own submit button yourself. The extension does not verify upload acceptance, application delivery, or success.

`prepared` means the supported fill routine returned without detected outstanding problems, **not** that the application is complete. `review-needed`, `failed`, or a lingering `reserved` result requires manual inspection. Partial changes may already exist after failure. Do not rely on the extension to count submissions.

## Supported scope

- Top-level HTTPS `jobs.lever.co/<company>/<UUID>` and `jobs.eu.lever.co/<company>/<UUID>`, optionally `/apply` and a trailing slash.
- Top-level HTTPS `boards.greenhouse.io/<company>/jobs/<digits>` and `job-boards.greenhouse.io/<company>/jobs/<digits>`. These host aliases share one canonical job identity.
- Tracking query parameters and fragments are stripped. Other hosts (including custom domains and Greenhouse EU hosts), ports, path formats, redirects to a different job, and embedded/iframe forms are not supported.
- Only a single recognized application form and an unambiguous resume input are supported. An explicit form action must resolve to the same origin and job identity; API-style or other action endpoints are rejected. ATS markup changes can make a supported URL's form unsupported; continue manually.
- Lever: form `application-form`, file input named `resume`; basic `name`, `email`, `phone`, `urls[LinkedIn]`, `urls[Website]` inputs.
- Greenhouse: form `application_form` or `application-form`; file input `id=resume` and name `resume` or `job_application[resume]`; basic `first_name`, `last_name`, `email`, `phone`, `linkedin`, `website` IDs with corresponding names (or `job_application[...]` names).
- Existing nonempty values/files are **not replaced**. Ambiguous or unexpected labels are skipped. Unknown fields, work authorization, sponsorship, demographics, disability, legal attestations, salary, consent, checkboxes, radios, login and CAPTCHA are **always manual**. Missing required fields detected in the current DOM are reported; server-side/conditional requirements may only appear later.

## Limits and privacy

The worker reserves an attempt in `chrome.storage.local` **before** injecting into the page. A serialized queue prevents concurrent popup requests exceeding **20 fill attempts per UTC day per extension installation**. Failed, partial, interrupted and uncertain attempts count. Canonical job URLs are retained and blocked from repeat attempts permanently across reloads, reimports and later days. Importing alone does not reserve an attempt.

History stores only the canonical job URL, attempt timestamp and state. The popup shows the most recent 30 records. Resume bytes, candidate details, selection rationale and keys are never persisted by the extension. Downloaded bundles **do contain personal information and your PDF**: keep them private and delete downloads yourself when no longer needed. The exact PDF is passed transiently to the active job page for attachment; the ATS controls subsequent uploads and retention.

Clock rollback against the last stored observation blocks filling until that time is reached. Corrupt history, storage failures and the 10,000-record history ceiling fail closed. The cap is **not global, cross-device, tamper-proof or resistant to clearing extension data, reinstalling, another browser profile, or advancing the system clock**. No quota-reset or retry control is supplied. This is a local assistive guardrail, not an enforcement service.

Permissions: `activeTab`, `scripting`, `storage` only. No broad host permissions, content scripts, external messaging, telemetry, or model calls. Each fill requires fresh consent in the popup and a matching active tab. System/light/dark themes are available; the theme choice lasts for the current popup only.

## Bundle contract (version 1)

```json
{
  "version": 1,
  "createdAt": "2026-09-30T12:00:00.000Z",
  "job": {
    "url": "https://job-boards.greenhouse.io/example/jobs/123",
    "title": "Software Engineer",
    "company": "Example"
  },
  "candidate": {
    "firstName": "Alex",
    "lastName": "Example",
    "email": "alex@example.com",
    "phone": "",
    "linkedin": "",
    "website": ""
  },
  "resume": {
    "id": "resume-1",
    "name": "Alex.pdf",
    "mimeType": "application/pdf",
    "base64": "<standard padded base64 of the exact selected PDF, no data-URL prefix>"
  },
  "selection": {
    "reason": "Reviewed role and resume alignment.",
    "gaps": ["Answer any additional employer questions manually."]
  }
}
```

All shown keys are required; extra keys are discarded, never injected. `createdAt` must be a real UTC ISO time, not future-dated or older than 30 days. Maximum UTF-8 JSON size: 3 MiB; decoded PDF: 2 MiB, starting with `%PDF-` (a signature check, **not** PDF sanitization or malware scanning). Resume IDs: 1–100 ASCII letters/digits/underscores/hyphens; filename: 1–160 characters, sanitized to a basename ending `.pdf`.

Names: 1–100 characters each; email: 1–254; phone: 0–40 (digits, spaces, `+().-`); LinkedIn/website: 0–2048, empty or HTTPS without credentials/custom ports. LinkedIn must use `linkedin.com/in/<profile>` or `www.linkedin.com/in/<profile>`. Job title/company: 1–200; job URL: at most 2048. Rationale: 1–4000; gaps: at most 20 nonempty strings of at most 300 characters. Text is trimmed and control characters (including newlines) are rejected. Optional candidate values must still be present as empty strings.

## APIs and tests

`core.js` exposes `JobsPilotCompanion` in the extension and CommonJS exports in Node: `validateBundle(input, now)`, `normalizeJobUrl(url)`, `validateLedger(ledger, now)`, `reserveAttempt(ledger, url, now)`, `createQuotaManager({get, set}, clock)`, and constants. Pure helpers never write storage. The queue manager is instantiated once by the service worker.

Worker messages are private to `popup.html`: `{type:"validate",bundle}`, `{type:"status"}`, `{type:"fill",bundle,consent:true}`. Responses are `{ok:true,data}` or `{ok:false,error}`. Fill arguments do not include model metadata or selection text. No tab IDs, scripts or arbitrary actions may be provided.

Run from the repository root with a modern Node version:

```powershell
node --test scripts\test-companion.cjs
```

Dependency-free tests use DOM and Chrome API stubs. They do not launch browsers or contact ATS providers; real-world ATS compatibility and upload acceptance still require manual verification.
