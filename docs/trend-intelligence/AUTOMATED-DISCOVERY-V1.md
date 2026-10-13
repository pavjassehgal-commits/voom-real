# Automated Free Trend Discovery V1

## Source decision

V1 uses the public Wikidata Query Service for structured UAE event records.

- Structured Wikidata data is CC0 and may be reused commercially: <https://www.wikidata.org/wiki/Wikidata:Licensing>
- Query-service operating limits require an identifiable user agent, bounded queries, caching and respectful request volume: <https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual>
- The connector records Wikidata entity URLs and attribution. It records no popularity, reach, engagement or search-volume claim.
- Wikidata is community-maintained, not an official event announcement. Every result therefore remains qualitative, low-confidence evidence until a human reviews it.

The connector performs one GET, has no retry loop, limits the result to 25 UAE records within 120 days, times out after 15 seconds by default, and caps its configurable horizon and timeout.

## Safety and review boundary

`runWikidataEventDiscovery` validates and attempts to store observations through the existing `trend_store_observation` RPC. The database refuses storage until the project owner has separately:

1. approved `wikidata_events` in `trend_source_authorizations`; and
2. verified `wikidata_events` / `web` / `AE` coverage in `trend_source_coverage`.

Migration 0057 adds only the source registry row. It deliberately adds neither decision. A discovered event is returned only as a review candidate; it is never inserted into `trend_mara_contexts` or marked approved by the connector. MARA continues to read only approved, unexpired, owner-scoped contexts through the 0056 loader and only when `VOOM_TREND_CONTEXT_ENABLED=true`.

## Local proof

On 12 October 2026, the bounded live query returned two current UAE event records and the connector parsed both with source URLs and event dates. The deterministic acceptance test then exercises:

`Wikidata-shaped response → validated observation → storage RPC → reviewed context fixture → runOwnerWorkflow(trigger=replenish) → grounded post/Reel/video drafts`

No AI request, provider API, publishing action or production/staging database write is part of that test.

## Minimum launch steps (not executed)

1. Review and apply 0057 after 0055 and 0056 in staging.
2. Record a legal/product approval for the CC0 source and a dated AE/web coverage verification; keep the evidence references in the governance tables.
3. Run one staging collection and review the stored observations and entity links.
4. Build the owner-specific pending contexts through the existing review process; approve only factually checked events.
5. Run the Replenish acceptance path in staging with deterministic AI, then one separately approved live-AI check if needed.
6. Add an authenticated, rate-limited daily server job that invokes the collector once. Do not use browser execution. Monitor timeouts and result counts; do not retry automatically in V1.
7. Keep `VOOM_TREND_CONTEXT_ENABLED` off in production until migration, governance, review, monitoring and rollback checks pass.

## Cost

Wikidata requires no API key or subscription. V1 makes no paid AI or social-provider request. Ordinary application hosting, database storage and scheduled-function execution may still incur the project's normal infrastructure usage once deployed.
