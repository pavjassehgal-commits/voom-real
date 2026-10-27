# Temporary Production owner-only YouTube refresh verification

Prepared locally only. No deployment or live refresh is authorized by this file.

- Target: `aman@synrapay.com`, original connection `a848fe88-ec9e-4538-8b2c-57065953db8f`,
  channel `@pavjassinghsehgal8524`. A fresh Supabase `auth.getUser()` and owner-RLS
  lookup are required before server-only credential access. No admin impersonation.
- POST only, exact `https://voom.today` Origin and explicit confirmation. Disabled
  outside Production, against any other Supabase project, and from **2026-10-29
  00:00 UTC**. Reconnected/replacement identities do not qualify.
- Uses the actual existing Google client, AES-GCM vault and refresh/persistence
  functions. Other integrations and their refresh behavior are unchanged.
- A deterministic **already-consumed**, server-only `youtube_oauth_states` marker
  is inserted before Google. Its existing primary key serializes repeated requests
  and separate serverless instances. It is not a usable OAuth state and browser
  roles cannot delete/reset it. It expires only after the diagnostic is disabled.
  No new table, grant, secret, scheduler, migration or UI is needed.
- Network transport allows at most one POST to Google's refresh-token endpoint.
  No video, publishing, revocation or extra-scope request is possible. A failure,
  timeout, lost response or uncertain persistence is never automatically retried.
- A successful result requires encrypted persistence and reread expiry, not merely
  an in-memory token. Missing response scopes are labeled `existing_grant`, not
  falsely claimed to have been returned again by Google.

## Owner-only execution after separately approved deployment

The real owner must sign in to `https://voom.today` as `aman@synrapay.com` (the
LinkedIn test account is a different owner). From that page's browser console:

```js
await fetch('/api/integrations/youtube/refresh-diagnostic', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ confirm: 'refresh-existing-youtube-authorization-once' })
}).then(r => r.json())
```

No secret is entered, returned or logged. Do not repeat on an uncertain result;
inspect the existing YouTube connection status instead. Do not disconnect or
reconnect while this one request is in flight; the inherited refresh RPC is
owner-scoped, not a transaction held across Google and a concurrent reconnect.

## Mandatory removal

After verification, remove the route, `lib/youtube/refresh-diagnostic*.ts` and its
dedicated test/document, then obtain approval for the cleanup deployment. Leave
the consumed marker and refreshed credentials untouched. Confirm the endpoint
returns 404 after removal. The hard deadline and consumed marker fail closed
while that cleanup is pending. Do not reset the marker to rerun this diagnostic.
