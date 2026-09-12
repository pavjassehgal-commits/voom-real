# Voom production-readiness audit

Internal audit performed before the production-readiness pass. Each finding is
classified:

- **A** — should be backed by real production data now
- **B** — should show a truthful empty state
- **C** — should be hidden/removed until implemented
- **D** — intentional developer/test-only control; must never show in normal production UI

## 1. Demo / placeholder / fake UI

| # | Finding | Class | Action |
|---|---------|-------|--------|
| 1.1 | Topbar search: read-only input saying “Search isn’t available in this version” | B | Replaced with a real app search backed by existing data (`/api/search`) |
| 1.2 | Notifications bell: hardcoded `notif: 3` badge + `NotificationsModal` listing three invented “Sample:” notifications | A/B | Badge and modal now render real workflow facts (items needing approval / needing attention); truthful empty state |
| 1.3 | `ComposeModal`: topic pre-filled from the demo industry pack, fake “Sample caption” generator (setTimeout), fabricated “best-performing slot in this sample dataset” claim, hardcoded `19:10` default | C | Deleted; every creation path now goes through the real `CreateContentModal` |
| 1.4 | `/app/reels` (“Content Studio” nav item): sample workspace with fake Instagram like/comment counts, fake toasts (“12 hashtags added from your top posts”, “Trending audio attached”), demo queue with hardcoded “Tue, Aug 25” / “Fri, Aug 28” dates | C | Page removed from navigation; route now redirects to the real Create Content studio; demo page, templates and all store reel actions deleted |
| 1.5 | `/app/ads` (“Paid Advertising” nav item): fully demo — invented budget suggestion “in this demo dataset”, fake past-ROAS figures, fake approved-plan card with “Prototype demonstration” note, fake Export toast, fake ad history | C | Nav item removed; page replaced with a truthful “not connected yet” state that explains what paid advertising will do; fake allocator/donut/history/approval modals deleted |
| 1.6 | Campaigns page: fake stat cards (“Sample subscribers 8,412”, “Sample open rate 41.2%”, “Sample SMS opt-ins 3,190”…) and “MARA today” tips citing fabricated numbers; redundant “Demo data” tags | A/C | Fake metrics and tags removed; tips replaced with honest guidance that cites no numbers. The saved-campaigns table is real and stays |
| 1.7 | Client store seeds demo data on every load (`buildPosts`, `buildReelQueue`, `buildCampaignsTable`, `buildEmails`, `buildSms`, `buildAdAlloc`, `buildAdHistory`, `buildInsights`, `seedChatFor`) | D | Store slimmed to real state only; demo generators deleted with their consumers |
| 1.8 | Dead demo components still in the tree: `LegacyMaraChat`, `MaraMenuModal`, `KpiDetailModal`, `dashboard/AreaChart`, `ChatBubble`, `PostDetailModal` (no importers) | D | Deleted |
| 1.9 | Pricing page + `UpgradeModal`/`DowngradeModal`: simulated checkout that flips a client-side plan flag (“Upgrading here simulates a checkout”) | C | Fake checkout removed; plans page stays as honest information with a clear “billing is not active yet” state; plan-gated upsell copy removed from the sidebar |
| 1.10 | Onboarding `AnalyzingScreen`: fake progress items (“Reviewing sample competitor posts”) and a false “14 days of content drafted” toast | B | Reworded to truthful setup steps that claim nothing was drafted |
| 1.11 | Onboarding step branded with a “Demo data” tag while saving real business data | B | Tag removed |
| 1.12 | `ui/Notes.tsx` `DemoTag` / `ExTag` / `ProtoNote` shims kept demo UI alive | C | Deleted once unused |
| 1.13 | Instagram page shows a derived `@handle` (guessed from the brand name) | A | Handle display now only shown when the account is really connected and the real account username is available |

## 2. Scheduling / date bugs

