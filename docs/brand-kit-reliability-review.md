# Brand Kit reliability review — N01 + N02

Local candidate, 27 November 2026. No push, merge, deployment, hosted migration,
customer-record access, paid generation or live publishing. Independent review is the next gate.

## Verified baseline

Read-only authenticated management UI inspection established:

| Resource | Verified metadata |
|---|---|
| Vercel project | `voom-real`, Production, Ready |
| Deployment | `dpl_5Xr4j3aV94sPKdAUgxTY6pqrfwv3` |
| Production domains | `voom.today`, `voom-real.vercel.app` |
| Git source | `main`, `1f619f2e79773570169f8d5a3e7390a8835c9d00` |
| Supabase Production identity | `spqkkbznzxxkdtexyqzh` (protected; no SQL executed) |
| Migration ledger | 63 entries: 0001–0051, 0055–0059, 0061, 0065, 0069, 0074, 0075, 0078, 0080 |
| Brand Kit / approval migrations | 0075 and 0080 present; 0079 absent |

The dashboard dates show “Unknown”. This verifies ledger membership, not migration checksums,
function definitions, or schema drift. No business/customer rows were inspected.

Fresh independent local Git checkout: `.worktrees/brand-kit-reliability-1f619f2`, branch
`codex/brand-kit-reliability-1f619f2`, starting exactly at the verified Production SHA.
The local object source was the existing approval checkout's Git directory, cloned without
hard links; none of that checkout's working files or uncommitted changes were copied/edited.
Only installed dependency packages are reused by a node_modules link. No Memory source was
integrated or changed. The original dirty checkout and other branches remain untouched.

## Confirmed causes and fixes

### N01 — required persistence was best-effort

`saveOnboarding` marked `businesses.onboarding_completed` true before appending the richer
`brand_kits` snapshot. `appendBrandKitVersion` returned null on a failed read/insert, and
onboarding ignored that result. Basic information therefore persisted while restrictions,
banned terms, confirmed facts, brief and other richer answers could be lost behind success.

The existing profile/business persistence remains in place. The kit append is now required:

1. Persist core fields, without prematurely setting onboarding completion.
2. Append/confirm the kit snapshot, carrying unowned fields forward as before.
3. Only then confirm the owner-scoped completion update and report success.

Each required failure returns `ok:false` with the actual partial-success stage and retry
instructions. The existing client keeps the wizard answers and displays `onboardError`.
No wizard redesign was needed. Existing businesses retain their completion flag on failed
re-onboarding, rather than being made newly incomplete.

Onboarding opts into semantic snapshot reuse: an identical latest answers/brief/assets row
is returned instead of appended. JSON object order is ignored; array order is preserved.
This handles repeat clicks and a committed write whose response was lost. The existing
(owner, version) unique constraint arbitrates concurrent append collisions. Up to three
attempts re-read and re-merge after 23505, preserving fields owned by other sections. Other
save consumers retain their existing no-change version behavior.

Persistence remains staged, not one cross-table transaction. A partial failure deliberately
preserves the confirmed core fields and reports that state. Concurrent overlapping fields
still use the existing last-save-wins contract; this is not full-form optimistic locking.
Core/kit snapshots across two concurrent full onboarding submissions are not made atomic.

### N02 — database errors masqueraded as an empty kit

`loadBrandKit` previously returned `EMPTY_BRAND_KIT` for SQL/transport failures as well as
successful reads with no row. Current generation consumers could omit saved restrictions
and proceed without any unavailable-state indication.

The canonical reader now throws `BrandKitReadError` (`brand_kit_unavailable`) on technical
read failure. Only a successful read with no kit returns the existing empty value. Existing
successful parsing, caps, prompts and payloads are unchanged. Diagnostics do not log query
contents or raw database exceptions at this boundary.

| Current consumer | Safety boundary |
|---|---|
| `loadBrandContext` → `loadPostBrandContext` | Typed read error propagates instead of becoming empty context |
| Post image `/api/posts/[id]/generate` | Retryable 503 before AI/media requests, generation rows or credit reservation |
| Existing-media captions `/api/posts/[id]/suggest` | Retryable 503 before vision/caption requests |
| `runOwnerWorkflow` (Plan, replenishment, scheduled coordinator) | Read throws before generation/workflow writes; `/api/plan` exposes retryable 503 |
| Shared `buildVideoService` / `startPostStudioVideo` | Failed read blocks starting new paid video work; understandable 503 |
| Post video status `/api/posts/[id]/generation` | Typed 503; never substitute an unbranded service |
| Reel production/status `/api/reels/produce/[actionId]` | Typed 503; no deterministic fallback after a failed kit read |
| Native TikTok/YouTube generation/status | Shared service propagates error; routes return typed retryable 503 |
| Workflow video advancement | Shared service failure prevents advancement using unavailable brand context |

