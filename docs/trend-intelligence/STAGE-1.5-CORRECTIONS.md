# Voom Trend Intelligence — Stage 1.5 foundation corrections

Status: **pure domain code and documentation only.** No database, migration, credential, worker, UI, MARA or provider call was added. No live API request was made; provider facts below come from public documentation read on 2026-10-11.
Branch `local/voom-trend-intelligence` (base `f15b5bc`), uncommitted.

## 1. Identity: content item vs topic

| Key | Built from | Meaning |
| --- | --- | --- |
| `itemKey` | platform + kind + provider id | One specific video/sound on one platform, worldwide. `null` for topics. |
| `topicKey` | platform + country + language + kind + normalized text | What people are talking about in one market. |
| `trendKey` | the item within a market when an item exists, otherwise the topic | The unit that observations are grouped and corroborated under. |
| `observationIdentity` | source + `trendKey` + window | Duplicate detection. |

Rules (`ITEM_IDENTITY_BY_KIND`, `PROVIDER_ITEM_ID_PATTERNS`):

- `video` **requires** a provider id; `sound` may carry one; `search_query`, `topic`, `hashtag`, `format` must not.
- Ids are validated per platform (YouTube 11 characters `[A-Za-z0-9_-]`; TikTok numeric; Instagram shortcode; Google Search has no item ids) and compared exactly (case-sensitive).
- Because the platform is part of every key, the same id string on two platforms is never the same item.
- Country and language remain in `trendKey`, so one video charting in AE and IN is one item but two separate trends; isolation is unchanged.
- A retitled video is still one item; two videos sharing a title are two items with the same `topicKey`.
- A YouTube evidence link that names a different video id is rejected (`evidence_item_mismatch`).

## 2. Data source registry: five separate facts

| Fact | Where it lives | Default |
| --- | --- | --- |
| Supported data schema | `TrendSourceDefinition.dataSchema` | `"supported"` — Voom can validate this shape. Nothing more. |
| Actual API availability | `TrendSourceDefinition.apiAvailability` (status, note, reference, checkedAt) | Documented per source (below). |
| Verified provider coverage | `MarketPolicy.coverage` (`SourceCoverage`, per source × platform × country) | Empty: nothing verified. |
| Approved / authorized use | `MarketPolicy.authorizations` (`SourceAuthorization`: status, decidedAt, decidedBy, reference) | Empty: every source is `not_reviewed`. |
| Operational connection | `TrendSourceDefinition.connection` | `"not_connected"` for every source. |

Approval is never a static registry property. `createMarketPolicy` rejects approvals without a decision time, decider and reference. Confidence ignores any observation whose source is not explicitly `approved` (`source_not_authorized`, listed in `unauthorizedObservationIds`) **before** coverage or evidence is considered, so a supported schema or a documented API never implies permission.

| Source | Provider | API availability |
| --- | --- | --- |
| `google_trends_web` | Google | `no_public_api` — website values recorded manually with an evidence URL |
| `google_trends_api` | Google | `restricted_alpha` — application-based access |
| `youtube_data_api` | YouTube | `generally_available` — but see §4: not authorized for this use |
| `manual_research` | Voom | `not_applicable` |

## 3. Google Trends — two different measures

Source: <https://developers.google.com/search/apis/trends> (read 2026-10-11).

- The **website** shows a 0–100 index normalized **per request** (relative to the peak of that query, time range and geography). Values from different requests are not comparable.
- The **Trends API (alpha)** returns **consistently scaled** values that can be compared across requests. They are **not** the 0–100 website index and are **not** absolute search volume.
- The API is an **alpha with restricted, application-based access**. Documented scope: a rolling 5-year window, daily/weekly/monthly/yearly aggregation, country and sub-region geography. **Not stated:** data freshness/latency, terms of use for derived products, authentication method, quotas.

Consequences in code:

