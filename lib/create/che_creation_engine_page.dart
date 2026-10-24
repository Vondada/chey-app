// Settings → Creation Engine (owner, 2026-10-24): the technical side of the Creation Room, moved out of it. The
// Creation Engine is CHE's job queue plus the workers that take its jobs: free GitHub cloud CPU workers CHE starts by
// herself (che-creation-worker.yml), and the owner's own Google Colab T4 GPU while its notebook is open (faster; Google
// does not let CHE start it). This page holds the status (connected workers, capacity, providers, the $0 limit and the
// two cloud settings), Pair Colab (the worker token, shown once), the job queue with its real states and pictures, and
// the notebook link.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../che_gpu_jobs.dart';
import 'che_creative_studio.dart' show CheStudioColors;
import 'che_engine_status.dart';
import 'che_live_studio.dart' show cheColabNotebookUrl;

class CheCreationEnginePage extends StatelessWidget {
  const CheCreationEnginePage({super.key, required this.baseUrl, required this.headers, this.onRead, this.client});

  final String baseUrl;
  final Map<String, String> headers;
  final void Function(String text)? onRead;
  final http.Client? client;

  static Route<void> route({
    required String baseUrl,
    required Map<String, String> headers,
    void Function(String text)? onRead,
  }) => MaterialPageRoute<void>(
    builder: (_) => CheCreationEnginePage(baseUrl: baseUrl, headers: headers, onRead: onRead),
  );

  static const _intro =
      'CHE builds your creations by herself: when a job is waiting, she starts a free cloud worker on '
      'GitHub that runs Blender on the CPU, and it stops when the queue is empty. Your Colab GPU is optional and faster.';

  static const _steps =
      'To add your Colab GPU: 1, open the notebook. 2, in Colab choose Runtime, Change runtime type, T4 GPU. '
      '3, the first time only, use Pair Colab below and save the token in Colab Secrets as CHE_GPU_TOKEN. '
      '4, choose Runtime, Run all. Google does not let CHE start Colab, so this step is yours each session. '
      'It stops by itself after 45 idle minutes, and it costs nothing.';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheStudioColors.bg,
      appBar: AppBar(
        backgroundColor: CheStudioColors.bg,
        foregroundColor: CheStudioColors.text,
        title: Semantics(header: true, child: const Text('Creation Engine')),
        actions: [
          IconButton(
            tooltip: 'Read the Creation Engine steps aloud',
            onPressed: onRead == null ? null : () => onRead!('Creation Engine. $_intro $_steps'),
            icon: const Icon(Icons.volume_up_rounded),
          ),
        ],
      ),
      // Not a lazy list: every section stays in the tree, so VoiceOver and voice routes reach the job queue too.
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(_intro, style: TextStyle(color: CheStudioColors.text, fontSize: 17, height: 1.4)),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: CheStudioColors.card,
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: CheStudioColors.stroke),
              ),
              child: CheEngineStatusCard(baseUrl: baseUrl, headers: headers, onRead: onRead, client: client),
            ),
            const SizedBox(height: 20),
            Semantics(
              header: true,
              child: const Text(
                'Your Colab GPU (optional)',
                style: TextStyle(color: CheStudioColors.text, fontSize: 17, fontWeight: FontWeight.w800),
              ),
            ),
            const SizedBox(height: 8),
            const Text(_steps, style: TextStyle(color: CheStudioColors.silver, fontSize: 15, height: 1.45)),
            const SizedBox(height: 14),
            Semantics(
              button: true,
              label: 'Open the Colab notebook',
              excludeSemantics: true,
              child: FilledButton.icon(
                key: const ValueKey('engine-open-notebook'),
                style: FilledButton.styleFrom(
                  backgroundColor: CheStudioColors.teal,
                  foregroundColor: Colors.black,
                  minimumSize: const Size.fromHeight(54),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                ),
                onPressed: () async {
                  HapticFeedback.selectionClick();
                  final ok = await launchUrl(
                    Uri.parse(cheColabNotebookUrl),
                    mode: LaunchMode.externalApplication,
                  ).catchError((_) => false);
                  if (!ok && context.mounted) {
                    ScaffoldMessenger.of(context)
                        .showSnackBar(const SnackBar(content: Text('Could not open the Colab notebook.')));
                  }
                },
                icon: const Icon(Icons.open_in_new_rounded),
                label: const Text('Open the Colab notebook'),
              ),
            ),
            const SizedBox(height: 20),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: CheStudioColors.card,
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: CheStudioColors.stroke),
              ),
              child: CheGpuJobsCard(
                key: const ValueKey('engine-gpu-jobs'),
                baseUrl: baseUrl,
                headers: headers,
                onRead: onRead,
                client: client,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
