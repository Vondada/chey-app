// Settings → Creation Engine (owner, 2026-10-24): the technical side of the Creation Room, moved out of it. The
// Creation Engine is the owner's own Google Colab GPU running CHE's worker notebook; this page holds what used to sit in
// the room: Pair Colab (the worker token, shown once), the GPU job queue with its real states and pictures, and the
// notebook link. CHE cannot start Colab: the notebook runs only while the owner has it open, and the page says so.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../che_gpu_jobs.dart';
import 'che_creative_studio.dart' show CheStudioColors;
import 'che_live_studio.dart' show cheColabNotebookUrl;

class CheCreationEnginePage extends StatelessWidget {
  const CheCreationEnginePage({super.key, required this.baseUrl, required this.headers, this.onRead, this.client});

  final String baseUrl;
  final Map<String, String> headers;
  final void Function(String text)? onRead;
  final http.Client? client;

  static Route<void> route({required String baseUrl, required Map<String, String> headers, void Function(String text)? onRead}) =>
      MaterialPageRoute<void>(builder: (_) => CheCreationEnginePage(baseUrl: baseUrl, headers: headers, onRead: onRead));

  static const _steps = 'To start it: 1, open the notebook. 2, in Colab choose Runtime, Change runtime type, T4 GPU. '
      '3, the first time only, use Pair Colab below and save the token in Colab Secrets as CHE_GPU_TOKEN. '
      '4, choose Runtime, Run all. The Creation Room shows Online when the GPU checks in. '
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
            onPressed: onRead == null ? null : () => onRead!('Creation Engine. Your own Colab GPU runs Blender for CHE. $_steps'),
            icon: const Icon(Icons.volume_up_rounded),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          const Text(
            'Your own Google Colab GPU runs Blender for the Creation Room: 3D models, preview renders and characters.',
            style: TextStyle(color: CheStudioColors.text, fontSize: 17, height: 1.4),
          ),
          const SizedBox(height: 10),
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
                final ok = await launchUrl(Uri.parse(cheColabNotebookUrl), mode: LaunchMode.externalApplication).catchError((_) => false);
                if (!ok && context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not open the Colab notebook.')));
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
    );
  }
}
