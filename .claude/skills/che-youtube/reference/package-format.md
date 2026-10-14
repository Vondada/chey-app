# Video package format (`check_package.mjs`)

| Field | Required | Rules |
|---|---|---|
| `topic` | yes | At least 3 characters. |
| `target_seconds` | no | The free renderer makes 5–90 s. Narration is estimated at 150 words per minute, with a ±15% tolerance. |
| `title` | yes | 100 characters or fewer, the YouTube and CHE uploader limit. Over 70 gives a warning (cut in search). No `<` or `>`. |
| `description` | no | 5000 characters or fewer (YouTube). Over 500 gives a warning, because CHE's uploader keeps only the first 500. |
| `tags` | no | Array of strings, 500 characters or fewer in total (YouTube counts quotes around tags with spaces). |
| `thumbnail_text` | no | 6 words or fewer. Every number in it must appear in the script. |
| `sources` | for factual claims | `[{ id, url (https), title, accessed }]`. Only pages actually opened. |
| `script` | yes | `[{ say, show }]` or one string. A factual sentence must end with a citation like `[1]` or `[1, 2]`. A sentence counts as factual when it has numbers, years, percentages, records ("first", "largest"), studies, or attributions ("according to"). |
| `privacy` | no | `unlisted` (default), `private` or `public`. `public` requires `owner_publish_approval`. |
| `owner_publish_approval` | to publish | `{ "quote": "the owner's own words", "at": "ISO time" }`. Leave `null` until he says yes. |

Exit codes: 0 means ready to render, 1 means not ready, 2 means unreadable input. `ready_to_publish` is true only with zero errors and the approval present.