The shared video context read precedes provider configuration fallback, so an unavailable
provider cannot mask a kit read failure and route into legacy Reel generation. Successful
unconfigured-provider fallback, successful generation,
provider selection and prompt construction are unchanged. This fix enforces current kit-reading
paths; it does not redesign legacy generation paths that never consumed the kit. Brand Hub
history display and the legacy Settings best-effort write are outside N01/N02 scope.

## Validation

| Check | Result |
|---|---|
| Focused Brand Kit + Post Studio + native video + Marketing Plan suites (13 files) | **288 pass / 0 fail** |
| Website persistence/optional-failure onboarding checks | **3 pass / 0 fail** |
| New offline reliability suite alone (includes provider-fallback check) | **10 pass / 0 fail** (included in focused 288) |
| Full suite, `node --test --test-concurrency=4 tests/*.test.mjs` | **2692 total: 2618 pass / 32 fail / 42 skipped** |
| Untouched Production comparison of all 14 failing files | **149 total: 116 pass / 33 fail**; all 32 final candidate failures reproduced |
| `npm run typecheck` | **PASS**, exit 0 |
| `npm run lint` | **PASS**, exit 0: zero errors / 16 warnings |
| Untouched Production lint | Zero errors / same 16 warnings (same file/line/rule diagnostics) |
| `git diff --check` | **PASS** |

The initial unrestricted `npm test` run was 2615 pass / 35 fail / 42 skipped. Three failures
were outdated onboarding website mocks that had never supported Brand Kit persistence;
those mocks now model a successful kit write and separate completion update, and all three
checks pass. The final whole-suite run above includes those corrections. No application fix
was made for unrelated inherited failures. The baseline comparison ran the exact failed-file
set, **not a second complete baseline suite**. One additional timing assertion (coordinator
read overlap) failed only in the baseline comparison; timing-sensitive performance failures
vary with load. There are no final candidate-only failing test names.

The 42 skips include unavailable Chromium/browser startup, a missing local `main` ref in the
isolated checkout, and intentional skips. No live UI test is claimed. The full suite is not green.
Remaining inherited/environment failures by file:

| File | Final failures |
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

These cover existing source guards/config expectations, clock-sensitive trend fixtures,
performance timing and browser cleanup/environment support. Exact final failure names:

- `tests/approval-state-lockdown.test.mjs`: every cron worker uses the constant-time Bearer check
- `tests/email-automation-flows-pglite.test.mjs`: 7. migrations 0040–0044 remain additive and owner-scoped
- `tests/linkedin-marketing-plan-ui.test.mjs`: Marketing Plan shows disconnected LinkedIn text and opens the same draft for explicit review
- `tests/linkedin-marketing-plan-ui.test.mjs`: LinkedIn draft deep link loads saved text and future time without implicitly granting consent
- `tests/linkedin-production-release.test.mjs`: release preserves both production schedules and adds exactly one bounded LinkedIn schedule
- `tests/mara-launch-hardening.test.mjs`: PR branch opts out of automatic shared-credential Previews without altering Production, TikTok or schedules
- `tests/native-plan-video-ui.test.mjs`: tiktok: real Generate control sends exact UUID; pending disables; completion shows private preview and review
- `tests/native-plan-video-ui.test.mjs`: youtube: real Generate control sends exact UUID; pending disables; completion shows private preview and review
- `tests/native-plan-video-ui.test.mjs`: network-ambiguous retry retains the click token, never invents a second operation
- `tests/native-plan-video-ui.test.mjs`: Free and provider-owned drafts explain disabled generation; long-form and LinkedIn have no new generation control
- `tests/perf-regression.test.mjs`: workflow snapshot reads and signed URLs overlap the rest of the request
- `tests/perf-regression.test.mjs`: every stored visual is signed in ONE batched storage round trip
- `tests/product-truth-cleanup.test.mjs`: onboarding offers exactly the four supported V1 channels, from the canonical vocabulary
- `tests/rendered-surface-cleanup.test.mjs`: normal completion: the browser exits and its profile and page folder are removed
- `tests/rendered-surface-cleanup.test.mjs`: a scenario that throws still cleans up everything
- `tests/rendered-surface-cleanup.test.mjs`: folders of other processes are never touched
- `tests/rendered-surface-cleanup.test.mjs`: an abandoned run (a hung scenario hitting a timeout) is cleaned up when its process exits
- `tests/trends-demo.test.mjs`: end to end: real evidence becomes a stored, readable, cited recommendation for the test business
- `tests/trends-demo.test.mjs`: MARA: flag off by default; with evidence, the real prompt and payload carry only the verified facts
- `tests/trends-demo.test.mjs`: a provider passed to the demo receives exactly one MARA request, and its output is validated and claim-checked
- `tests/trends-demo.test.mjs`: a reply that fails MARA's output validation is reported, not used
- `tests/trends-gp-replenish.test.mjs`: the production loader returns the context only while its observation is usable
- `tests/trends-gp-replenish.test.mjs`: the deterministic fixture passes MARA's real grounding and claim checks for every planned format
- `tests/trends-universal.test.mjs`: approved sources are collected once, rate-limited, and stored through the governed RPC
- `tests/trends-universal.test.mjs`: Replenish evidence is tailored across unrelated industries (restaurant, fashion, automotive, beauty, home, pets)
- `tests/trends-universal.test.mjs`: every fact is written from stored, attributed data and carries the right caveats
- `tests/trends-universal.test.mjs`: invalidated or expired evidence disappears from matching immediately; no evidence means evergreen
- `tests/trends-universal.test.mjs`: matched ideas pass MARA's real grounding and claim checks for every industry's Reel/video slot
- `tests/trends-universal.test.mjs`: Wikipedia attention can never be presented as Instagram, TikTok, search or general popularity
- `tests/trends-wikidata-activation.test.mjs`: before activation the source stays disabled: collection stores nothing
- `tests/trends-wikidata-activation.test.mjs`: after activation the first collection stores and serves the two real event records
- `tests/worker-schedules.test.mjs`: PR branch cannot auto-deploy and all existing Vercel settings remain unchanged

