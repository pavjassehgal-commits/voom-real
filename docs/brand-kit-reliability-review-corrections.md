# Brand Kit reliability — independent-review corrections

27 November 2026. Same isolated branch `codex/brand-kit-reliability-1f619f2`, following
reviewed `b16aa866a0f4220fba962a828c1999aa5a35ca4c`. Production source base remains
`1f619f2e79773570169f8d5a3e7390a8835c9d00`. No hosted discovery or writes were needed
for this correction; baseline metadata is documented in the original report.

## Confirmed causes and corrections

| Finding | Cause | Correction |
|---|---|---|
| P1 destructive assets | Optional pre-read failed open to `[]`; onboarding cleanup swept storage based on that list even though the successful append carried saved images forward. The newest version alone also ignores historical/in-flight references. | Remove the optional onboarding/Brand-save pre-read. Verify references by owner and the actual saved/reused version. A failed asset read throws, never authorizes deletion. Defer all physical Brand Kit object removal, including unsaved-upload DELETE, until a safe collector exists. |
| P2 business context | `loadBrandContext` discarded business/profile query errors and returned null, indistinguishable from an incomplete profile. | Throw `BusinessContextReadError` for SQL/transport failures; preserve typed kit errors and successful missing-business null. Existing generation response mappings now return retryable 503 instead of profile-incomplete 409. |
| P2 Reel fallback | Legacy composition reads core business fields and its AI/deterministic viewer-copy stages cannot enforce arbitrary saved kit rules. | Read verified context before any fallback card update or AI call. Refuse fallback for any nonempty kit with `brand_restrictions_unavailable`, retryable 503. Empty-kit legacy businesses retain the fallback using verified core context. No model or real-video prompt changes. |
| Misleading provider error | Workflow advancement flattened every exception to `video_provider_unavailable`; start errors discarded the typed code. | Preserve typed kit/business unavailable codes and show the appropriate retry message. |
| Polling before timeout | Early typed 503 bypassed local hard-timeout enforcement. | Post/Reel typed-error paths run the existing local guarded timeout before returning an error; native polling checks the same timeout before service construction. Live jobs stay unchanged/retryable; expired jobs retain provider identity and become failed. No resubmission, credit reservation, attachment or publishing. |
| Empty history on failure | History reader swallowed SQL/transport errors and returned `[]`. | Throw typed unavailable error; Brand page renders an alert/retry link and no editable empty hub on that failure. |

### Asset retention contract

`removeUnreferencedBrandAssets` reads the exact saved/reused version under the owner filter.
Missing/unavailable/invalid references log cleanup-skipped. Successful verification logs
cleanup-deferred. It neither lists nor removes Storage objects. `removeBrandAssetObjects`
also performs no physical deletion, even for apparently unsaved uploads: a parallel wizard
may still be saving that path. The existing DELETE route retains authentication, owner-path
checks and saved-image rejection; unavailable reads return 503, and accepted unsaved removal
returns 202 with `cleanupDeferred:true`.

This deliberately retains replaced images, historical versions and abandoned/in-flight uploads.
A newest-row or even all-version read followed by Storage.remove has a check/delete race;
an age threshold alone cannot prove an old wizard has stopped using the object. A future
collector needs a reference/lease protocol shared by every saver. No such protocol or migration
is introduced here. Trade-off: unused storage accumulates; owner UI removals update current
references but do not mean permanent object erasure. No customer storage was accessed or changed.

### Regression evidence

The exact reviewed failure sequence is reproduced in synthetic local storage/SQL: an initial
asset read fails, subsequent reads succeed, a no-upload onboarding save carries logo/product
references forward, and no referenced object is deleted. The old optional read is removed from
onboarding entirely; the reader regression also proves failure is an exception, never `[]`.
Other tests protect historical/in-flight/foreign-owner objects during interleaved saves and
failed verification. Existing N01 retry/deduplication and concurrent version-collision tests remain.

Required business/profile and kit failures are tested in the reader and actual image/caption/Reel
routes. Reel refusal with saved banned words and mandatory rules occurs before any database
mutation, fallback AI or credit/provider call. A global HTTP fence prevents external requests.
Post/Reel/TikTok/YouTube polling tests cover both live and expired jobs under a context outage,
preserving provider identity and allowing only the existing timeout/card terminal transition.
Workflow advancement tests confirm accurate typed failure codes. History tests distinguish empty
from failed reads and check owner isolation. Browser rendering was not exercised live.

## Validation results

