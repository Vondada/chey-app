/// Pure classifier for owner requests that change CHE itself.
/// Kept outside UI code so routing is testable and never falls through to
/// generic model advice about creating GitHub tokens.
bool cheIsSelfUpdateRequest(String raw) {
  final text = raw.trim();
  return RegExp(
    r'^(?:(?:chay|chey|shay|che)[, ]+)?'
    r'(?:(?:add|change|update|remove|fix|improve|build|redesign|modify|move|restyle)\s+.+\s+'
    r'(?:to|in|on)\s+(?:your|che|c\.?h\.?e\.?)\s+(?:code|app|ui|interface|screen|layout)\b|'
    r'(?:update|improve|fix|build|redesign|change|modify)\s+(?:yourself|your app|your code|your ui|your interface|your screen|your layout)\b|'
    r'(?:proofread|review|edit|refactor)\s+(?:your\s+)?code\b|'
    r'(?:change|move|redesign|restyle)\s+(?:this|the|your)\s+(?:screen|button|control|layout|ui|interface)\b)',
    caseSensitive: false,
  ).hasMatch(text);
}
