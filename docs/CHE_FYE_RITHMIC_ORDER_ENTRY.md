# FundYourEdge + Rithmic: can CHE send orders? (investigation, 2026-10-23)

Owner request (2026-10-23, item 17): find out whether the owner's FundYourEdge (FYE) Rithmic account supports authorized order entry, and whether the provider permits this integration. Until the answer is **yes, in writing, from both FYE and Rithmic**, CHE's live order submission stays disabled (`kCheLiveOrderSubmissionEnabled = false` in `lib/trading/che_live_order.dart`).

## Short answer

| Question | Status | Evidence |
|---|---|---|
| Does CHE's Rithmic connection support orders today? | **No.** | CHE logs in to the **ticker plant only** (market data). `lib/rithmic/rithmic_wire.dart` says "there is deliberately no order-entry message here". No order plant, PnL plant or order message exists in the code. |
| Can a third-party app route orders over Rithmic's R\|Protocol API? | **Only after Rithmic approval (conformance).** | Rithmic's API page says developers can build against the test system without conformance, but must pass a conformance review before connecting to production systems and any FCM. Found via search on 2026-10-23: https://www.rithmic.com/products/api-suite. The page could not be fetched from this environment (DNS refused), so this is from the search result's summary. |
| Where is conformance tested? | Rithmic's paper-trading / exchange simulator environment. | https://www.rithmic.com/products/exchange-simulator (search summary, 2026-10-23). |
| Does FundYourEdge allow automated or API order entry on its Rithmic accounts? | **UNCONFIRMED.** | No FYE page found that states its policy on bots, algorithms, APIs or third-party order-routing software. The FYE knowledge base (https://help.fundyouredge.com/article/17-what-is-fundyouredge) describes a simulated environment with real market data and says nothing about automation. Its site could not be fetched from this environment. |
| Does the FCM / broker behind the account need to approve it? | **Likely yes; unconfirmed for FYE.** | Lincoln Park Futures says API access, data and production permissions are approved per broker/FCM, and not every FCM supports every Rithmic service: https://lpfutures.com/best-futures-trading-api/ (secondary source). |

**Nothing here proves CHE is permitted to place orders on the owner's FYE account.** Other prop firms differ widely. Funded Futures Family is reported to ban bots, and Alpha Futures is reported to ban "AI, bots and other automated trading mechanisms". Firm rules change often, so FYE's own written answer is the only one that counts.

## What the owner needs to ask

**Ask FundYourEdge support, in writing:**
1. Are API-based or third-party orders allowed on my Rithmic funded and evaluation accounts? This means orders an app sends through Rithmic's R|Protocol API, not orders I click in R|Trader or a listed platform.
2. If so, which tools are allowed: fully automated, semi-automated (I approve each order with Face ID), or alert-to-order?
3. Does an app need FYE's approval or whitelisting? Is there a list of approved platforms?
4. Which Rithmic system and gateway do my accounts use for orders? Does order routing need an extra entitlement or fee?
5. Do any rules restrict order rate, HFT, news trading, or the use of the simulated fills?

**Ask Rithmic** (or ask FYE to forward):
1. The R|Protocol API developer kit and licence terms for a private, single-user app.
2. The conformance steps, test environment, timeline and any fees to enable order routing for app name "CHE".
3. Whether my user ID can be enabled for API order routing on FYE's FCM.

## What CHE already enforces

- **No send path.** Live order submission is a compile-time `false`. The Live Order Preview screen shows the account, contract, side, quantity, entry, stop, target, dollar risk and estimated fees, then refuses to send.
- **Face ID on every order.** Every Approve asks Face ID with a fresh prompt (`requireFaceId: true`). A passed check is never reused for another order. A failed check sends nothing.
- **No paper-to-live switch.** CHE's paper engine has no broker module, and nothing switches a paper trade to live.
- **Honest broker status.** Acknowledgments, order IDs, fills and rejections are shown only from a broker's own response. Until one exists, the screen says "not supported yet".
- **Labels everywhere.** Every surface is labelled MY ACCOUNT, CHE PAPER ACCOUNT or LIVE ACCOUNT.
- **Append-only audit.** Every preview, Face ID result, block and refusal is appended to the on-device audit (`CheLiveOrderAudit`).

## Still required before real money

1. FYE's written permission (above).
2. Rithmic conformance approval and production credentials for order routing.
3. An order-plant client (login to the order plant, new-order / cancel / modify messages, order and fill notifications) built and tested on Rithmic's test system.
4. Server- or device-side risk controls tested end to end: max contracts, daily loss limit, mandatory stop, and a kill switch.
5. End-to-end execution tests on the Rithmic test environment: acknowledgment, fill, partial fill, rejection, cancel and disconnect recovery.
6. A reviewed code change that flips `kCheLiveOrderSubmissionEnabled`. It is deliberately not a setting.

## Sources (searched 2026-10-23)

- Rithmic, R|API / R|Protocol API suite: https://www.rithmic.com/products/api-suite
- Rithmic, Exchange Simulator: https://www.rithmic.com/products/exchange-simulator
- FundYourEdge knowledge base, "What is FundYourEdge?": https://help.fundyouredge.com/article/17-what-is-fundyouredge
- Lincoln Park Futures, futures API brokers: https://lpfutures.com/best-futures-trading-api/
- QuantLabs, "What Is a Rithmic API Conformance Test?" (secondary): https://www.quantlabsnet.com/post/what-is-a-rithmic-api-conformance-test
- PickMyTrade, prop-firm automation FAQ (secondary, vendor): https://pickmytrade.io/faq/prop-firm-automation/
- TradersPost, Funded Futures Family automation (secondary): https://blog.traderspost.io/article/automate-funded-futures-family-with-traderspost
