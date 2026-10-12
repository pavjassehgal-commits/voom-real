# Trend Intelligence — backend-first release plan (not executed)

Base: `origin/main` = `f15b5bc` (production last reported at migration 0051). Nothing below has been run against production.

## Order (each step needs explicit approval)

1. **Admin Panel release first.** Merge and deploy the Admin Panel branch, which carries migrations `0052`–`0054`, and apply those migrations to production in that order.
   - Trend Intelligence must never reach production before them. If it did, the Supabase CLI would treat 0052–0054 as out of order.
   - The Admin Panel also provides the only staff authority, MFA admin memberships, that a review UI can safely use.
2. **Trend Intelligence branch.** Rebase it onto the new `main`, then copy the proposed migrations into `supabase/migrations/` unchanged:

   | File | SHA-256 prefix | Rollback prefix |
   | --- | --- | --- |
   | `0055_trend_intelligence.sql` | `93195e8c` | `9199325a` |
   | `0056_trend_mara_workflow_context.sql` | `b5eee7eb` | `782205ee` |
   | `0057_wikidata_event_source.sql` | `4bf4a155` | `91dc9197` |

   Update the repository's "newest migration" pin tests from 0054 to 0057 in the same change, then run the full suite, typecheck, lint and build.
3. **Deploy the application code.** All of it is inert by default:
   - `VOOM_TREND_CONTEXT_ENABLED` is unset, so MARA prompts and payloads are byte-identical to today's;
   - `TREND_COLLECTION_ENABLED` is unset, so the cron route returns 503;
   - the route is not in `vercel.json`.
4. **Apply 0055 → 0056 → 0057 to production**, then run `docs/trend-intelligence/staging/03-verify.sql`. The `admin tables` row should show 4 once 0052–0054 are present.
5. **Production governance records.** A production version of `08-wikidata-activation.sql`, with a new dated coverage check and an approver confirmed by you.
6. **Collection, one manual run first.** Set `TREND_COLLECTION_ENABLED=true` (the route already uses `CRON_SECRET`), call `GET /api/cron/trend-collection` once with the bearer, and review the stored events.
   - Only after that review, add a daily `vercel.json` cron entry, for example `0 3 * * *`.
   - The job makes at most one Wikidata request per 20 hours and purges expired data on every run.
7. **Reviewed contexts per merchant, then the MARA flag.** Turn on `VOOM_TREND_CONTEXT_ENABLED=true` only after reviewed contexts exist.

## Rollback (fastest first)

- **Behaviour:** unset `VOOM_TREND_CONTEXT_ENABLED`. MARA returns to exactly its previous prompt and payload, with no deploy needed.
- **Collection:** unset `TREND_COLLECTION_ENABLED`, or remove the cron entry. The route then returns 503 and makes no requests.
- **Data and schema:** run `0057.rollback` → `0056.rollback` → `0055.rollback`, in that order. Each is one transaction and refuses if a dependent record exists. They remove only `trend_*` objects; existing customer data and Admin Panel tables are untouched (verified on the staging replica).
- **Code:** revert the Trend Intelligence merge commit. No other code path depends on it.
