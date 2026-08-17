# Local scenario campaign: scenarios 11–20

Date: 2026-08-17

Model: `deepseek-v4-flash`

Environment: local Next.js server with isolated per-case app data

Scope: the ten scenarios not covered by the first campaign

## Outcome

All ten scenarios were run through the real product → design → architecture → engineering → QA → acceptance pipeline. Three reached complete delivery. Seven were stopped at a bounded failure after producing enough evidence to improve the platform; none were counted as delivered merely because code existed.

| Scenario | Run | Outcome | Evidence / platform action |
| --- | --- | --- | --- |
| Habit tracker | `YWX1Cjr2KvtSD_ET` | Bounded | Functional QA reached 4/4, but the old 10-minute runner timeout aborted before acceptance. Default campaign timeout increased to 20 minutes. |
| Flashcards | `M1-ypkaC55KA7MH8` | Passed | 399s, 12 dispatches, 4 QA rounds; flip visibility, mastery state and filtering covered. |
| Recipe collection | `O-qSTXcLmKaYWseo` | Bounded | QA scoped assertions to the `全部` filter button and repeatedly blamed implementation. Added a blocking scoped-target role gate. |
| Workout log | `XSl0je0nS9wEeg8W` | Bounded | QA repeated an unpromised `aria-invalid` assertion because Ida's concrete reason was not forwarded. QA retries now receive the triage reason and all previous failure facts. |
| CRM | `DIaKw8lmHlujaw0I` | Bounded | Functional QA passed 4/4, but the objective delivery gate repeatedly found no heading hierarchy. Objective delivery failures now route directly to engineering with exact evidence. |
| Leave approval | `YmvPoPxOGeTIYP9e` | Bounded | QA invented `确认通过/确认驳回` actions and treated a button as a region. Invented click/fill targets are now blocking test-plan failures. |
| Expense tracker | `7cQUvALyBl8wYEam` | Bounded | QA kept mixing input, aggregate display and filtered-list scopes. The run was stopped after repeated plan churn; existing facts-forwarding and target-role gates now expose these errors before implementation repair. |
| Sales dashboard | `uEhYm8L4ioGUpMge` | Passed | 320s, 8 dispatches, 3 QA rounds; monthly trend, revenue and Top 5 coverage passed. |
| Weekly report | `6a2sFpo71YbQlZ2p` | Bounded | Every round failed at copy success because jsdom lacked `navigator.clipboard`. Added an isolated async Clipboard API shim and regression test. |
| BMI calculator | `j1gEhXzDKypwoYqm` | Passed | 362s, 10 dispatches, 4 QA rounds; formula, advice and history coverage passed. |

Campaign result: **3 complete deliveries, 7 bounded evidence-producing failures, 10/10 scenarios executed**.

## Platform improvements from this campaign

1. The scenario harness now contains all 20 representative scenarios and allows 20 minutes for a full repair/QA/acceptance loop.
2. Scoped assertions are rejected when their target is an observed button or input instead of a content region.
3. Click/fill actions with deterministically invented targets are rejected before browser execution.
4. QA retry prompts include Ida's concrete triage reason and the complete prior failure facts.
5. Objective delivery-gate failures route directly to engineering instead of asking Piper to guess or sending the same issue back to design.
6. The jsdom QA host implements an isolated asynchronous Clipboard API so copy/export flows can be tested without touching the system clipboard.

## Interpretation

The pass rate is intentionally not presented as 10/10. The campaign's purpose is to make weak spots observable and turn repeated failures into platform guardrails. A bounded result means the generated application or its QA plan did not complete the entire evidence chain within the run; it is not silently promoted to delivery.
