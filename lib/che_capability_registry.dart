class CheCapability {
  const CheCapability({
    required this.id,
    required this.available,
    required this.configured,
    required this.health,
    required this.requiresNetwork,
    required this.readiness,
    this.requiresOwnerPermission = false,
    this.requiresLogin = false,
    this.requiresSecret = false,
    this.readOnly = false,
    this.writeCapable = true,
    this.limitations = '',
    this.lastSuccess,
  });

  final String id;
  final bool available;
  final bool configured;
  final String health;
  final bool requiresNetwork;
  final bool requiresOwnerPermission;
  final bool requiresLogin;
  final bool requiresSecret;
  final bool readOnly;
  final bool writeCapable;
  final String limitations;
  final DateTime? lastSuccess;
  final String readiness;
}

class CheCapabilityRegistry {
  CheCapabilityRegistry(this.capabilities);
  final List<CheCapability> capabilities;

  CheCapability? byId(String id) {
    for (final item in capabilities) {
      if (item.id == id) return item;
    }
    return null;
  }

  bool canDoNow(String id) => byId(id)?.readiness == 'can_do_now';

  static CheCapabilityRegistry fromRuntime({
    required bool network,
    required bool localBrain,
    required bool stripeConfigured,
    required bool smsConfigured,
    required bool voiceHealthy,
  }) {
    CheCapability cap(String id, {bool available = true, bool networkNeeded = false, bool secret = false, bool permission = false}) {
      final up = available && (!networkNeeded || network);
      String readiness = 'can_do_now';
      if (!up && secret) readiness = 'not_connected';
      else if (!up && networkNeeded && !network) readiness = 'temporarily_unavailable';
      else if (!up) readiness = 'unsupported';
      return CheCapability(
        id: id,
        available: up,
        configured: available,
        health: up ? 'ok' : 'down',
        requiresNetwork: networkNeeded,
        requiresSecret: secret,
        requiresOwnerPermission: permission,
        readiness: readiness,
      );
    }

    return CheCapabilityRegistry([
      cap('voice', available: voiceHealthy),
      cap('speech_recognition', available: voiceHealthy),
      cap('tts', available: voiceHealthy),
      cap('chat'),
      cap('memory'),
      cap('files'),
      cap('browser', networkNeeded: true),
      cap('web', networkNeeded: true),
      cap('research', networkNeeded: true),
      cap('office', networkNeeded: true),
      cap('war_room', networkNeeded: true),
      cap('plugins'),
      cap('flagstaff', networkNeeded: true),
      cap('media_generation', networkNeeded: true),
      cap('website_tools', networkNeeded: true),
      cap('business_tools', networkNeeded: true),
      cap('background_jobs', networkNeeded: true),
      cap('model_routing', networkNeeded: true),
      cap('notifications', networkNeeded: true),
      cap('sms', available: smsConfigured, networkNeeded: true, secret: true, permission: true),
      cap('stripe', available: stripeConfigured, networkNeeded: true, secret: true, permission: true),
      cap('local_inference', available: localBrain),
    ]);
  }
}
