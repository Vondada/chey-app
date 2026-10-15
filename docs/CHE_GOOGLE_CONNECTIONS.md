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
| Google Ads | `adwords` | Read-only: list the accounts this sign-in can reach, and last-7-day campaign results. Needs Setup until Google confirms CHE's access |

Nothing deletes or modifies anything in your accounts. Disconnect removes CHE's
copy of a grant. It asks Google to revoke the grant only when no other CHE
connection shares that sign-in, because a revoke can also end YouTube's. Otherwise
CHE says Google was not asked, and you can remove the permission in Google
Account, Third-party access. Say "disconnect my Gmail" or use the Disconnect
button, and confirm first.

## Asked first (never done on a guess)

Sending an email reads back exactly what will happen, then waits for a plain
**yes**, because it reaches other people and cannot be taken back. A **no**
cancels it. Any other reply drops it, and a held email expires after ten
minutes. Calendar events and Drive docs run on your explicit request, as CHE's
standing rules allow. Reads (checking mail, your calendar, Drive files, Ads
results) run at once.
Campaign changes, budgets and launches are not built and would need your
explicit approval.

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

1. **Google Cloud Console** ([APIs library](https://console.cloud.google.com/apis/library)),
   the project that holds `CHE_YOUTUBE_CLIENT_ID`:
   - Enable the Gmail API, Google Drive API, Google Calendar API and Google Ads API.
   - [Google Auth Platform](https://console.cloud.google.com/auth/overview) → Data
     access: add `gmail.readonly`, `gmail.send`, `drive.file`, `calendar.events`
     and `adwords`.
   - Audience → Test users: add your own Google account.
   - The redirect address does not change; the existing callback is reused.
2. **Google Ads access** (no developer token is needed for CHE's code any more):
   Google moved Ads access to the Cloud project. CHE calls API version `v24` by
   default (v20 and v22 are sunset). Apply for Basic access in the Google Ads API
   Overview in Cloud Console. Google requires brand verification
   for Basic and Standard access. CHE shows Google Ads as Connected only after
   Google lists a real account for your sign-in.
3. **Worker variable `CHE_TIMEZONE`**: already set to `America/Chicago` in
   `wrangler.jsonc`. Change it there if your zone is different.
4. **Tradovate (NinjaTrader)**: set `CHE_TRADOVATE_OAUTH_CLIENT_ID` and
   `CHE_TRADOVATE_OAUTH_CLIENT_SECRET` as Worker secrets. The deploy does not
   sync them yet.
5. **GitHub**: set `CHE_GITHUB_REPO` (for example `Vondada/chey-app`) as a Worker
   variable. The token is already synced.

## Limits to know

- **Testing mode expiry.** While the Google app is in Testing, Google expires
  refresh tokens after 7 days. Reconnect when CHE says "no longer accepts".
  Publishing the app removes that limit, but it needs Google's verification
  first: the Gmail read scope is restricted, and the Calendar and Gmail send
  scopes are sensitive.
- **Drive** shows only what CHE created or you opened with it, by design.
- **Google Ads** shows Needs Setup until Google approves access and lists your
  accounts. Nothing is read or changed before that. CHE's Ads calls have not been
  run against a live account from here; the first real check is yours to confirm.

## Not built

- **Bank accounts.** CHE has no bank-link provider. Choosing one costs money
  and needs your account, so it waits for your choice. CHE never takes bank
  passwords.
- **Meta (Facebook/Instagram) ads.** Needs a Meta app and Meta's app review
  for ads access. Not built against an API we cannot test here.
- **FundYourEdge trading and account data.** The firm's accounts trade on
  Rithmic. Rithmic's order API is licensed, with a developer kit, a conformance
  review and recurring fees before production access, and CHE has no such
  licence. CHE reports the account as not connected and never prepares or places
  an order for it. A generic futures order is left to a connected order broker's
  desk when one is connected. The lower-cost option is for you to read the funded account
  in the firm's own dashboard or TradeSea and tell CHE the figures; CHE does not
  log in to those platforms or scrape them.
