/// Voice routes for Create Studio. The chat's voice navigator calls this with the lower-cased message.
enum SceneVoiceRoute { projects, lastProject, newCharacter }

final _wake = r'^\W*(?:(?:che|chey|chay)[,:]?\s+)?';
final _projects = RegExp('$_wake(?:open|show|go to) (?:the |my )?(?:creation room|create studio|scene projects|my projects)\\W*\$');
final _lastProject = RegExp('$_wake(?:open|show|resume|continue) (?:my )?last (?:project|scene|character)\\W*\$');
final _newCharacter = RegExp('$_wake(?:create|make|build)(?: me)? (?:a |an )?(?:new )?(?:person|character|human|avatar)\\W*\$');

/// The Create Studio route the message asks for, or null when it asks for none.
SceneVoiceRoute? sceneVoiceRoute(String lower) {
  if (_projects.hasMatch(lower)) return SceneVoiceRoute.projects;
  if (_lastProject.hasMatch(lower)) return SceneVoiceRoute.lastProject;
  if (_newCharacter.hasMatch(lower)) return SceneVoiceRoute.newCharacter;
  return null;
}
