import 'package:chey_app/main.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('shows the Chey welcome screen', (tester) async {
    await tester.pumpWidget(const CheyApp());

    expect(find.text('Chey'), findsOneWidget);
    expect(find.text('Chey is ready to grow.'), findsOneWidget);
    expect(
      find.text('The first Android and iOS build pipeline is in place.'),
      findsOneWidget,
    );
  });
}
