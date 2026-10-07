// Shared command and receipt validation for the authenticated video path.
class CheVideo {
  static bool isRecentCommand(String raw) => RegExp(
    r'^(?:(?:che|chay|chey|shay)[,:]?\s*)?(?:show|open)(?:\s+me)?\s+(?:my\s+)?recent\s+videos?[.!?]*$',
    caseSensitive: false,
  ).hasMatch(raw.trim());

  static String? topicFromCommand(String raw) {
    final match = RegExp(
      r'^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s*)?(?:please\s+)?(?:make|create|generate)\s+(?:me\s+)?(?:(?:a|an|the)\s+)?(?:(?:faceless|info|stick figure)\s+)?video\s+(?:(?:about|on)\s+)?(.+?)\s*[.!?]*$',
      caseSensitive: false,
    ).firstMatch(raw.trim());
    final topic = match?.group(1)?.trim() ?? '';
    return topic.length >= 3 && !{'about', 'on'}.contains(topic.toLowerCase())
        ? topic
        : null;
  }

  static bool isMediaUrl(String raw) {
    final uri = Uri.tryParse(raw.trim());
    return uri != null &&
        (uri.scheme == 'https' || uri.scheme == 'http') &&
        uri.host.isNotEmpty &&
        uri.userInfo.isEmpty;
  }
}
