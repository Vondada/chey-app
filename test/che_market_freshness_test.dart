import 'package:chey/rooms/che_markets_room.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('market freshness comes only from the Worker labels', () {
    expect(cheMarketFreshness({'stale': false, 'age_s': 5}), '');
    expect(cheMarketFreshness({'stale': true, 'age_s': 40}), 'Last updated 40 seconds ago, refreshing');
    expect(cheMarketFreshness({'stale': true, 'age_s': 600}), 'Last updated 10 minutes ago, refreshing');
    expect(cheMarketFreshness({'stale': true, 'age_s': 7200}), 'Last updated 2 hours ago, refreshing');
    expect(cheMarketFreshness({'loading': true}), 'Still loading from the source');
    expect(cheMarketFreshness(const {}), '');
  });
}