| # | Finding | Action |
|---|---------|--------|
| 2.1 | `PostEditorModal` converts schedule instants with **browser-local** time (`new Date(...)`, `getFullYear()`), not the business timezone — a device in another timezone would silently schedule the wrong instant | Uses the shared business-timezone helpers (`Asia/Dubai` policy in `lib/voom/timezone.ts`) for both display and submission |
| 2.2 | `PostEditorModal` had no min attributes and no client-side past-date/time guard | Date input min = current local date; time min applies for today; a shared pure guard (`lib/voom/schedule-guard.ts`) validates before submit with actionable messages |
| 2.3 | `ComposeModal` `composePublishAt` used browser-local time for the same purpose | Modal deleted; the shared guard is used everywhere |
| 2.4 | Server checks existed on `POST /api/voom/calendar` and `PATCH /api/posts/[id]` but with duplicated logic and terse messages | Both now use the shared guard: rejects past dates, same-day past times, and malformed values; messages explain what is wrong |
| 2.5 | Items scheduled in the past (historical data) rendered as plain “Scheduled” with no past-due hint | Publishing queue rows, calendar detail and saved-calendar detail mark scheduled-but-past items as **Past due** with an honest explanation |
| 2.6 | Stale copy in `PostEditorModal` and the Studio page: “publishing to Instagram is not connected” — publishing **is** connected (queue + cron) and the API response even says so | Copy corrected to describe the real Draft → Approved → Scheduled → Publishing → Published flow |
| 2.7 | Calendar opened on the real current month already (fixed in an earlier pass); verified today highlight uses the server business-timezone date, month navigation works, no hardcoded month remains | Kept; regression tests added |

## 3. Broken / dead controls

| # | Finding | Action |
|---|---------|--------|
| 3.1 | Fake toasts on removed surfaces (ads Export, reels Play/Cover/hashtags/audio) | Removed with their pages |
| 3.2 | Store `logout` action that only toasted “Signed out” (unused; Topbar uses the real server action) | Removed from the store |
| 3.3 | “New post” button on the calendar opened the deleted demo composer | Opens the real `CreateContentModal` |
| 3.4 | Topbar “Create” opened the deleted demo composer | Opens the real `CreateContentModal` |

## 4. Empty-state problems

| # | Finding | Action |
|---|---------|--------|
| 4.1 | Notifications had no truthful empty state (fake list) | “You’re all caught up” state backed by real data |
| 4.2 | Paid advertising had no honest state | Truthful empty state explaining purpose, why empty, and next steps |
| 4.3 | Publishing queue empty text “Nothing in this view.” was uninformative | Explains what the queue is and how items enter it |
| 4.4 | Today / Approvals / Marketing Plan / Calendar / Campaigns / Contacts / Performance / Connections / Automations / Studio already have truthful empty states | Kept; shared `EmptyState` primitive added for consistent presentation on the pages touched |

## 5. Visual inconsistencies

| # | Finding | Action |
|---|---------|--------|
| 5.1 | Empty states were bespoke per page (different padding, icons, hierarchy) | Shared `EmptyState` primitive used on touched pages |
| 5.2 | Status wording drifted between surfaces (“Scheduled internally”, “Ready to publish”, queue labels) vs. the workflow standard | Statuses standardized on: Planned, Generating, Needs approval, Scheduled, Publishing, Published, Needs attention; post-studio internal states keep their distinct, truthful labels (Draft, Approved, Scheduled, Ready to publish) with an explanatory caption |
| 5.3 | Demo pages were the densest, most inconsistent screens | Removed entirely |

## 6. Navigation issues

| # | Finding | Action |
|---|---------|--------|
| 6.1 | “Content Studio” nav item → `/app/reels`, a sample workspace | Removed from nav + bottom bar; route redirects to `/app/studio` (real Create Content) |
| 6.2 | “Paid Advertising” nav item → `/app/ads`, fully demo | Removed from nav; route still resolves to a truthful page so old links don’t die |
| 6.3 | All remaining routes verified: Today, Approvals, Marketing Plan, Create Content, Content Calendar, Campaigns, Automations, Performance, Connections, Contacts, Settings — real pages, real titles | No change |

## 7. Dangerous missing validation

| # | Finding | Action |
|---|---------|--------|
| 7.1 | “Remove visual” on a post discarded generated media immediately with no confirmation | Two-step inline confirm added |
| 7.2 | Client-side schedule inputs accepted past values silently (server caught them with a terse message) | Shared guard validates on both sides with actionable messages |
| 7.3 | Contacts / campaign forms already validate server-side (subscription status, E.164, email shape, whitespace trimming, caps) and guard double submits via `busy` state | Kept; no regression |

## Production test controls

- `Preview 7-Day Plan (No Media)` on Marketing Plan: **kept** (needed for the
  current controlled workflow testing) but now hidden behind the
  `NEXT_PUBLIC_ENABLE_PLANNING_PREVIEW=1` environment flag. Normal production
  users no longer see it. Behaviour, endpoint contract and tests unchanged.
