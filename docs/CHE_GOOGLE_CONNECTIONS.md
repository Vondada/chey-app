# CHE Google connections: Gmail, Drive, Calendar, Google Ads

One Google OAuth client (the one YouTube already uses, `CHE_YOUTUBE_CLIENT_ID`)
serves four services. Each service is its own Google sign-in, so the owner
approves each one on its own screen and CHE asks only for that service's
permissions. Tokens are sealed in CHE's store with `CHE_OAUTH_SECRET` and never
reach the app. The app shows state and the signed-in address only.

| Service | Permissions requested | What CHE can do |
|---|---|---|
| Gmail | `gmail.readonly`, `gmail.send` | List unread or matching mail; send plain-text email on your command |
| Google Drive | `drive.file` | List files CHE created or you opened with it; create a Google Doc |
| Google Calendar | `calendar.events` | List events for today, tomorrow or this week; add an event |
| Google Ads | `adwords` + developer token | List the ad accounts this sign-in can reach (listing only) |

Nothing deletes, modifies or moves anything. Removing a connection is not in the
app yet: revoke CHE in your Google Account → Security → Third-party access.

## Spoken requests (Chat)

- "check my email", "read my new email"
- "send an email to ann@example.com saying lunch at noon"
- "what's on my calendar today" (also tomorrow, this week)
- "add dentist on 2026-10-20 at 2:30 pm"
- "list my drive files", "create a doc called Plan with Step one"

Each one runs for real and CHE says the real result. A service that is not
connected is named, and nothing is done.

## Connect by voice or the Connections page

"connect my Gmail", "connect Google Drive", "connect my calendar",
"connect Google Ads". Each opens Google's own sign-in. A grant is stored only
after Google returns with the approved permissions.

## Owner steps (only you can do these)

1. **Google Cloud Console**, the project that holds `CHE_YOUTUBE_CLIENT_ID`:
   - APIs & Services → Library: enable Gmail API, Google Drive API,
     Google Calendar API and Google Ads API.
   - OAuth consent screen → Data access: add
     `gmail.readonly`, `gmail.send`, `drive.file`, `calendar.events`, `adwords`.
   - Test users: add your own Google account.
   - The redirect address does not change; the existing callback is reused.
2. **Google Ads developer token** (for Google Ads only): apply in Google Ads API
   Center from a manager account. Then set the Worker secret
   `CHE_GOOGLE_ADS_DEVELOPER_TOKEN`. Optional: `CHE_GOOGLE_ADS_API_VERSION`
   (default `v20`).
3. **Worker variable `CHE_TIMEZONE`**: your IANA zone, for example
   `America/Chicago`. Calendar times use it. The default is `America/Chicago`.
4. **Tradovate (NinjaTrader)**: set `CHE_TRADOVATE_OAUTH_CLIENT_ID` and
   `CHE_TRADOVATE_OAUTH_CLIENT_SECRET` as Worker secrets. The deploy does not
   sync them yet.
5. **GitHub**: set `CHE_GITHUB_REPO` (for example `Vondada/chey-app`) as a Worker
   variable. The token is already synced.

## Limits to know

- **Testing mode expiry.** While the Google app is in Testing, Google expires
  refresh tokens after 7 days. Reconnect when CHE says "no longer accepts".
  Publishing the app removes that limit, but Gmail and Drive scopes are
  restricted and need Google's verification first.
- **Email sends immediately** when you ask, under your standing permission. A
  wrong address is sent. Say the full address.
- **Drive** shows only what CHE created or you opened with it, by design.
- **Google Ads** shows nothing until the developer token is approved.

## Not built

- **Bank accounts.** CHE has no bank-link provider. Choosing one costs money
  and needs your account, so it waits for your choice. CHE never takes bank
  passwords.
- **Meta (Facebook/Instagram) ads.** Needs a Meta app and Meta's app review
  for ads access. Not built against an API we cannot test here.
- **Disconnect in the app.** Revoke at Google for now.
