# YouTube — Google OAuth verification package (draft)

Prepared November 1, 2026 on `fix/youtube-compliance-launch`. This is a
preparation pack. It submits nothing, changes no Google Cloud Console setting,
and contains no secret. Every Console item below is an **account-owner action**.

## 1. What Google currently requires (official sources, checked 2026-11-01)

| Question | Current official answer | Source |
|---|---|---|
| Are uploads from an unverified/unaudited API project forced to private? | **No.** The videos.insert reference states that videos uploaded from unverified API projects are not restricted to private viewing mode. Uploads may still default to private based on creator account settings. | developers.google.com/youtube/v3/docs/videos/insert (updated 2026-10-15) |
| When is a YouTube API Services Compliance Audit required? | To obtain quota beyond the default allocation, and for periodic/change-of-control audits Google initiates. Default: 100 `videos.insert` calls/day, 100 `search.list`, 10,000 units/day for other methods. | developers.google.com/youtube/v3/guides/quota_and_compliance_audits (updated 2026-10-15) |
| Data freshness | Authorized Data: delete or refresh after 30 calendar days (III.E.4.c). Non-authorized data and statistics: at most 30 days (III.E.4.b/d). | YouTube API Services Developer Policies (updated 2026-10-15) |
| Deletion deadlines | In-app revocation: revoke the token right away and delete Authorized Data within 7 calendar days (III.D.2.c.1). Revocation via Google settings: within 30 days (III.D.2.c.2). User deletion request: as soon as possible, within 7 days (III.E.4.g). | Developer Policies |
| Disclosures | Link the YouTube Terms of Service and bind users to it (III.A.1); privacy policy links the Google Privacy Policy (III.A.2.c) and explains revocation via the Google security settings page (III.A.2.h). | Developer Policies |
| Google OAuth sensitive-scope verification | Verified domains (Search Console), privacy policy hosted on the homepage domain and identical to the consent-screen link, a demo video of the full OAuth grant showing the exact scopes, and a written scope justification explaining why narrower scopes are insufficient. | support.google.com/cloud/answer/13464321 |

**Conclusion for VOOM.** A compliance audit is **not** a prerequisite for
public uploads under current documentation. It is needed only if VOOM needs more
than the default daily quota (100 uploads/day across all customers). OAuth
consent-screen verification for the two YouTube scopes **is** required for a
public launch beyond test users. The app previously told customers that Google
locks unaudited uploads to private; this branch corrects that copy (see §7).
Re-check both pages immediately before submission, since Google updates them.

## 2. App identity and domain checklist (owner, in Google Cloud Console)

- [ ] OAuth consent screen: app name "VOOM" (match the product name exactly), support email, logo matching the site, developer contact.
- [ ] Support email: the legal pages currently publish a personal Gmail address (`lib/legal/contact.ts`). Google accepts it, but a staffed address on the verified domain is strongly preferred. Owner decision.
- [ ] Authorized domain `voom.today` verified in Google Search Console by a project Owner/Editor.
- [ ] Homepage `https://voom.today/`, Privacy Policy `https://voom.today/privacy`, Terms `https://voom.today/terms`: publicly reachable without sign-in, same domain, and the consent-screen links identical to them.
- [ ] Authorized redirect URI equals the deployed `YOUTUBE_REDIRECT_URI` value — expected `https://voom.today/api/integrations/youtube/callback`. Remove stale preview/localhost URIs from the **production** client. (Value not read here; the owner compares it in Console and Vercel.)
- [ ] Confirm whether `GOOGLE_CLIENT_ID` is shared with Google sign-in. The connect URL sends `include_granted_scopes=true`, so a shared client would merge sign-in scopes into the grant. Least privilege favors a **dedicated YouTube OAuth client**, or removing that parameter. Owner decision; no code change made.
- [ ] Publishing status "In production"; user type External.
- [ ] Scopes registered on the consent screen: exactly the two below, nothing else.

## 3. Scope justifications (paste-ready draft)

