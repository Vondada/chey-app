class OfficeTask {
  OfficeTask.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        title = j['title'] as String,
        whyItMatters = j['whyItMatters'] as String,
        assignedAgent = j['assignedAgent'] as String,
        requestedOutput = j['requestedOutput'] as String,
        label = j['label'] as String,
        status = j['status'] as String,
        result = j['result'] as String?,
        error = j['error'] as String?,
        verifiedByChe = j['verifiedByChe'] as bool? ?? false,
        createdAt = DateTime.parse(j['createdAt'] as String);

  final String id, title, whyItMatters, assignedAgent, requestedOutput, label, status;
  final String? result, error;
  final bool verifiedByChe;
  final DateTime createdAt;

  bool get failed => status == 'failed';
}