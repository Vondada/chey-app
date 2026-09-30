# Translation & multilingual

## Phone

- **More → Language & translate** — sets CHE **reply language** (chat + TTS).
- **More → Translate target** — language for one-shot translate actions.
- Long-press any chat bubble → **Translate to …**
- Chat requests send `reply_language` to the Worker.

## Worker

- `POST /api/translate` `{ "text", "target_lang" }` — Workers AI m2m100 when available, else chat model.
- `GET /api/languages`
- Voice: `Translate to Spanish: good morning`
- System prompt injects `REPLY LANGUAGE` when reply language ≠ English.

Prefs (on device only): `che_reply_language`, `che_translate_target`.
