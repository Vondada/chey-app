# CHE Privacy Center

Status (2026-10-25): built on branch `lane/privacy-center`. Not merged, not deployed, not tested on the owner's iPhone.

This is Stage 5 of `docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md` (branch `chatgpt/modal-free-first-usage-privacy-plan`), with its acceptance tests 7 and 8. It is separate from the GPU, Modal, compute and usage features and touches none of their files.

## What the owner can do now

| Say or type | What happens |
|---|---|
| "My SSN is …" (any form) | Nothing leaves the iPhone. CHE says she does not keep SSNs and names the official sites: ssa.gov/myaccount, the IRS IP PIN page and the three credit bureaus. |
| "Open Privacy Center" (or More → Privacy Center) | Opens the room without speaking. Read Aloud reads it. |
| "Turn on Privacy Center" | Records the consent on the iPhone with the time and the exact words, then lists the services connected in CHE, by name. |
| "Turn off Privacy Center" | Says what will be deleted and waits. "Yes" deletes the Privacy Center data on the iPhone and checks that none is left. "No" keeps it. |
| "Check my passwords for breaches" | Checks every password in the on-device vault against Have I Been Pwned. Only 5 hex characters per password leave the phone. CHE reports site names and counts. |
| "Show me the data brokers" | Reads the people-search sites as a numbered list. |
| "Request removal for number 2", "monitor number 3", "ignore number 4", "mark number 2 resolved" | Stores the action with its time on the iPhone. A removal request opens that site's official opt-out page for the owner to fill in. |
| "Add Chase to my privacy list" | Adds a service by name only. |
| "Freeze my credit" | Reads the official freeze links. "Open number 1" opens one. |
| "Has my email been in a breach?" | Says the automatic check needs a paid key. The owner can search for himself, free, on haveibeenpwned.com. |
| `/privacy-center …` | The same, from the Commands page or chat. |

## The SSN guard (highest priority)

- **The rule.** CHE never stores a full Social Security number in memory, logs, prompts, analytics, the Brain or the mailbox.
- **What counts as an SSN.**
  - A dashed `123-45-6789` with a valid SSN shape. The area cannot be 000, 666 or 900–999, the group cannot be 00 and the serial cannot be 0000.
  - Nine digits written any other way, when an SSN word is nearby: spaced, bare, spoken ("one two three …") or with "dash" between digits. The SSN words are SSN, social security, "my social", SS#, ITIN and taxpayer ID.
- **What does not count.**
  - Phone numbers: 10 digits, or the 3-3-4 shape.
  - "The last four of my social are 6789".
  - Dates.
  - Order numbers and other 9-digit numbers with no SSN word nearby.
  - "my social media …".
