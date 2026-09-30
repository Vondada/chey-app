// CHE languages — reply language + translate targets (phone UI).

class CheLanguage {
  const CheLanguage({required this.code, required this.name, required this.ttsLocale});
  final String code;
  final String name;
  final String ttsLocale;
}

const List<CheLanguage> cheLanguages = [
  CheLanguage(code: 'en', name: 'English', ttsLocale: 'en-US'),
  CheLanguage(code: 'es', name: 'Spanish', ttsLocale: 'es-ES'),
  CheLanguage(code: 'fr', name: 'French', ttsLocale: 'fr-FR'),
  CheLanguage(code: 'de', name: 'German', ttsLocale: 'de-DE'),
  CheLanguage(code: 'pt', name: 'Portuguese', ttsLocale: 'pt-BR'),
  CheLanguage(code: 'it', name: 'Italian', ttsLocale: 'it-IT'),
  CheLanguage(code: 'zh', name: 'Chinese', ttsLocale: 'zh-CN'),
  CheLanguage(code: 'ja', name: 'Japanese', ttsLocale: 'ja-JP'),
  CheLanguage(code: 'ko', name: 'Korean', ttsLocale: 'ko-KR'),
  CheLanguage(code: 'ar', name: 'Arabic', ttsLocale: 'ar-SA'),
  CheLanguage(code: 'hi', name: 'Hindi', ttsLocale: 'hi-IN'),
  CheLanguage(code: 'ru', name: 'Russian', ttsLocale: 'ru-RU'),
  CheLanguage(code: 'uk', name: 'Ukrainian', ttsLocale: 'uk-UA'),
  CheLanguage(code: 'pl', name: 'Polish', ttsLocale: 'pl-PL'),
  CheLanguage(code: 'tr', name: 'Turkish', ttsLocale: 'tr-TR'),
  CheLanguage(code: 'vi', name: 'Vietnamese', ttsLocale: 'vi-VN'),
  CheLanguage(code: 'th', name: 'Thai', ttsLocale: 'th-TH'),
  CheLanguage(code: 'id', name: 'Indonesian', ttsLocale: 'id-ID'),
  CheLanguage(code: 'nl', name: 'Dutch', ttsLocale: 'nl-NL'),
  CheLanguage(code: 'sv', name: 'Swedish', ttsLocale: 'sv-SE'),
];

CheLanguage cheLanguageByCode(String? code) {
  final c = (code ?? 'en').toLowerCase().split(RegExp(r'[-_]')).first;
  return cheLanguages.firstWhere((l) => l.code == c, orElse: () => cheLanguages.first);
}
