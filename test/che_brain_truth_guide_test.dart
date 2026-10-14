import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_ui/che_brain.dart';

// Owner, 2026-10-14: CHE invented a "confirmed" memory. The brain guide sent
// with every message must not tell the model that its own saved notes are
// things the owner said.
void main() {
  test('brain notes are CHE\'s own notes, not the owner\'s confirmations', () {
    expect(cheBrainGuide, isNot(contains('Treat them as your own memories')));
    expect(cheBrainGuide, contains('neither proves the user said, confirmed, tested or did anything'));
    expect(cheBrainGuide, contains('Only say "you told me" or "you confirmed" about the user\'s own words'));
    expect(cheBrainGuide, contains('Only save durable facts the user actually said in their own words'));
  });
}
