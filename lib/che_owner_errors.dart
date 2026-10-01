/// Owner-facing error sanitizer. Raw router dumps stay out of Chat.
class CheOwnerError {
  const CheOwnerError({
    required this.category,
    required this.message,
    this.retryable = true,
  });

  final String category;
  final String message;
  final bool retryable;

  static const _raw = [
    'all ai engines failed',
    'retry limit reached',
    'enospc',
    'stack trace',
    'pollinations',
    'llm7',
    'gsk_',
    'sk-',
    'aiza',
    'bearer ',
  ];

  static CheOwnerError fromRaw(String raw, {int? status}) {
    final lower = raw.toLowerCase();
    var category = 'temporary_cloud_unavailable';
    if (lower.contains('offline') || lower.contains('socket') || lower.contains('network')) {
      category = 'network_offline';
    } else if (status == 401) {
      category = 'authentication_required';
    } else if (lower.contains('voice') && lower.contains('unavail')) {
      category = 'voice_unavailable';
    }
    if (status != null ||
        _looksRaw(lower) ||
        _technical.hasMatch(raw) ||
        lower.contains('engines failed') ||
        lower.contains('retry limit')) {
      return CheOwnerError(
        category: category,
        message: _messageFor(category),
      );
    }
    final trimmed = raw.trim();
    if (trimmed.length > 280) {
      return CheOwnerError(category: category, message: _messageFor(category));
    }
    return CheOwnerError(category: category, message: trimmed.isEmpty ? _messageFor(category) : trimmed);
  }

  static bool _looksRaw(String lower) => _raw.any(lower.contains);

  // Status codes, exceptions and timeouts are engine plumbing, not something
  // the owner should ever have to read.
  static final RegExp _technical = RegExp(
    r'\b(?:error|status|http)\s*\d{3}\b|exception|timed? ?out|timeout|failed|stack|null check|\{"|errno',
    caseSensitive: false,
  );

  static String _messageFor(String category) {
    switch (category) {
      case 'network_offline':
        return "I can't reach the internet right now, sir. I'll keep going with what I have on this phone.";
      case 'voice_unavailable':
        return 'My spoken voice is down, sir. I still have your text and the iPhone voice as backup.';
      case 'authentication_required':
        return "That engine needs a key on the Worker, sir. I skipped it and moved on.";
      default:
        return "One moment, sir. I'm switching to a backup engine.";
    }
  }
}
