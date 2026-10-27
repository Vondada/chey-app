// Whether CHE is on screen (owner, 2026-10-23 stability mission). Background polls and idle clocks check this so a
// phone with CHE in the background (kept alive by audio or a live feed) does not keep asking the Worker or redrawing
// for nothing. Before the first lifecycle event (tests, cold start) the app counts as in the foreground.
import 'package:flutter/widgets.dart';

bool cheAppInForeground() {
  final state = WidgetsBinding.instance.lifecycleState;
  return state == null || state == AppLifecycleState.resumed || state == AppLifecycleState.inactive;
}
