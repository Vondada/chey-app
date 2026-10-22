import 'package:chey/che_ui/che_latency.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUp(CheLatency.reset);

  test('a mark records once, keeps the last samples and reports a median', () {
    final mark = CheLatency.begin(CheLatency.navigation);
    final first = mark.end();
    final again = mark.end();
    expect(again, greaterThanOrEqualTo(first), reason: 'a second end must not record a second sample');
    expect(CheLatency.samples(CheLatency.navigation), hasLength(1));

    for (var i = 0; i < 40; i++) {
      CheLatency.begin(CheLatency.voiceStart).end();
    }
    expect(CheLatency.samples(CheLatency.voiceStart), hasLength(30), reason: 'only the last 30 are kept');
    expect(CheLatency.medianMs(CheLatency.firstReply), isNull, reason: 'nothing measured means no median');
    expect(CheLatency.summary(), contains('${CheLatency.voiceStart}: n=30'));
  });
}
