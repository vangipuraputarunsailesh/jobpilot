# AI Usage Report (JobPilot)

Date: 2026-04-18
Scope: static analysis of `app.py` and `ai_engine.py`

## 1) Where AI is used

The app calls Claude for these user-facing tasks:

1. Resume generation from free-text profile
- Endpoint: `/api/generate-resume`
- Function: `generate_resume()`
- Max output tokens: 4000

2. Resume tailoring to a job description
- Endpoint: `/api/tailor`
- Function: `tailor_resume()`
- Max output tokens: 4000

3. ATS scoring (match analysis)
- Endpoint: `/api/score`
- Function: `score_ats()`
- Max output tokens: 900

4. Open-ended edit chat
- Endpoint: `/api/chat-instruction`
- Function: `apply_chat_instruction()`
- Max output tokens: 3200

5. Improve one selected line
- Endpoint: `/api/improve-line`
- Function: `improve_line()`
- Max output tokens: 200

6. Certification suggestions
- Endpoint: `/api/suggest-certs`
- Function: `suggest_certifications()`
- Max output tokens: 1000

7. Screening question answering
- Endpoint: `/api/answer`
- Function: `answer_screening_question()`
- Max output tokens: 400

## 2) Current usage counters in app

`/api/usage` currently tracks:
- `claude_calls`
- `total_tailors`
- `total_ats_scores`
- `total_ai_chats`

It does **not** currently track per-task totals for:
- `/api/improve-line`
- `/api/suggest-certs`
- `/api/answer`
- `/api/generate-resume` total count (only increments `claude_calls`)

Result: exact "which task costs most" cannot be measured precisely from current telemetry.

## 3) Estimated token consumption by task

Note: these are engineering estimates, not exact billing numbers.

Approximation used:
- ~1 token ~= 4 characters
- Input includes prompt text + inserted resume/JD/history
- Output capped by each call's `max_tokens`

### Estimated per-call ranges

1. `/api/score` (`score_ats`)
- Input: medium/high (resume up to 6000 chars + JD up to 3000 chars + instructions)
- Output cap: 900
- Estimated total: ~2.5k to ~4k tokens/call

2. `/api/tailor` (`tailor_resume`)
- Input: high (resume up to 6000 + JD up to 2500 + long rules)
- Output cap: 4000
- Estimated total: ~4k to ~7k tokens/call

3. `/api/chat-instruction` (`apply_chat_instruction`)
- Input: potentially very high (full current resume + full chat history + system prompt + JD)
- Output cap: 3200
- Estimated total: ~3k to ~8k+ tokens/call (can spike with long chat history)

4. `/api/generate-resume` (`generate_resume`)
- Input: low/medium (user description + optional JD)
- Output cap: 4000
- Estimated total: ~2.5k to ~6k tokens/call

5. `/api/improve-line` (`improve_line`)
- Input: low
- Output cap: 200
- Estimated total: ~300 to ~900 tokens/call

6. `/api/suggest-certs` (`suggest_certifications`)
- Input: medium
- Output cap: 1000
- Estimated total: ~1.8k to ~3.5k tokens/call

7. `/api/answer` (`answer_screening_question`)
- Input: medium
- Output cap: 400
- Estimated total: ~900 to ~2k tokens/call

## 4) Which task likely consumes the most

### By tokens per single call (worst case)
1. `tailor_resume` and `apply_chat_instruction` are highest.
2. `generate_resume` is next.
3. `score_ats` is moderate per call.

### By total session consumption (most likely in practice)
- **`/api/score` can become the largest aggregate consumer** because ATS scoring is now auto-triggered after tailoring and during editing.
- Even with lower per-call cost than tailoring/chat, frequent repeated scoring can dominate total token spend.

So the top spender depends on behavior:
- Heavy editing session: `score_ats` likely highest total.
- Fewer edits, long chat iterations: `chat-instruction` may dominate.

## 5) Consumption-rate model you can use now

Because exact token counters are not yet stored, use this operational estimate:

- Estimated tokens/min for a task ~= `calls_per_min * avg_tokens_per_call`

Example:
- If auto-score triggers 8 times/min and avg score call ~3k tokens,
- ATS score burn ~= ~24k tokens/min.

## 6) Suggestions to limit token usage (priority order)

### High impact

1. Add real token telemetry from Anthropic response usage
- Store per endpoint:
  - `input_tokens`
  - `output_tokens`
  - `cache_creation_input_tokens` / `cache_read_input_tokens` (if used)
- Then rank exact cost by feature.

2. Cap and summarize chat history in `/api/chat-instruction`
- Keep last N turns (for example 6-10 messages).
- Summarize older context into a short memory block.
- This directly reduces the most variable token spikes.

3. Add ATS score cooldown + change threshold
- Only trigger auto-score if content changed meaningfully (not every minor keystroke).
- Add a minimum interval (for example 5-10s under active typing).
- Skip if current score already >= target and changes are tiny.

4. Shorten scoring input
- Send compact resume/JD representation for scoring:
  - key sections only
  - deduplicated skill list
  - truncated bullet text
- Keep full text for final check only.

### Medium impact

5. Reduce `max_tokens` defaults where practical
- `chat-instruction`: 3200 -> consider 1200-2000 for most edits.
- `tailor_resume`: 4000 -> consider 2500-3200 with stricter structure.
- `generate_resume`: 4000 -> consider 2800-3200 unless long resume requested.

6. Add fast-path local transforms before AI call
- For formatting-only edits (spacing, section reorder, bullet symbol cleanup), do deterministic local edits instead of Claude calls.

7. Prevent duplicate scoring calls from multiple UI flows
- Coalesce concurrent score requests into one in-flight call per job.

### Low effort hygiene

8. Expand `/api/usage` counters for all AI endpoints
- Add totals for: `generate_resume`, `improve_line`, `suggest_certs`, `answer`.

9. Add per-feature cost dashboard in Usage panel
- Show calls + tokens by feature, top consumer in current session.

## 7) Recommended immediate plan

1. Instrument exact token usage per endpoint first.
2. Limit chat history size and summarize old turns.
3. Tighten auto-score frequency and meaningful-change checks.
4. Lower output caps where quality is unaffected.

This sequence gives fastest cost reduction while preserving user experience.