- **On the phone** (`lib/security/che_ssn_guard.dart`, mirrored by the Worker's checks):
  - `sendMessage` in `lib/home_state/send.dart` checks typed and spoken text first and answers on the phone. The number is never sent to the Worker, a model, chat history or logs. This check is additive; the navigation logic is unchanged.
  - With live voice (OpenAI Realtime), an SSN turn is dropped from the live session, and the next words go to the iPhone recognizer (`lib/home_state/security.dart`).
  - **Residual limit:** Realtime streams raw audio to OpenAI, so OpenAI has already transcribed that audio before CHE sees the words. The same limit is documented for passwords.
- **On the Worker** (defense in depth, `server/cloudflare/security_core/ssn.js`):
  - `http_io.js bodyOf` removes SSNs from every JSON request body before any route runs. A chat message that held one gets the fixed reply with no model call. This applies to guests too.
  - The post-reply copy that records conversation memory is also cleaned.
  - `security_core/secrets.js scanSecrets` reports SSNs as findings. That covers the final model guard (`guardModelInput`) and the redaction of chat history and logs (`redact`, `redactDeep`).
  - `research_memory.js hasSecretShape` refuses SSNs, which covers `/api/memory/add`, the Brain store and the memory filters.
  - `mailbox.js sendMail` removes SSNs before anything is written to GitHub.

## Breach checks with free, official tools

- **Passwords: Have I Been Pwned Pwned Passwords range API.** It is free, needs no key and has no rate limit.
  - The check runs only on the phone, only when the owner asks (`CheBreachChecker`).
  - It sends `GET https://api.pwnedpasswords.com/range/<first 5 hex chars of SHA-1>` with `Add-Padding: true`. The password, the full hash and the 35-character suffix never leave the phone.
  - Padding rows have a count of 0 and are ignored.
  - The stored result holds the site name and count only.
- **Email breach lookup: not available at $0.** HIBP's breached-account API needs a paid subscription. Current plans start at Core, $4.39 a month billed annually. The only free key is a test key that works only against HIBP's test domain.
  - What CHE does instead: it opens haveibeenpwned.com, where the owner can search his own address for free.
- **Credit freezes and monitoring.** CHE only opens the official pages, and the owner enters his details there. The links open in Safari's in-app view, so CHE cannot see what is typed.
  - Equifax, Experian and TransUnion freeze pages.
  - The CFPB page: freezes are free by federal law and must be placed at each bureau.
  - IdentityTheft.gov.
  - AnnualCreditReport.com: free weekly reports.
  - my Social Security.
  - IRS IP PIN.
  - CHE does not run paid credit monitoring.
- **"Everywhere my SSN exists" cannot be built.** No universal searchable inventory of private organizations' records exists. CHE says so and does not promise it.

## Data brokers (people-search sites)

Researched on 2026-10-25. "Official" means the page came up from the site's own domain in a search restricted to that domain. "Unconfirmed" means the address appears consistently across third-party guides, but the search tool could not read the site itself, so the room labels it "address not confirmed on the site".

| Site | Opt-out page | Status |
|---|---|---|
| California DROP (all registered brokers, CA residents) | https://privacy.ca.gov/drop/ | Official (CPPA) |
| Spokeo | https://www.spokeo.com/optout | Official |
| PeopleFinders | https://www.peoplefinders.com/remove-my-info | Official |
| Whitepages | https://www.whitepages.com/suppression-requests | Unconfirmed |
| BeenVerified | https://www.beenverified.com/app/optout/search | Unconfirmed |
| Intelius / TruthFinder / Instant Checkmate / US Search (PeopleConnect) | https://suppression.peopleconnect.us/ | Unconfirmed |
| TruePeopleSearch | https://www.truepeoplesearch.com/removal | Unconfirmed |
| FastPeopleSearch | https://www.fastpeoplesearch.com/removal | Unconfirmed; some guides give `/optout` |

Left out on purpose:
- **Radaris:** one 2026 list reports its domain was transferred by court order on 2026-10-08.
- **MyLife:** no official removal page was found, only an email address.

How the actions work:
- **Actions:** MONITOR, REQUEST REMOVAL, IGNORE and MARK RESOLVED. Each is stored on the iPhone (Keychain) with a UTC timestamp, and the full history is kept.
- **Request removal:** CHE opens the official page and never submits a form. It says plainly that nothing was submitted, and it never says data was erased.
- **Mark resolved:** the owner says it ("on your word"), for example after the site's confirmation email.
- **Limits:** each opt-out covers only that site. Sites say data can reappear from new public records, so MONITOR exists to check again later.

## The inventory and consent

- **Off by default.** The inventory, actions and password check refuse while the Privacy Center is off, and nothing is written. The official links still work.
- **Consent record.** It is stored as `{at, words}`. Spoken or typed consent keeps the owner's exact words; the button records "Turn on Privacy Center (button)".
- **Services listed.**
  - Services connected in CHE, from `GET /api/privacy/services`. It is owner-only and returns names only: the ready external connectors (Gmail, Drive, Calendar, YouTube, GitHub, Stripe, Twilio, NinjaTrader, the voice provider, Google Ads) and verified service-onboarding records. Fingerprints, tokens and accounts never leave the Worker.
  - Services the owner added by voice.
- **Storage.** Everything is kept in the iPhone Keychain (`che_privacy_center_v1`), never sent to the Worker, a model, chat history, memory or logs.

## Screen and voice

- **The room.** `lib/rooms/che_privacy_center_room.dart` uses large text, gives every button a VoiceOver label, has a header for each section and a live-region banner for results. Its icons come only from `test/fixtures/release_icons.txt`.
- **Silent on open.** Read Aloud, spoken commands and button actions speak their real result, with a haptic.
- **Screen awareness.** "What is on my screen?" is answered from the room's own report.
- **Voice routes.** `cheParsePrivacyVoice` runs on the phone, before the Worker. While the room is open it also handles the numbered actions, yes or no, "add …" and "read this".
- **Opened by the Worker.** `privacy_center.js privacyIntent` / `/privacy-center` (one entry in `command_catalog.js`) answers with `open_screen: privacy_center`. `streaming.dart` opens the room only for `source: che_privacy_center`.

## Location (not built: future work)

CHE does not track location. A separate opt-in location feature would need:
- **Its own opt-in,** separate from this one, with consent stored the same way and revocable.
- **iOS permissions.**
  - `NSLocationWhenInUseUsageDescription` for use while the app is open. `NSLocationAlwaysAndWhenInUseUsageDescription` and `requestAlwaysAuthorization` only if background use is truly needed ([Apple: CLLocationManager](https://developer.apple.com/documentation/corelocation/cllocationmanager), [Apple: the Always key](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationalwaysandwheninuseusagedescription)).
  - The Background Modes capability, a new IPA, and the owner's choice in iOS Settings.
  - iOS always shows when location is in use; no covert tracking.
- **Controls.**
  - Pause and resume by voice.
  - Retention limits, for example 30 days by default and deleted on schedule.
  - "Delete my location history" with confirmation.
  - Export as a file the owner keeps.
  - Kept on the device by default and never sent to model prompts or GPU workers.
- **Honesty.** It cannot tell which businesses hold the owner's location data. That data lives with app makers, carriers and data brokers, and the broker opt-outs above are the lawful route.

## Tests

- `server/cloudflare/privacy_center.test.mjs` has 11 tests. They cover:
  - detection and its exclusions;
  - every shared redaction layer;
  - the mailbox;
  - a `/api/chat` replay (owner and guest) proving no model call and that no SSN reaches storage or memory;
  - history with an SSN never reaching the model;
  - routing for the voice phrases and `/privacy-center`;
  - the names-only services route.

  Written failing-first: 7 of the 11 failed before the Worker integration.
- `test/che_privacy_center_test.dart` has 12 tests. They cover:
  - the mirrored SSN detection;
  - consent gating and turn-off confirmation;
  - k-anonymity with a fake HTTP client: only 5 hex characters go out, never the password, suffix or username, and padding is ignored;
  - honest error reporting;
  - actions persisting across a restart;
  - voice parsing;
  - the room's semantics, with no speech on open;
  - the full app's chat send: the SSN never reaches the server, ordinary chat still does, and "turn on Privacy Center" stays on the phone.

  The send test fails when the `send.dart` guard is disabled.

## Sources (checked 2026-10-25)

- Have I Been Pwned: [API v3 docs](https://haveibeenpwned.com/API/V3), [subscription plans](https://haveibeenpwned.com/Subscription), [support: no free keys](https://support.haveibeenpwned.com/hc/en-au/articles/10388846218511-Do-you-provide-free-trials-sample-data-or-free-API-Keys), [support: services and pricing](https://support.haveibeenpwned.com/hc/en-au/articles/13262081649935-What-services-do-you-offer-and-how-are-they-priced), [support: getting started with Pwned Passwords](https://support.haveibeenpwned.com/hc/en-au/articles/15316377846671-I-wish-to-use-the-Pwned-Passwords-API-How-can-I-get-started), [Troy Hunt: padding](https://www.troyhunt.com/enhancing-pwned-passwords-privacy-with-padding/), [Cloudflare: padding](https://blog.cloudflare.com/pt-br/pwned-passwords-padding-ft-lava-lamps-and-workers).
- Credit freezes: [CFPB](https://www.consumerfinance.gov/ask-cfpb/what-is-a-credit-freeze-or-security-freeze-on-my-credit-report-en-1341/), [Equifax](https://www.equifax.com/personal/help/article-list/-/h/a/place-lift-remove-security-freeze/), [Experian](https://www.experian.com/help/credit-freeze/), [TransUnion](https://www.transunion.com/credit-freeze), [FTC: freeze or fraud alert](https://consumer.ftc.gov/credit-freeze-or-fraud-alert-right-you), [IdentityTheft.gov](https://www.identitytheft.gov/Steps), [FTC: free weekly credit reports](https://consumer.ftc.gov/consumer-alerts/2023/10/you-now-have-permanent-access-free-weekly-credit-reports).
- SSN protection: [my Social Security](https://www.ssa.gov/myaccount/), [SSA: if someone uses my SSN](https://www.ssa.gov/faqs/en/questions/KA-02238.html), [IRS IP PIN](https://www.irs.gov/identity-theft-fraud-scams/get-an-identity-protection-pin).
- Data brokers: [California DROP](https://privacy.ca.gov/drop/), [CPPA data brokers](https://cppa.ca.gov/data_brokers/), [Spokeo opt-out](https://www.spokeo.com/optout), [PeopleFinders remove my info](https://www.peoplefinders.com/remove-my-info), [PeopleFinders help](https://help.peoplefinders.com/hc/en-us/articles/360041685993-How-do-I-remove-my-information-from-PeopleFinders). Third-party guides for the unconfirmed addresses: [TechRadar: Whitepages](https://www.techradar.com/how-to/how-to-opt-out-of-whitepages), [TechRadar: BeenVerified](https://www.techradar.com/how-to/how-to-opt-out-of-beenverified), [Mozilla Monitor: Intelius](https://www.mozilla.org/en-US/products/monitor/intelius-guide-to-remove-my-info), [DuckDuckGo: TruthFinder](https://duckduckgo.com/duckduckgo-help-pages/truthfinder-opt-out), [DuckDuckGo: TruePeopleSearch](https://duckduckgo.com/duckduckgo-help-pages/truepeoplesearch-removal), [Optery: FastPeopleSearch](https://www.optery.com/fastpeoplesearch-how-to-opt-out-of-fastpeoplesearch-com/), [Krebs on Radaris](https://krebsonsecurity.com/2024/03/a-close-up-look-at-the-consumer-data-broker-radaris/).
- Location: [Apple CLLocationManager](https://developer.apple.com/documentation/corelocation/cllocationmanager), [Apple NSLocationAlwaysAndWhenInUseUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationalwaysandwheninuseusagedescription).

Not verified: the live HIBP endpoint could not be called from the build container, because outbound access to haveibeenpwned.com and api.pwnedpasswords.com is blocked there. The request format follows the sources above and is tested with a fake HTTP client only.
