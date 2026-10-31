# MARA automation launch fixes (PR #102)

## What changed

- **Cadence is a limit on every rolling 7-day window.** The pattern is pinned
  to the active plan's start (`cadenceAnchorDate`). The coordinator and an
  explicit Replenish add a date only if every 7-day window containing it stays
  within the cadence. Social work from today − 6 to today + 12 counts once per
  date: published, approved, queued and proposed work, on or off the pattern.
- **Rejected ideas:** detached from the plan and replaced once. Failed work never
  counts as coverage.
- **Failed provider publishes** (Instagram, TikTok, YouTube, LinkedIn queues)
  are not coverage and are never re-planned or retried automatically. They are
  reported as `heldForOwner`. Automation never re-approves or re-syncs approved
  work, which would re-arm a failed Instagram job.
- **Single-flight generation (migration 0070):** a worker must hold a durable
  per-slot lease before any paid MARA call and still hold it, checked by the
  fence, when it writes. Leases expire after 180 s so a crash recovers. A
  concurrent Build waits for and reuses the winner's draft.
- **Pause, downgrade or mode change mid-run:** scheduled runs re-check
  authorization before every generation and every draft write. They then stop
  and report each unfinished slot (stage `authorization`), so a half-built
  plan is never reported as complete.
- **Per-generation AI usage keys:** provider retries share one key, and
  replacements and fallbacks get their own.

## Release order (each step needs its own approval)

1. Apply `supabase/migrations/0070_plan_slot_generation_leases.sql` to staging,
   verify it, then apply it to Production. The rollback is
   `supabase/rollbacks/0070_plan_slot_generation_leases.sql`; it only removes
   the lease table and functions.
2. Merge and deploy. **The code fails closed without 0070:** Build and
   Replenish start no generation and report the plan as unchanged. Never deploy
   before step 1.
3. This branch is opted out of automatic Vercel deployments (`vercel.json`).
   Previews share the Production database, so they must not be used for
   acceptance testing.