| Check | Result |
|---|---|
| Focused, 15 relevant suites | **320 pass / 0 fail / 0 skip** |
| New reliability suite | **17 pass**, included above (previously 10) |
| Full suite (`node --test --test-concurrency=4 tests/*.test.mjs`) | **2699 total: 2625 pass / 32 fail / 42 skip** |
| Unchanged Production failed-file comparison | **149 total: 117 pass / 32 fail**; exact same 32 (file, test-name) pairs |
| TypeScript (`npm run typecheck`) | **PASS** |
| Lint (`npm run lint`) | **0 errors / 16 existing warnings**, no new warnings |
| `git diff --check` | **PASS** |

The baseline comparison is a clean separate export at `1f619f2e79773570169f8d5a3e7390a8835c9d00`;
its Git status is clean. The exact 14 failed files were rerun against that source, not a second
complete baseline suite. The full candidate suite is not green. Remaining failures are inherited
source/config assertions, clock-sensitive trend fixtures, timing and browser-cleanup environment
failures. Skips include unavailable Chromium, intentional skips and absent local `main` history.
No live browser check is claimed. Final failure counts by file:

| File | Candidate failures also reproduced on baseline |
|---|---:|
| `tests/approval-state-lockdown.test.mjs` | 1 |
| `tests/email-automation-flows-pglite.test.mjs` | 1 |
| `tests/linkedin-marketing-plan-ui.test.mjs` | 2 |
| `tests/linkedin-production-release.test.mjs` | 1 |
| `tests/mara-launch-hardening.test.mjs` | 1 |
| `tests/native-plan-video-ui.test.mjs` | 4 |
| `tests/perf-regression.test.mjs` | 2 |
| `tests/product-truth-cleanup.test.mjs` | 1 |
| `tests/rendered-surface-cleanup.test.mjs` | 4 |
| `tests/trends-demo.test.mjs` | 4 |
| `tests/trends-gp-replenish.test.mjs` | 2 |
| `tests/trends-universal.test.mjs` | 6 |
| `tests/trends-wikidata-activation.test.mjs` | 2 |
| `tests/worker-schedules.test.mjs` | 1 |

## Known limitations for later content-quality work

These paths already bypass the canonical kit reader on Production and remain unchanged:

- `lib/campaign/server.ts` assembles core `brandContext` for `lib/campaign/planner.ts` and
  campaign intelligence. The campaign's email/social copy does not gain canonical kit restrictions.
- Legacy MARA context in `lib/mara/internal-data.ts` / `lib/mara/prompt.ts`, including email draft
  tools in `lib/mara/tools.ts`, uses core business context rather than the canonical kit reader.
- `lib/email/branded/brand.ts` assembles email identity/presentation from businesses and
  `voom_email_brands`; Brand Kit restrictions are not a comprehensive email generation boundary.
- `lib/voom/workflow/media.ts` image production uses its stored visual brief directly; it does
  not reload current restrictions at provider submission. Workflow copy can carry kit context,
  but that does not make this image boundary independently kit-aware.
- `app/api/mara/media/[id]/route.ts` submits stored prompts directly without reloading the kit.

Do not interpret this candidate as comprehensive Brand Kit enforcement across all VOOM content.
No campaign/email/plan-item image redesign, Memory integration, approval or publishing change
was made. The new Reel refusal is intentionally conservative: fallback stays unavailable for a
nonempty kit until the configured real video path is available or a separate safe fallback is built.

## Migration and review gates

No new SQL migration, hosted operation or rollback script is required. Existing 0075 owner RLS,
append-only versions and uniqueness remain unchanged. Application rollback would restore the
unsafe cleanup behavior, so it is not a safe mitigation for this issue. This task is local-only.
Real multi-session PostgreSQL/Storage contention and browser journeys remain independent
validation gates; PGlite barriers/interleavings are not real multi-session PostgreSQL testing.
Storage deletion safety here comes from refusing physical deletion, not claiming atomic Storage/SQL.

## Exact files changed in this correction

- `ARCHITECTURE.md`
- `DECISIONS.md`
- `app/api/brand/assets/route.ts`
- `app/api/posts/[id]/generation/route.ts`
- `app/api/reels/produce/[actionId]/route.ts`
- `app/api/social-drafts/[id]/generation/route.ts`
- `app/app/(shell)/brand/page.tsx`
- `components/voom/brand/BrandHub.tsx`
- `docs/brand-kit-reliability-review.md`
- `handover/next-session.md`
- `lib/brand/actions.ts`
- `lib/brand/asset-storage.ts`
- `lib/brand/context.ts`
- `lib/brand/read.ts`
- `lib/mara/video-service.ts`
- `lib/voom/mutations.ts`
- `lib/voom/workflow/actions-server.ts`
- `lib/voom/workflow/media.ts`
- `tests/brand-assets.test.mjs`
- `tests/brand-kit-reliability.test.mjs`
- `docs/brand-kit-reliability-review-corrections.md`
