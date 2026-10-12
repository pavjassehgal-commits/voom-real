# Step 05 — PostgREST role checks and real concurrency (staging only)

These checks go through the real Supabase API, which the local PGlite tests cannot reproduce. Run them in **your own terminal**.

**Keys**

- Never paste a key into a chat, document or file.
- The service-role key is a **staging** key. Copy it from the voom-staging dashboard (Settings → API) into an environment variable for this terminal session only.

**Setup** (type these yourself, with `read -s` so nothing is echoed):

```bash
export STAGING_URL="https://qcdpegwjofrqnfudyrqq.supabase.co"
read -s STAGING_ANON_KEY && export STAGING_ANON_KEY
read -s STAGING_SERVICE_KEY && export STAGING_SERVICE_KEY
```

Before this step, run `05-seed-decisions.sql` in the SQL editor. It approves one source and one market, both labelled STAGING-TEST.

## A. Browser roles are denied (anon key)

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$STAGING_URL/rest/v1/trend_observations?select=id&limit=1" -H "apikey: $STAGING_ANON_KEY" -H "Authorization: Bearer $STAGING_ANON_KEY"
```

```bash
curl -s -w "\n%{http_code}\n" -X POST "$STAGING_URL/rest/v1/rpc/trend_list_usable_observations" -H "apikey: $STAGING_ANON_KEY" -H "Authorization: Bearer $STAGING_ANON_KEY" -H "Content-Type: application/json" -d '{"p_platform":"youtube","p_country":"AE"}'
```

Expected: `401` or `403` with code `42501` (permission denied), or `404` with `PGRST202`/`PGRST205` (not exposed to this role). **Any `200` is a failure.**

For the `authenticated` role, repeat both commands with a staging test user's access token in `Authorization: Bearer …`. Use the ordinary test account, never an admin. The expected results are the same.

## B. service_role: reads only through the RPC, writes only through the RPC

Direct insert must be denied (`401`/`403`, `42501`):

```bash
curl -s -w "\n%{http_code}\n" -X POST "$STAGING_URL/rest/v1/trend_observations" -H "apikey: $STAGING_SERVICE_KEY" -H "Authorization: Bearer $STAGING_SERVICE_KEY" -H "Content-Type: application/json" -d '{}'
```

Create one synthetic payload, timestamped one hour ago (macOS `date`):

```bash
T=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ); cat > /tmp/trend-staging-payload.json <<EOF
{"p_observation":{"source_id":"youtube_data_api","platform":"youtube","country":"AE","language":"und","subject_kind":"video","subject_text":"STAGING-TEST concurrency","subject_normalized":"staging-test concurrency","provider_item_id":"stgconc0001","window_start":"$T","window_end":"$T","retrieved_at":"$T","metrics":{"chart_rank":{"status":"measured","value":"1","definition_version":"youtube_data_api.chart_rank.v1"},"view_count":{"status":"measured","value":"18446744073709551615","definition_version":"youtube_data_api.view_count.v2"},"like_count":{"status":"unavailable","unavailable_reason":"not_collected"},"comment_count":{"status":"unavailable","unavailable_reason":"not_collected"}},"evidence":[{"source_id":"youtube_data_api","url":null,"attribution":"STAGING-TEST","retrieved_at":"$T"}]},"p_replaces":null}
EOF
```

## C. Real concurrency: 20 simultaneous identical requests

```bash
seq 20 | xargs -P 20 -I{} curl -s -X POST "$STAGING_URL/rest/v1/rpc/trend_store_observation" -H "apikey: $STAGING_SERVICE_KEY" -H "Authorization: Bearer $STAGING_SERVICE_KEY" -H "Content-Type: application/json" -d @/tmp/trend-staging-payload.json | grep -o '"status":"[a-z_]*"' | sort | uniq -c
```

Expected: exactly `1 "status":"stored"` and `19 "status":"duplicate"`.

Confirm in the SQL editor (expected `1`):

```sql
select count(*) from public.trend_observations where provider_item_id = 'stgconc0001';
```

## D. Read RPC through the API (exact precision)

```bash
curl -s -X POST "$STAGING_URL/rest/v1/rpc/trend_list_usable_observations" -H "apikey: $STAGING_SERVICE_KEY" -H "Authorization: Bearer $STAGING_SERVICE_KEY" -H "Content-Type: application/json" -d '{"p_platform":"youtube","p_country":"AE","p_limit":5}' | grep -o '"view_count":{[^}]*}'
```

Expected: `"value": "18446744073709551615"`, as a string and exact.

## E. Revocation through the API

Revoke in the SQL editor:

```sql
update public.trend_source_authorizations set status = 'not_approved', decided_at = now(), reference = 'STAGING-TEST-REVOKE' where source_id = 'youtube_data_api';
```

Then repeat step D. Expected: `"observations": []` and `"permitted_source_ids": []`.

## F. Optional: revocation while a write is in progress (two `psql` sessions)

Only if you have `psql` and the staging connection string. Never share the password.

1. **Session 1:** `begin; select public.trend_store_observation(...);` (do not commit).
2. **Session 2:** `update public.trend_source_authorizations set status = 'not_approved', decided_at = now(), reference = 'STAGING-TEST-REVOKE2' where source_id = 'youtube_data_api';`. Expected: it **waits**.
3. **Session 1:** `commit;`. Session 2 then completes.

## Afterwards

1. Run `06-cleanup.sql`. It refuses if any non-synthetic trend data exists.
2. Remove the temporary payload file:

```bash
rm -f /tmp/trend-staging-payload.json
```

3. Clear the keys from your shell:

```bash
unset STAGING_ANON_KEY STAGING_SERVICE_KEY STAGING_URL
```
