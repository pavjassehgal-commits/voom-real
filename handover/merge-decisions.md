# Merge decisions ledger: where our code won, where main's code won

One row per place where Gurnoor's branch and the teammate's `main` disagreed and someone had to
choose. Use it when something stops working after a merge: find the file, see whose version is
live and why, and what the other side wanted.

Vocabulary:
- **Ours** = Gurnoor's branch (`gurnoor-dev`, since 2026-11-01 `merge-main-2026-10-31`).
- **Main's** = the teammate's work on GitHub `main`.
- **Both** = one version that keeps both sides' behaviour.
- **Ours, reworded for main** = our behaviour, written to fit main's structure or tests.

The full reasoning behind each merge lives in `DECISIONS.md` (dated entries) and, for the first
merge, `handover/merge-plan.md`. This file is the index: short and by file.

---

## Merge 1: `main` at `ea1676b` into our branch, 2026-11-01 (26 conflicts)

Context: 20 days apart. Main had rebuilt every screen in the Figma redesign, added LinkedIn,
native TikTok/Shorts videos, YouTube uploads, cost tracking and automation safety. We had Brand
Kit v2 (slices 1 to 7), the 11-screen onboarding, forgot-password, Google sign-in, delete post.

| Area / file | Winner | What the other side wanted | Why this way |
|---|---|---|---|
| Onboarding wizard `components/voom/onboarding/OnboardingWizard.tsx` | **Ours** (whole file) | Main restyled its old 7-screen wizard | Different flow on a different data model; blending line by line impossible. Main's look came later in Phase C (below). |
| `components/voom/onboarding/AnalyzingScreen.tsx` | **Ours** restored | Main had deleted it (git dropped it silently because we had not touched it) | Our wizard imported it. Deleted for real in Phase C (2026-11-02) when SetupComplete replaced it. |
| `app/app/onboarding/page.tsx` | **Both** | Main's wrapper; our `maxDuration = 60` for the website read | Independent. In Phase C the server redirect for finished accounts was dropped for main's client-side bypass. |
| Onboarding state `lib/voom/store.tsx`, `lib/voom/types.ts`, `lib/voom/onboardingData.ts` | **Both** | Main: plan videos, channels. Ours: website read, colours, voice samples, kit fields | Both sides changed the same objects; typecheck caught the misses. |
| Navigation `components/voom/shell/nav.ts` | **Main's, plus our Brand entry** | Main's redesigned list has no Brand page | Brand sits right after Today in "Workspace", heart icon (Gurnoor's choice). |
| Settings `app/app/(shell)/settings/page.tsx` | **Main's, with our link card** | Main's redesign brought back a brand form in Settings | Slice 3 rule: the Brand page is the one place to edit the brand; that form let fields be edited that the save never sent. |
| Connections `app/app/(shell)/connections/page.tsx` | **Main's** | Ours had the Instagram status truthfulness fix | Re-checked: main's version is already truthful. |
| Login and signup `app/login/*`, `app/signup/SignupForm.tsx` | **Main's frame, our features** | Main's AuthFrame had no Google button, no "Forgot password?" | Both features kept inside main's frame. |
| Create modal, Plan workspace | **Main's, plus ours** | Main's redesign and native videos | Our "Existing content" source switch and "What is this post for?" line added back. |
| Post routes `app/api/posts/[id]/*` | **Both** | Main: TikTok/YouTube drafts, cost tracking. Ours: delete, cancel approval, brand kit extras, vision "seen" path, purpose | Neither replaces the other. |
| Generate route: when the caption is written | **Ours** | Main writes the caption to the draft before the visual exists | Our 2026-10-17 truthfulness fix: caption only after the visual exists. Main's cost tracking added to both AI calls. |
| Plan page outcomes | **Ours** | Main hides the "no social channel selected" outcome | We show every outcome. |
| AI config and provider `lib/ai/*` | **Both** | Main: usage/cost tracking, AI timeout. Ours: vision provider and `AI_VISION_*` | Our vision calls now also go through main's usage recorder. |
| Workflow service and prompts `lib/voom/workflow/*`, `lib/post/server-data.ts` | **Both** | Main: cadence anchor, creatable dates, native video. Ours: brand kit block in every prompt | Independent additions in the same functions. |
| Migration number | **Ours renumbered: 0059 → 0075** | Main's branch `fix/automation-mode-normalization` already used 0071 and 0072 | Gurnoor picked 0075 to leave 0073 and 0074 free; renumbering twice was the cost to avoid. |
| Ten migration-list tests | **Both** | Each side listed its own newest migration | Full list of both sides' files, ceiling 0075. |
| `package-lock.json` | **Main's, then regenerated** | | Never hand-edit the lock file; `npm install` regenerated it with our two dependencies. |
| `AGENTS.md` | **Ours** | Main's copy was only the Next.js notice | Our working rules must survive. |
| Wizard footer and haptic warning | **Ours, reworded for main** | Main's tests expected a `<footer data-toast-clearance>` and a "warning" haptic on a blocked Continue | Adopted into our wizard; without the footer `tests/motion-system.test.mjs` hung the whole suite. |
| 8 of our tests, 7 of main's | **Re-pointed, none deleted** | Each described the pre-merge shape of the other side | They now state what the merged screens do. Two visual ones parked as `todo` until Phase C. |

## Phase C: our screens take main's look, 2026-11-02 and 11-04 (no git conflicts; design choices)

| Area | Winner | Note |
|---|---|---|
| Brand page header and cards | **Main's** `PageHeader`, `voom-card` | Our content, main's frame. |
| Wizard layout, 3D icons, step list, footer | **Main's** setup layout | Our 11 screens inside it; Manual / Assisted / Autopilot reuse main's three automation icons. |
| End of setup | **Main's** `SetupComplete` | Replaced our `AnalyzingScreen` (deleted). Its Edit links go to our Brand page, not Settings. |
| Finished account opening `/app/onboarding` | **Main's** client-side bypass (`completedOnServer`) | Our server redirect removed. |
| Form controls in our screens | **Ours**, a new `FORM` + `Pill` + `Badge` kit in main's `redesign/ui.tsx` | Main's old primitives (`Btn`, `Chip`, `Tag`…) left untouched because 45 of main's files use them. Sizes follow main's Settings page. |
| MARA's visual | **Ours** (Gurnoor's ribbon mark) | Replaced main's conic orb in our screens only. |
| `settings` icon | **Ours redrawn** | Main's drawing read as a sun; now the gear. Also changes main's Connections page button. |
| Hydration warning on `<html>` | **Ours** (`suppressHydrationWarning`) | Caused by main's pre-paint theme script; dev only. |

