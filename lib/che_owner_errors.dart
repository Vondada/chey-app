import 'dart:convert';

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

  /// Removes internal provider/model failover narration before it can reach
  /// owner chat or TTS. Legitimate discussion of backup models is preserved.
  static String sanitizeReply(String raw) {
    final text = raw.trim();
    if (text.isEmpty) return '';
    final failover = RegExp(
      r"^(?:one moment,?\\s*(?:sir[,.]?)?\\s*)?(?:i(?:'m| am)\\s+)?switch(?:ing)? to (?:a )?(?:backup|fallback|different|another) (?:ai )?(?:engine|provider|model)[.!]?$",
      caseSensitive: false,
    );
    return failover.hasMatch(text) ? '' : text;
  }

  static CheOwnerError fromRaw(String raw, {int? status}) {
    // The Worker already sends owner-safe wording in `detail` (for example
    // "Nothing was done" on a final failure). Keep it rather than replacing
    // it with a generic "still working" line.
    final serverDetail = _safeServerDetail(raw);
    if (serverDetail != null) {
      return CheOwnerError(
        category: 'temporary_cloud_unavailable',
        message: serverDetail,
      );
    }
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

  static String? _safeServerDetail(String raw) {
    final start = raw.indexOf('{');
    if (start < 0) return null;
    try {
      final decoded = jsonDecode(raw.substring(start));
      if (decoded is! Map) return null;
      final detail = decoded['detail']?.toString().trim() ?? '';
      if (detail.isEmpty || detail.length > 280) return null;
      final lower = detail.toLowerCase();
      if (_looksRaw(lower) || _technical.hasMatch(detail) || lower.contains('engine')) {
        return null;
      }
      return detail;
    } catch (_) {
      return null;
    }
  }

  // Status codes, exceptions and timeouts are engine plumbing, not something
  // the owner should ever have to read.
  static final RegExp _technical = RegExp(
    r'\b(?:error|status|http)\s*\d{3}\b|exception|timed? ?out|timeout|failed|stack|null check|\{"|errno',
    caseSensitive: false,
  );

  static String _messageFor(String category) {
    switch (category) {
      case 'network_offline':
        return "I lost the network connection, sir. I saved the job and will resume it automatically when the connection returns.";
      case 'voice_unavailable':
        return 'My spoken voice is down, sir. I still have your text and the iPhone voice as backup.';
      case 'authentication_required':
        return "One moment, sir. I'm still working on that.";
      default:
        return "One moment, sir. I'm still working on that.";
    }
  }
}
