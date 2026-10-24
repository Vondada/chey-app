// Strategy simulation controls (owner, 2026-10-24): Pause, Resume, Stop and Reset. Each button sends the same words
// the owner can say or type, so CHE runs it through her own route (che_strategy_sim) and reports aloud what really
// happened. Reset asks first: the dialog explains the run is archived, never deleted, and only "Archive and reset"
// sends the confirmation. Paper only; no money moves.

import 'package:flutter/material.dart';

const kSimPause = 'Pause the strategy simulation';
const kSimResume = 'Resume the strategy simulation';
const kSimStop = 'Stop the strategy simulation';
const kSimReset = 'Yes, reset the strategy simulation';

class CheSimControls extends StatelessWidget {
  const CheSimControls({super.key, required this.onAsk, this.paused = false});
  final void Function(String prompt) onAsk;
  final bool paused;

  Future<void> _reset(BuildContext context) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Reset the strategy simulation?'),
        content: const Text('The current run, its trades and open positions are archived and kept. A fresh simulation starts, paused until you resume it.', style: TextStyle(fontSize: 17)),
        actions: [
          Semantics(button: true, label: 'Cancel, keep the simulation as it is',
            child: TextButton(key: const Key('sim_reset_cancel'), onPressed: () => Navigator.pop(c, false), child: const Text('Cancel'))),
          Semantics(button: true, label: 'Archive the run and reset the simulation',
            child: FilledButton(key: const Key('sim_reset_confirm'), onPressed: () => Navigator.pop(c, true), child: const Text('Archive and reset'))),
        ],
      ),
    );
    if (yes == true) onAsk(kSimReset);
  }

  @override
  Widget build(BuildContext context) {
    Widget button(String key, String label, String hint, IconData icon, VoidCallback onTap) => Semantics(
      button: true, label: hint,
      child: OutlinedButton.icon(key: Key(key), onPressed: onTap, icon: Icon(icon), label: Text(label)),
    );
    return Wrap(spacing: 8, runSpacing: 8, children: [
      if (paused) button('sim_resume', 'Resume', 'Resume the strategy simulation', Icons.play_arrow, () => onAsk(kSimResume))
      else button('sim_pause', 'Pause', 'Pause the strategy simulation', Icons.pause, () => onAsk(kSimPause)),
      button('sim_stop', 'Stop', 'Stop the strategy simulation: pause and cancel waiting signals; open positions are kept', Icons.stop_rounded, () => onAsk(kSimStop)),
      button('sim_reset', 'Reset', 'Reset the strategy simulation; asks first, and the run is archived', Icons.restart_alt_rounded, () => _reset(context)),
    ]);
  }
}
