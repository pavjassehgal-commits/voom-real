# YouTube — Google OAuth verification package

Updated November 1, 2026. This is a preparation pack: it submits nothing and changes no
Google Cloud setting. It contains no secret. Re-check the linked Google pages
immediately before submitting.

## 1. Current official rules (checked 2026-11-01)

| Question | Answer | Source |
|---|---|---|
| Are uploads from an unverified/unaudited project forced to private? | **No.** "Videos uploaded from unverified API projects are not restricted to private viewing mode." Creator account settings can still make an upload private. | YouTube Data API `videos.insert` (updated 2026-10-15) |
| Is a YouTube API compliance audit required to launch? | **No.** It is needed only for quota beyond the default (100 `videos.insert`/day per project, plus 10,000 units for other methods). | Quota and compliance audits (updated 2026-10-15) |
| Is Google OAuth verification required? | **Yes.** The two YouTube scopes need data-access verification for a public External app. App name and logo show on the consent screen only after branding verification, which must come first. A compliant result is valid for 7 days to publish. | Google Auth Platform branding/verification help |
| Privacy policy | Hosted on a verified domain you own, in a dedicated HTML page linked from the homepage. It must disclose how Google user data is accessed, used, stored and shared, and not be a template. | Google Cloud help 13806988 |
| YouTube-specific policy | Must say the app uses YouTube API Services, link the Google Privacy Policy, explain revocation through Google security settings, and give a contact. Terms must link the YouTube Terms and bind users to them. Deletion within 7 days of a request or in-app revocation. | YouTube API Services Developer Policies III.A, III.D.2.c, III.E.4 |

## 2. Readiness

### READY (verified)
- **Homepage:** `https://voom.today/` is public and explains the product (plan, create, schedule and publish across Instagram, TikTok, YouTube and email). It links Privacy, Terms and Data Deletion.
- **Live Terms** bind users to the YouTube Terms (`youtube.com/t/terms`).
- **Live Privacy:**
  - links the Google Privacy Policy and Google permissions settings;
  - includes the Limited Use statement;
  - lists the contact email;
  - describes YouTube access.
- **Least-privilege scopes** (`lib/youtube/scopes.ts`): exactly `youtube.upload` and `youtube.readonly`. No `youtube`, `youtube.force-ssl`, analytics, profile or email scopes.
- **OAuth flow:**
  - server-side authorization code exchange, with a single-use owner-bound state;
  - offline access with consent (needed for scheduled uploads);
  - the callback is pinned to the initiating origin (`docs/youtube-canonical-oauth.md`).
- **The client is YouTube-only:** VOOM has no Google Sign-In (no `signInWithOAuth`/Google provider in the code), so `GOOGLE_CLIENT_ID` serves only YouTube. `include_granted_scopes=true` therefore cannot merge unrelated sign-in scopes.
- **In-app copy:**
  - The connect modal states what VOOM will and won't do: upload approved videos, read identity, status and statistics, never edit or delete videos, keep tokens on the server.
  - Applied privacy is reported truthfully. There is no stale "unaudited = private" claim (fixed in 9cdf214).

### FIXABLE (done on `fix/youtube-oauth-verification`, on top of 74445d0)
- **Done:** the privacy policy now states explicitly that **"Voom uses YouTube API Services"** and what for (policy III.A.2.b). This was missing both live and on the branch. A test covers it.
- **Blocking dependency (code ready, not deployed):**
  - **The gap:** the live Data Deletion page still promises "30 days after verification" and an email-only process. That doesn't meet Google's 7-day rule.
  - **The fix is ready:** the corrected pages (7-day YouTube deletion, in-app deletion, the VOOM-data vs YouTube-videos distinction) are on the compliance branch.
  - **Why it can't ship alone:** those pages must deploy **together with** the behaviour they describe: 0065, 0069, the deletion register and the app release. Publishing the text early would make the policy inaccurate, and Google checks that consistency.

### OWNER ACTION
1. **Release the compliance work** (0065 + 0069 + Cloudflare register + this branch) after eSmart review of the pages. Submit verification only after this is live.
2. **Google Cloud Console** (Google Auth Platform) for the existing project. Check and record:
   - Audience: **External**, publishing status **In production**. In Testing, only listed test users can connect and their grants expire after 7 days.
   - Branding:
     - app name **Voom**, exactly as on the homepage;
     - a logo matching the site;
     - user support email and developer contact;
     - App home page `https://voom.today/`, Privacy `https://voom.today/privacy`, Terms `https://voom.today/terms`;
     - Authorized domain `voom.today`.
   - Domain: verify `voom.today` in Google Search Console as an Owner/Editor of the project.
   - Data access: exactly `.../auth/youtube.upload` and `.../auth/youtube.readonly`. Remove anything else.
   - Clients → the Web client matching Vercel Production `GOOGLE_CLIENT_ID`:
     - Authorized redirect URI exactly `https://voom.today/api/integrations/youtube/callback`;
     - remove obsolete hosts from the Production client once the Production env matches.
   - APIs: **YouTube Data API v3** enabled. Note any warnings on the Verification Center page.
