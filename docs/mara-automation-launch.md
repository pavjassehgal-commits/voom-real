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
  fence, when it writes. A concurrent Build waits for and reuses the winner's
  draft, and an expired lease lets a crashed worker's slot recover.
- **Lease duration is derived, not fixed:** it covers the slowest generation
  the configuration allows: (3 attempts + 2 format fallbacks) ×
  `AI_REQUEST_TIMEOUT_MS`, plus 2 × 2 s backoff, all doubled when trend context
  can fall back to an evergreen generation, plus 30 s for the checks and the
  write. With the default 30 s timeout that is 184 s (338 s with trend context
  on). If the result exceeds 0070's 600 s maximum (timeout > 113 s, or > 56 s
  with trend context on), or the timeout is invalid, no generation starts
  (`slot_lease_budget_exceeded`).
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
2. Confirm Production's `AI_REQUEST_TIMEOUT_MS` (unset = 30 s) fits the lease
   budget above.
3. Merge and deploy. **The code fails closed without 0070:** Build and
   Replenish start no generation and report the plan as unchanged. Never deploy
   before step 1.
4. This branch is opted out of automatic Vercel deployments (`vercel.json`).
   Previews share the Production database, so they must not be used for
   acceptance testing.
