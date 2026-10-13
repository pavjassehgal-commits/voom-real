# Universal Trend Intelligence (development branch, not activated)

Goal: Marketing Plan → Replenish gives every business ideas that are tailored, evidence-grounded and current when evidence exists, and clearly evergreen when it doesn't.

## Signal sources (all free, keyless and legitimately reusable)
| Source | What it gives | Rights and limits | Market |
|---|---|---|---|
| `wikidata_events` (live since 0057) | Upcoming events recorded in Wikidata | CC0 structured data; no popularity claim | AE (as configured) |
| `public_holidays_nager` (0058) | Nationwide public holidays within the next 45 days | Nager.Date, MIT open source; calendar facts only. No data for some countries (e.g. AE, IN). | Per country, ISO code |
| `wikimedia_pageviews` (0058) | Business-relevant articles from the daily most-viewed English Wikipedia list, with their measured views | Wikimedia Analytics API; pageview data is CC0; a descriptive User-Agent is required. This is reader attention, not searches, sales or social popularity. | `ZZ` (worldwide; it's a language-edition signal, not a country signal) |

Not used, deliberately: Google Trends website scraping (no public API), YouTube charts (terms restrict derived metrics), and any social-network scraping.

## Pipeline
1. **Collection.** `lib/trends/universal-collection.ts` runs inside the existing daily job. For each market it:
   - checks governance first: no approval or verified coverage means no request is made;
   - applies a 20-hour rate limit;
   - makes bounded GETs;
   - stores observations through the existing store RPC, which handles normalization, dedupe, freshness, expiry and evidence.
2. **Relevance.**
   - `lib/trends/industry.ts` holds the shared taxonomy:
     - 15 industries;
     - cultural moments, with region-bound moments limited to their countries;
     - a brand-safety filter;
     - place detection.
   - `lib/trends/relevance.ts` matches usable observations to one business:
     - industry comes from the business's own industry label, falling back to its description;
     - a market applies only when the profile names a place. The account timezone is never used, because it defaults to Asia/Dubai.
     - Facts are written only from stored, attributed fields: the holiday name and date, the measured view count, or the Wikidata record.
3. **Replenish.** `lib/voom/workflow/service.ts`, behind `VOOM_TREND_CONTEXT_ENABLED`:
   - an owner-reviewed context still applies to every slot;
   - otherwise up to two matched ideas fill the first slots;
   - a trend slot that fails MARA's grounding or claim checks becomes an evergreen idea;
   - every draft records `idea_basis` / `ideaBasis`, either `verified_trend` (with topic, market and sources) or `evergreen`.

## Evidence review (the smallest defensible mechanism)
- **No per-business SQL.** The owner approves each source once and verifies coverage once per market, through the existing governance tables. After that, evidence is used automatically.
- **Nothing unverified is treated as fact.** Free-text claims from sources are never repeated. Wikidata items with uncertain dates state no date, and unsafe or political titles are dropped.
- **Mistakes can be removed instantly.** Any staff member can call `trend_invalidate_observation`. Revoking a source's approval hides all of its evidence at once.
- **Everything is auditable.** Each draft carries its basis, and each observation keeps its evidence URL and attribution.

## Activation (each step needs separate approval)
1. Apply `supabase/migrations/0058_universal_trend_sources.sql` in production (rollback: `supabase/proposed/0058_universal_trend_sources.rollback.sql`), then record `0058` in the ledger. Admin Panel migrations start at 0059.
2. Record governance approvals for `public_holidays_nager` and `wikimedia_pageviews`, then verify coverage:
   - `web`/`ZZ` for pageviews;
   - `web`/each country for holidays: US, GB, CA, AU, IE, NZ, DE, FR, ES, IT, NL, ZA.
3. Enable collection: set `TREND_COLLECTION_ENABLED=true`, then make one manual run.
4. Add a daily schedule.
5. Set `VOOM_TREND_CONTEXT_ENABLED=true`.

## Known limits
- Businesses store no country, so only businesses that name a place get country holidays. Everyone else gets worldwide signals or evergreen ideas. A small onboarding field for country (an approved schema and UI change) would raise holiday coverage.
- Daily Wikipedia attention for some industries (e.g. restaurants, beauty) is sparse on many days. Those businesses then get cultural moments or evergreen ideas, which is honest but less specific.