## Merge 2: `main` at `1ab2826` into our branch, 2026-11-05 (6 conflicts)

Context: 4 days apart. Main added automation-mode normalisation (PR 103, migrations 0071, 0072),
MARA launch readiness (PR 104), TikTok-aligned app icons (PRs 106, 107), the YouTube compliance
launch (PR 109, migrations 0065, 0069, a Cloudflare worker, nine docs) and a Google site
verification file (PR 110). Approved by Gurnoor on 2026-11-04 ("go ahead with your
recommendations") and re-checked on 2026-11-05 before the merge (the two newest PRs added no
conflict). Git merged the bodies of `saveOnboarding` and the store by itself; the six conflicts
were import blocks, one card list and three migration lists.

| Area / file | Winner | What the other side wanted | Why this way |
|---|---|---|---|
| **Autopilot from onboarding** (product rule) | **Main's** | Ours offered Autopilot on screen 9 to a Max account and saved it | Main's rule: onboarding saves Manual or Assisted only (`onboardingAutomationMode` maps `autopilot` to `assisted`), Autopilot is switched on in Automations where the plan is checked, and migration 0071 enforces plan entitlement in the database. A deliberate safety decision with tests. Our Autopilot card now ends "Starts in Assisted — switch Autopilot on in Automations", and `SetupComplete` shows the mode really saved (Assisted, with the note "Switch Autopilot on from the Automations page"). The wish is still kept in the kit (`wanted_automation`). |
| `lib/voom/mutations.ts` `saveOnboarding` | **Main's structure, our Brand Kit block kept** | Main reads the plan, maps the answer, inserts a new row or updates the existing one (no upsert), leaves `automation_level` and `publishing_permission` out when there is no answer, never writes the mode from Settings | Git merged the body on its own; only the import block conflicted (both kept). Our brand kit dual-write, asset sweep, website save and email sync run after main's save, unchanged. |
| `lib/voom/onboardingData.ts` automation cards | **Ours** (`AUTOMATION_CHOICES`) | Main reworded its four `Q_AUTO` cards with "Starts in Assisted" hints | Our wizard has three canonical cards; `Q_AUTO` does not exist on our side (`tests/onboarding-v2.test.mjs` asserts that). The "Starts in Assisted" wording moved onto our Autopilot card. |
| `lib/voom/store.tsx` stored mode type | **Main's** (`string | null`, read through `automationModeState`) | Ours typed it as the three values | Main's display helpers expect the raw value. Only the import block conflicted: our brand, plan and `DEFAULT_FREQ` imports kept, the unused `AutomationModeValue` type dropped. Our `wanted` / `allowed` fallback in `finishOnboarding` is unchanged. |
| Seven migration-list tests (3 conflicted, 4 auto-merged but stale) | **Both** | Main pinned 0072 as newest and listed 0065, 0069, 0071, 0072 | Ours (0075) stays newest; 0065, 0069, 0071, 0072 added to every list (`multi-social-core`, `post-studio`, `post-studio-production-0021`, `campaigns-v3-unified-channels`, `mara-media-brief`, `post-format-persistence`, `email-automation-flows-pglite`). The email-freeze test checks 0072 on its own, like 0059: it only adds a before-insert trigger on `voom_email_flows`. |
| Main's test over `Q_AUTO` (`tests/automation-mode-normalization.test.mjs`) | **Re-pointed to our cards** | Iterated main's four answers and their hints | Same claim ("every offered answer saves Manual or Assisted, never Autopilot") checked against `AUTOMATION_CHOICES`; the four legacy labels are still checked through `onboardingAutomationMode`. |
| Our two fake-database onboarding tests (`brand-kit-context`, `onboarding-v2`) | **Re-pointed to main's save** | The fake `businesses` table only knew `upsert` | The fake now answers main's plan read (no row: a new account) and `insert(...).select("id").single()`; `publishing_permission` may be absent instead of null. No production code changed for them. |
| Main's real-database onboarding test (`tests/mara-launch-onboarding.test.mjs`) | **Passes as is** | Runs the real `saveOnboarding`, where our Brand Kit write now also runs | Green in the post-merge run (2026-11-05); the brand kit write is best-effort and did not disturb it. |
| Main's post-route test (`tests/mara-launch-post-api.test.mjs`) | **Re-pointed to our route** | Its stand-in for `lib/post/server-data` named only main's exports, so our route's import of `deletePostDraft` and `setPostAssetOrigin` crashed the whole file | Two throwing stubs added to the stand-in. Nothing else changed. |
| Our images test (`tests/brand-assets.test.mjs`, two "Finish…" tests) | **Re-pointed to main's save** | Same fake-table gap as above | Fake answers the plan read and the insert. |
| Main's two Vercel tests (`tests/worker-schedules.test.mjs` "PR branch opts out…", `tests/mara-launch-hardening.test.mjs` "PR branch cannot auto-deploy…") | **Left red, main's own** | They pin `vercel.json`'s branch list, which main's PRs 103, 104 and 107 extended without updating them | Proved on a plain copy of `main` at `1ab2826` (`git archive` into the scratch folder, same two failures, `mara-launch-post-api` green there). Main's own red tests are now 7, not 5. |
| `app/layout.tsx`, `vercel.json`, Settings page, Connections page, `tsconfig.json`, `eslint.config.mjs`, `.gitignore`, `.env.example` | **Both, automatic** | Main: icon metadata, new branch entries, mode label helper, YouTube data route button, worker folder excluded from lint/typecheck | Git merged these without conflict; our hydration fix, link card, gear icon and env-var block survive. |
| Lint warnings 15 → 16 | **Main's** | | The new one is main's: `network` unused in `tests/marketing-plan-channel-assignment.test.mjs` (its new "revocation DURING an email AI call" test). Left for main. |