New offline SQL-backed tests cover success; kit failure and retry; completion failure;
ambiguous committed writes; unavailable newest versions; concurrent section collisions;
identical concurrent retries with JSONB ordering; absent versus unavailable kits; restrictions
and owner isolation; real image/caption/Plan route failures; and shared video-service failure
before credits/providers. Existing 0075/RLS tests exercise authenticated owner isolation.
Concurrency uses embedded PGlite with barriers and real unique constraints: **not real
multi-session PostgreSQL contention testing**. No hosted test database was used.

The new test file globally blocks outbound HTTP and substitutes authentication/database
clients. Route tests additionally count zero requests. The existing Post Studio static test
permits this named offline route suite only with its network fence and auth hooks present;
direct provider imports remain forbidden. Test keys are obvious synthetic decoys.

## Migration, rollout and remaining risks

- **No new migration or rollback SQL required.** Existing 0075 supplies the table, owner RLS
  and unique owner/version constraint; its Production ledger entry was verified.
- No SQL, approval, consent, scheduling, queue, provider/model or publishing changes.
- If 0075 is missing/unavailable in another environment, generation now intentionally fails
  closed rather than treating that infrastructure failure as a legitimate missing kit.
- A prolonged Brand Kit outage also pauses video status advancement through the shared
  service. Existing jobs are retained; retry after access recovers. No new provider job is started.
- Snapshot retry reuse compares the latest snapshot; a genuinely different later owner edit
  followed by resubmission creates a new version as intended. Three colliding attempts can
  still return an explicit retryable save failure under sustained contention.
- Browser fault/retry journeys and real concurrent PostgreSQL sessions have not been run for
  this candidate. Review those in a separately authorized, isolated environment before release.
- Production schema checksums and live data correctness were not inspected. Read-only baseline
  discovery was metadata only, and no hosted resource was modified.

## Exact files

- `ARCHITECTURE.md`
- `DECISIONS.md`
- `app/api/plan/route.ts`
- `app/api/posts/[id]/generate/route.ts`
- `app/api/posts/[id]/generation/route.ts`
- `app/api/posts/[id]/suggest/route.ts`
- `app/api/reels/produce/[actionId]/route.ts`
- `app/api/social-drafts/[id]/generation/route.ts`
- `handover/next-session.md`
- `lib/brand/actions.ts`
- `lib/brand/context.ts`
- `lib/brand/versions.ts`
- `lib/mara/video-service.ts`
- `lib/voom/mutations.ts`
- `lib/voom/workflow/service.ts`
- `tests/brand-assets.test.mjs`
- `tests/brand-kit-context.test.mjs`
- `tests/onboarding-v2.test.mjs`
- `tests/post-studio.test.mjs`
- `tests/product-truth-cleanup.test.mjs`
- `tests/settings-brand-description.test.mjs`
- `docs/brand-kit-reliability-review.md`
- `tests/brand-kit-reliability.test.mjs`