**`https://www.googleapis.com/auth/youtube.upload`** — VOOM lets a channel
owner schedule a video or Short they have written and explicitly approved in
VOOM, then uploads it to their own channel with `videos.insert` at the
scheduled time. This is the narrowest scope that permits `videos.insert`. VOOM
never edits, deletes or comments on existing videos. For that reason we do not
request `youtube` or `youtube.force-ssl`.

**`https://www.googleapis.com/auth/youtube.readonly`** — used for three read-only purposes:
(1) `channels.list?mine=true`, to show the user which channel they connected and
to re-validate the authorization periodically;
(2) `videos.list` status/processingDetails, so VOOM reports "Published" only after
YouTube confirms processing;
(3) public statistics (views, likes, comments) on the user's own VOOM-uploaded
videos, shown in Performance and kept for at most 28 days.
`youtube.upload` cannot read any of this, and there is no narrower read scope.
VOOM requests no analytics, monetary, profile or email scopes.

## 4. Consent and in-app copy

- Before the Google redirect, the connect modal states what VOOM will do (upload approved videos, read channel identity, video status and public statistics) and what it will not do (edit or delete existing videos, read revenue).
- Disconnect modal: "Disconnect and delete data". It deletes VOOM's stored YouTube data and asks Google to revoke access, and states that videos on YouTube are not deleted. Independent revocation through Google Security Settings is explained in the Privacy Policy, not in the modal.
- Data deletion: `/data-deletion`, and authenticated `DELETE /api/integrations/youtube/data`, delete VOOM's stored YouTube API data without deleting the VOOM account.

## 5. Demo-video storyboard (≈3–4 minutes, unlisted YouTube link)

1. Browser address bar on `https://voom.today` (show the domain); open Privacy Policy and scroll to the YouTube section, the Google Privacy Policy link and the YouTube ToS link.
2. Sign in with the reviewer test account; open Connections → YouTube → Connect.
3. Google consent screen: pause on the app name, the **full scope list (exactly the two scopes)** and the account chooser. Use a test channel.
4. Back in VOOM: the connected channel identity is shown, read via `youtube.readonly`.
5. Create or open a short draft video, approve it, and schedule it a few minutes ahead. Show the privacy selector set to **private** for the demo.
6. Show the queue moving to uploading → processing → Published only after YouTube confirms. Open the video on YouTube Studio for the test channel.
7. Performance: the statistics shown for that video.
8. Disconnect: show the modal text ("does not delete videos on YouTube"), confirm, and show the connection removed. Then show `myaccount.google.com/permissions` no longer listing VOOM.
9. Show the data-deletion page.

Record with a test channel only. Do not show customer data, tokens, Vercel/Supabase dashboards or environment values.

## 6. Test account and reviewer instructions (owner provides)

- [ ] A dedicated reviewer VOOM account, with a plan entitled to scheduling, and a dedicated test Google account and channel. Credentials go only in the Google form's private field, never in this repository.
- [ ] Reviewer steps: sign in → Connections → Connect YouTube → create/approve a draft → schedule → observe the upload → disconnect.
- [ ] State that uploads go to the reviewer's own channel, and suggest private privacy.

## 7. Changes made on this branch for accuracy

- Removed claims that Google locks unaudited-project uploads to private:
  - YouTube hub banner;
  - Connections detail;
  - editor privacy hint;
  - provider note on applied privacy;
  - config and type comments.
- The banner now discloses the default daily upload quota instead.
- `YOUTUBE_PROJECT_AUDITED` remains a server flag; it no longer drives privacy wording.
- The provider-applied privacy is still read back from YouTube and stored. VOOM still never claims a public publication that did not happen.

## 8. Outstanding Google / account-owner actions

1. All Console items in §2, including the decision on the dedicated client vs `include_granted_scopes`.
2. Approve and publish the updated Privacy/Terms/Data-deletion pages, after eSmart review per `youtube-compliance-release.md`, **before** submitting. The consent-screen links must point at the final text.
3. Record the demo video (§5) and submit OAuth verification.
4. Only if more than 100 uploads/day are needed: submit the YouTube API Services Audit and Quota Extension Form.
5. Deletion-delivery register and alert destinations, named handlers and restore procedure (see `youtube-deletion-delivery.md`). These are not Google requirements for verification, but they are needed to *operate* the 7-day deadlines reliably.