- Split into two sources with different metrics: `google_trends_web.interest_index` (`relative_index`, integer 0–100, `…v1`) and `google_trends_api.scaled_interest` (`scaled_interest`, ≥ 0, no maximum, not necessarily integer, `…alpha`).
- Submitting either metric to the other source fails (`unknown_metric`); they are never merged or compared.
- No connection. Before any use: apply for alpha access, review its terms, confirm freshness and authentication, and record an approval.

## 4. YouTube — activation prerequisites (ingestion stays disabled)

Sources: YouTube API Services Developer Policies (III.E.2, III.E.4, III.E.4.h, III.L); "Additional policies for derived metrics and data storage" (`/youtube/terms/derived-metrics-policy`); `videos.list`; `videos` resource; quota docs; `i18nRegions.list`.

Facts:

- `videos.list chart=mostPopular&regionCode=XX` returns the most popular videos for a region; 1 unit per request; 10,000 units/day by default; invalid requests also cost quota.
- `favoriteCount` is always 0 (excluded from the registry). `dislikeCount` is private.
- `viewCount` changed definition from **2026-08-24**: modelled as `view_count.v1` / `view_count.v2`. A value is tagged with the version in force at retrieval and cannot claim the other.
- III.E.4: data from non-authorized users may be stored at most **30 calendar days**, then deleted or refreshed.
- III.E.4.h: no new or derived data or metrics from API data (except as allowed by the additional policy).
- III.E.2: no aggregation of API data to gain insight into YouTube's usage.
- The **derived-metrics policy** is an opt-in amendment for developers who select the **"Analytics & Reporting"** use case. It permits listed categories (e.g. content categorization/tagging, gamification/leaderboards, channel scores, brand safety); derived metrics must be clearly distinguished from API data; metrics may be stored up to 36 months, but underlying API data (titles, descriptions) stays under the 30-day rule. It **does not address** platform-wide trend analysis of `mostPopular` charts.

Must be resolved before activation:

1. **Policy fit (blocking).** A written decision (policy/legal, or confirmation from YouTube API support) that Voom's trend use fits III.E.2 / III.E.4.h, or fits a category of the derived-metrics policy after accepting the amendment.
2. **Use-case registration.** If relying on the derived-metrics policy: accept the amendment and select "Analytics & Reporting" for Voom's API project; record the reference in a `SourceAuthorization`.
3. **API project and audit.** A dedicated Google Cloud project; YouTube API compliance audit if quota above default or the derived-metrics route requires it.
4. **Retention enforcement.** A database-level guarantee that YouTube rows are deleted ≤ 30 days after retrieval, running even when ingestion does not.
5. **Derived-metric labelling.** Any Voom confidence/trend label shown next to YouTube data must be visibly distinguished from YouTube's own values.
6. **Technical verification (staging only).** That an API key alone suffices for `chart=mostPopular`; that the key can be sent as a header; the quota reset time zone; and actual `regionCode` coverage for each target market via `i18nRegions.list`, recorded as `SourceCoverage`.
7. **View-count boundary time zone.** The docs give a date, not an instant; Voom assumes `2026-08-24T00:00:00Z`. Data retrieved within ±1 day of the change should be treated as definition-ambiguous until confirmed.
8. **Explicit approval** recorded in `MarketPolicy.authorizations`, then a separate owner approval to connect.

## 5. Metrics

- Every measured value now carries `definitionVersion`. If omitted it is resolved from the definition in force at `retrievedAt` (`[effectiveFrom, effectiveUntil)`); an unknown version fails (`unknown_metric_definition`), a version not in force fails (`metric_definition_not_in_effect`).
- Unavailable metrics remain `{status: "unavailable", reason}` with no value and no version, and never count as evidence.

## 6. Tests

`tests/trends-identity.test.mjs` (16 new) plus the updated `tests/trends-schema.test.mjs` and `tests/trends-processing.test.mjs`: **66/66 pass**. Typecheck and eslint (`lib/trends`, trend tests) clean.
