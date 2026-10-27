# CHE master profile: "CHE, use my master profile"

CHE fills the form that is open in her iPhone browser from the owner's approved
profiles, the answers he chose to remember, and the on-device password vault.
She fills only. Submitting is a separate command. A payment, purchase or
subscription form also needs his spoken "yes".

## Saying it

| Say or type | What happens |
| --- | --- |
| "CHE, use my master profile" | Fills this page. CHE picks the profile herself, or asks one numbered question. |
| "Fill this with my business profile" / "…my CHE Office profile" | Fills with CHE Office. |
| "Fill this with my personal profile" | Fills with Personal. |
| "Fill everything with my personal profile" | Fills, then presses Next or Continue to reach later pages of the same form, and fills those too. |
| "next page" | Goes on to the form's next page and keeps filling. |
| "continue" / "I'm done" | Resumes after a CAPTCHA or verification step that he completed. |
| "submit it" | Presses the form's submit button. On a payment form CHE first says what it costs and waits for "yes" or "cancel". |
| "remember my answers" | Saves his answers to this site's extra questions (for example "How did you hear about us?") on the phone, for reuse next time. |
| "read the fill details" / "what did you fill" | Lists each field and its status, with sensitive values masked. |
| "generate a password" | Makes a strong password for a sign-up form, saves it to the vault, then fills it. This also happens automatically when a sign-up form is filled. |
| "set my business phone to 602 555 0199" | Saves and approves one profile field. Works for any field below, for Personal or CHE Office. |
| "what's in my business profile" | Says the names of the approved fields and shows their values masked on screen. |
| "open my master profile" | Opens the editor. Each field has an Approve switch. |
| "clear my business website" | Removes a field after an on-screen yes/no (owner rule: removal needs a yes). |
| `/master-profile [personal\|business] [everything]` | The Command Center entry for the same fill. |

Every reply is spoken, shown as large text with a haptic, and **not recorded
in chat history**.

## Privacy boundaries (enforced in code)

- **Profiles, remembered answers and per-site profile choices** are kept only in
  the iPhone Keychain (`lib/browser/che_master_profile.dart`, through
  `CheSecureKv`). They are never sent to the Worker, any AI provider, chat
  history, memory or logs.
- **Passwords** come only from the vault (`lib/security/che_password_vault.dart`),
  after Face ID. An unexpired vault session is reused (`CheVaultAuth.sessionTtl`,
  10 minutes), as "sign me in" already does. A password goes into the page in
  exactly one call, `CheFormFill.setSecret`, which returns only true or false.
  Reports say "Password: filled from vault" or "generated and saved to your
  vault".
- **Generated passwords** (`lib/security/che_password_generator.dart`) use
  `Random.secure`, are at least 20 characters, and follow the field's
  minlength, maxlength, `pattern` and Apple `passwordrules`. Each one is saved to
  the vault before the form can be submitted. If the site's rules can't be met
  safely, CHE leaves the box for the owner.
- **The page engine** (`assets/browser/che_form_fill.js`) runs inside the page
  on the phone. Its results contain labels, classifications and statuses, never
  values. Read-back checking compares each value inside the page and returns a
  status. Errors return only the error's name, because JSON parse messages can
  quote their input. The engine never logs anything.
- **Matching is deterministic.** No AI is called. CHE uses WHATWG autocomplete
  tokens first, then input type, then label, aria-label, placeholder, name and
  id, through a synonym table.
- **Spoken replies name fields, never values.** Replies may go to a cloud voice
  engine for speech, so they carry no values. Masked values appear only on his
  screen.
- **Chat runs these turns before anything reaches the Worker.** `send.dart`
  checks `CheProfileCommand` and `CheFormFillVoice.handler` right after the
  vault check.
- **Live voice (Realtime):** a turn that sets a profile value is dropped from
  the live session's context. The limit is the same as for passwords: Realtime
  streams microphone audio to OpenAI, so those spoken words were already
  transcribed there before CHE saw them. Typing, or the iPhone recognizer,
  avoids that.
- **The Worker** knows only the command name `/master-profile`, and replies
  that filling runs on the iPhone. Its test asserts no model call and no
  profile data stored.
- **Redaction:** `lib/security/che_redact.dart` (`cheRedact`) masks
  key-, token- and password-shaped text for any credential report or log line.

## How the profile is chosen

1. He named it ("business profile", "personal").
2. The page doesn't need a profile, for example a sign-in page: Personal, with
   no question asked.
3. The signed-in account's email domain shown on the page matches one profile's
   email domain. The engine returns domains only.
4. Business fields such as company, EIN, business email or business phone, or
   business wording, choose CHE Office.
5. The profile he chose on this site before.
6. A clearly personal form, or only one profile has approved answers.
7. Otherwise one question: "Which profile should I use on example.com? 1.
   Personal. 2. CHE Office. Say the number." His answer is remembered for that
   site.