3. **Support email:** the policies publish a personal Gmail. Google accepts it, but a staffed `@voom.today` address reads better to reviewers (update `lib/legal/contact.ts` if changed).
4. **Submit:** first branding verification, then data-access verification with the justifications (section 3) and the demo video (section 5).
5. **Quota audit:** only if more than 100 uploads/day are needed.

## 3. Scope justifications (paste-ready)

**`https://www.googleapis.com/auth/youtube.upload`**: Voom is a marketing workspace. A channel
owner writes or uploads a video in Voom, approves it and schedules it. At the scheduled time,
Voom uploads it to that owner's channel with `videos.insert` (resumable upload). This is
the narrowest scope that permits `videos.insert`. Voom never edits, deletes or comments
on existing videos, so it does not request `youtube` or `youtube.force-ssl`.

**`https://www.googleapis.com/auth/youtube.readonly`**: used read-only for three purposes:
1. `channels.list?mine=true`, to show the owner which channel is connected and to
   periodically re-check that the authorization is still valid.
2. `videos.list` status/processing details, so Voom reports "Published" only after
   YouTube confirms the upload was processed, and shows the privacy YouTube applied.
3. Public statistics (views, likes, comments) for videos Voom uploaded, shown on the
   owner's Performance page and kept no longer than 28 days.

`youtube.upload` cannot read any of this, and no narrower read scope exists. Voom requests
no YouTube Analytics, monetary, profile or email scopes.

## 4. Consent-screen and in-app wording

- **Consent screen:** app name "Voom"; the homepage, privacy and terms links above; and
  the support email. Google renders the scope descriptions itself; Voom cannot change them.
- **Before redirecting to Google (connect modal, already live):** Voom will upload videos only
  after you approve and schedule them; read your channel identity and each uploaded video's
  processing status; and read public statistics for videos Voom published. It never edits or
  deletes your existing videos, and tokens stay encrypted on Voom's server.
- **Disconnect (compliance release):** "Disconnect and delete data". Voom deletes its
  stored YouTube data and asks Google to revoke access; videos on YouTube are not deleted.

## 5. Demo video storyboard (record AFTER the compliance release is live)

Use a dedicated test Google account and test channel, about 4 minutes, uploaded as unlisted.
Show only genuinely live behaviour. Don't show dashboards, environment values, tokens
or customer data, and don't claim the deletion register is operational before it is.

1. **Domain and policies.** Address bar `https://voom.today`. Open Privacy and scroll to:
   "Voom uses YouTube API Services"; the Google Privacy Policy link; Google security
   settings; the 7-day deletion. Open Terms (the YouTube ToS link).
2. **Sign in** with the reviewer VOOM account, then Connections → YouTube → **Connect YouTube**.
   Pause on the pre-consent explanation.
3. **Google consent screen.** Show the URL bar (accounts.google.com), the app name and the
   **complete scope list**. Select the test channel's account and allow.
4. **Connected.** The channel title and handle shown come from `channels.list` (readonly scope).
5. **Upload and schedule.**
   - Create a short video post (upload a test MP4), with title and description, privacy **private**, and the made-for-kids declaration.
   - Approve it and schedule it 2–3 minutes ahead.
6. **Upload executes.** The queue goes from scheduled to uploading, processing and
   **Published** (after YouTube confirms). Open YouTube Studio for the test channel and show
   the video with the same title (`videos.insert`, `youtube.upload`).
7. **Performance.** The video's public statistics in Voom (`youtube.readonly`).
8. **Disconnect.** Connections → YouTube → Disconnect: show the modal text ("Your videos on
   YouTube are not deleted"), confirm, and show the disconnected state.
9. **Revocation.** Open `https://myaccount.google.com/permissions` and show that Voom no
   longer has access (or show removing it there).
10. **Data deletion.** Show the `/data-deletion` page: 7-day YouTube deletion, in-app
    deletion, and the email route.

## 6. Reviewer instructions and test accounts (owner provides)

- A dedicated reviewer VOOM account, on a plan that includes scheduling. Credentials go only in Google's private submission field, never in this repo.
- A test Google account with a test YouTube channel, phone-verified so uploads aren't limited.
- Reviewer steps: sign in → Connections → Connect YouTube → create a video post (sample MP4 provided) → approve → schedule → watch it publish → Performance → Disconnect.
- Note: uploads go only to the reviewer's own connected channel; use private privacy. Voom requests no other Google data.

## 7. Submission order

1. Compliance release live, with the updated policy pages published.
2. Console branding, domain verification and redirect URI clean-up (section 2, owner action 2).
3. Branding verification.
4. Record the demo (section 5).
5. Data-access verification with section 3.
6. Publish within 7 days of a compliant result.
