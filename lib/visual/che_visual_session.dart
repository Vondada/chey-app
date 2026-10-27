// The project open in the Visual Studio editor, so a spoken "make this brighter" goes to that project.
// The chat request adds these fields only while an editor is on screen.
class CheVisualSession {
  CheVisualSession._();

  static String? projectId;
  static String? selection;
  static double playhead = 0;

  static Map<String, Object?> chatFields() => projectId == null
      ? const {}
      : {'visual_project_id': projectId, 'visual_selection': selection, 'visual_playhead': playhead};

  static void open(String id) {
    projectId = id;
    selection = null;
    playhead = 0;
  }

  static void close(String id) {
    if (projectId == id) projectId = null;
  }
}
