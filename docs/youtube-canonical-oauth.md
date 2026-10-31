# YouTube reconnection on voom.today

## Confirmed mismatch

Production `YOUTUBE_REDIRECT_URI` still points to
`https://voom-real.vercel.app/api/integrations/youtube/callback`.
Starting OAuth on `voom.today` sets a host-only state cookie and uses that host's
VOOM session. Neither cookie can be shared with the unrelated `vercel.app` host.
Do not broaden cookie domains, forward authorization codes between hosts or
disable the owner/state checks to work around this.

## Small local safeguards

- Connect rejects a callback whose origin differs from the initiating site, or
  whose path/query/fragment is not the exact callback endpoint, before creating
  OAuth state or sending the customer to Google. Callback checks the same rule
  before consuming state or exchanging a code. Staging/local hosts remain
  supported when their own explicitly configured callback matches.
- Callback expires the original host-only state cookie at its actual path.
- Missing offline access, upload consent, channel lookup failure and failed
  persistence never replace existing encrypted credentials.
- The existing transactional `save_youtube_connection` upserts the owner's
  original connection UUID; existing owner and connected-channel unique
  constraints prevent duplicate connections and cross-owner channel takeover.
  No schema or publishing changes are required.

## Approval required before rollout

1. In the **existing** Google Cloud project, open **Google Auth Platform →
   Clients → the Web application matching VOOM's GOOGLE_CLIENT_ID** (also
   accessible through APIs & Services → Credentials → that OAuth client).
   Under **Authorized redirect URIs**, add exactly:
   `https://voom.today/api/integrations/youtube/callback`
   No trailing slash. Preserve existing staging/legacy URLs. Save. This is not
   an Authorized JavaScript origins entry; no new app or secret is needed.
2. Change only Vercel `voom-real`'s **Production** `YOUTUBE_REDIRECT_URI` to that
   same URL, then release the reviewed local branch through the usual PR and
   Production deployment. Preserve every other variable and Preview scope.
3. The actual owner signs in at `https://voom.today/app/youtube` and uses
   **Reconnect** (or **Connect YouTube**, as labeled), without first disconnecting.
   Complete Google's genuine consent using the intended existing channel.
   Check the returned channel, connected status and upload grant read-only.

No Google/Vercel setting, deployment, live connection or provider was changed
by preparing this local fix. The consumed refresh diagnostic must not be reset
or retried. Its `invalid_grant` result requires new consent, not another refresh.
