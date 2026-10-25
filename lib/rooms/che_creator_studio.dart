// Shared Studio pieces. The Creator Studio room (ON AIR panel, render queue and a Studio | Music switch) became the
// Music Studio on 2026-10-25 (lib/rooms/che_music_studio.dart): the render queue moved to the Creation Room's
// Working now, and the video tools that use [CheStudioAction] live in Film Studio.

import 'package:flutter/material.dart';

/// Coding and repository work (self-development, PRs, deploys, app builds, skill imports, exams). It belongs in Projects and Office, never in the
/// Music or Create render queue (2026-10-22: the coding investigation history showed up inside Music).
const _kCodingJobKinds = {
  'self_development', 'software_agent', 'repo_study', 'verify_deploy', 'merge_pr', 'pr_opened', 'merged',
  'update_approved', 'autonomy_exam', 'reasoning_exam', 'verify_app_build', 'office_skill_import',
};

bool cheIsCodingJob(Map<String, dynamic> job) => _kCodingJobKinds.contains('${job['kind'] ?? ''}');

/// The render queue in the Creation Room's Working now (moved from the Music room on 2026-10-25): real cloud jobs that
/// are not coding work, the queued and running ones first, then at most three finished ones in the server's order.
List<Map<String, dynamic>> cheCreationQueue(List<Map<String, dynamic>> jobs) {
  final media = [for (final j in jobs) if (!cheIsCodingJob(j)) j];
  bool live(Map<String, dynamic> j) => j['status'] == 'queued' || j['status'] == 'running';
  return [...media.where(live), ...media.where((j) => !live(j)).take(3)];
}

class CheStudioAction {
  const CheStudioAction({
    required this.icon,
    required this.title,
    required this.body,
    required this.connected,
    required this.connectorName,
    required this.onRun,
    this.background = false,
  });
  final IconData icon;
  final String title;
  final String body;
  final bool connected;
  final String connectorName;
  final VoidCallback onRun;

  /// Runs as a real cloud job that keeps going with the phone locked.
  final bool background;
}