On a CHE Office fill, missing name or birthday fields fall back to his Personal
values, since he is the business's contact. A "work" email or phone box is
never filled from Personal.

## Supported fields

| Kind | How |
| --- | --- |
| Text, email, tel, url, textarea, contenteditable | Native value setter, then focus, input, change and blur events. This works with React and Vue controlled inputs. |
| `<select>` | Matches option value or text. US state names and codes both work (AZ / Arizona), and so do country names and ISO-2/ISO-3 codes (US / USA / United States of America). |
| ARIA combobox (`role=combobox`, `aria-haspopup=listbox`) | Types the value, waits for the listbox, clicks the matching `role=option`, then checks it. |
| Dates | Native `type=date` and `month`; split day/month/year selects or boxes; text boxes with a format hint (MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD). With no hint, the page language decides. |
| Phone | Digits only when the box limits length or has a digit pattern; otherwise as he gave it. |
| Radio groups | His remembered answer, matched to option labels. |
| Checkboxes | Only a remembered yes/no. **Consent boxes are never ticked.** |
| Same-origin iframes | Filled like the page. |
| Passwords | Current password from the vault; new password generated, saved, then filled. |

Fields left empty are reported by number ("Left empty because I have no
approved answer: 1. Middle name. 2. How did you hear about us?"). Required
ones are marked "required". CHE never invents an answer.

## Not supported (reported, never attempted)

- File uploads (ID, license, résumé). Reported as "not supported (file
  upload)".
- Signatures, canvas drawing and other custom widgets that are not form
  controls.
- Cross-origin iframes, such as Stripe or Braintree card fields, embedded
  sign-in frames and third-party widgets. Browser security blocks scripts from
  reaching them. They are reported as "a secure box from <host> that I can't
  reach".
- Card numbers, CVC, expiry and SSNs: always left for the owner.
- One-time codes: CHE never fills these from a profile. He reads the code out
  ("type 123456") or enters it himself.
- Sites that block embedded browsers. For example, Google sign-in already opens
  in Safari's in-app view (che_browser.dart).
- Sites that rebuild the whole form on every keystroke. CHE reports any field
  whose value didn't stick as "couldn't confirm".

## CAPTCHA and owner-only steps

- **CAPTCHA** (reCAPTCHA, hCaptcha, Cloudflare Turnstile, "I'm not a robot",
  "verify you are human"): detection only. CHE never clicks, solves or skips
  one. She says what it is and asks him to complete it. The filled form is
  kept: no reload, and the planned values are held in memory on the phone. On
  "continue" she checks that the site's own response field is filled, refills
  anything the page cleared, and carries on.
- **Verification**: 2FA code, email or SMS link, ID upload, or payment approval
  in a bank app. CHE names the exact step, stops, and resumes on "continue".
- **Next vs Submit**: CHE presses only buttons that read as step navigation
  (Next, Continue, Proceed, Save and continue), and only when he said "fill
  everything" or "next page". She never presses Submit, Sign up, Create account,
  Pay, Place order, Buy, Subscribe, Confirm or Finish as part of filling. She
  also won't move on while a required question has no answer.

## Tests

- `node --test tools/che_form_fill_test.mjs`: the real engine in headless
  Chromium (Playwright) against `test/fixtures/forms/`. Covers a multi-page
  sign-up, a checkout with split birthday selects, a same-origin iframe and a
  cross-origin card frame, business registration with an async ARIA combobox,
  file upload and radio, CAPTCHA pause and resume, a 2FA page, and React-style
  controlled inputs. It checks values in the page, that nothing was submitted,
  and that no password or profile value appears in any engine result or console
  line. 7 tests.
- `flutter test test/che_master_profile_test.dart`: 15 tests covering routing,
  profile choice and the numbered question, vault auth before password fill,
  the generated password saved before submit, CAPTCHA resume, page breaks, the
  payment yes, no HTTP client created, and editor VoiceOver labels.
- `flutter test test/che_password_generator_redact_test.dart`: 16 tests.
- `server/cloudflare/command_center.test.mjs`: the `/master-profile` route, no
  model call, no profile data stored.

**Real public forms:** on 2026-10-25 the attempts from the build container
(httpbin.org/forms/post, selenium.dev web-form, the MDN form example, the W3C
WAI tutorial, demoqa.com) were refused by the container's network policy
(proxy 403 to CONNECT). None of them have been tried live yet.

## What only the owner's iPhone can verify

- That WKWebView runs the engine the same way Chromium did in the tests.
  Results come back through `runJavaScriptReturningResult`; ARIA combobox
  timing and iOS date pickers in particular need a check.
- Face ID prompts and the 10-minute vault session in practice.
- Real sites: his bank, government, vendor and sign-up forms, including sites
  that detect or block embedded browsers.
- VoiceOver reading of the editor and the spoken reports, and that live voice
  drops profile-value turns.
- That a CAPTCHA he completes inside CHE's browser is accepted by the site and
  CHE resumes.
