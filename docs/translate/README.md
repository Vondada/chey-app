# CHE translation + multilingual

Worker-side only (Groq/Gemini/Workers AI m2m100). No secrets in Flutter.

## Phrases

- `Translate to Spanish: good morning`
- `Translate to ja: hello reference: こんにちは` (quality metrics)
- `Set my language to French` / `Speak in Spanish`

## APIs

- `POST /api/translate` `{ "text", "target_lang", "reference"? }`
- `GET /api/languages`

## Brain / Projects

Successful translates land as `memory_notes` (`kind: translate`, `locale`) and optional project type `translate` with quality metrics.
