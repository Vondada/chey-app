import 'package:chey/browser/che_tradesea_check.dart';
import 'package:chey/che_app_portal.dart';
import 'package:flutter_test/flutter_test.dart';

// Issue #342: TradeSea's chart and active account do not load reliably in CHE's web view. The
// check is the owner's own, by voice or the menu; what it reports must carry site names only.
void main() {
  test('TradeSea pop-ups and the check apply to TradeSea\'s own hosts only', () {
    expect(cheIsTradeSeaHost('https://app.tradesea.ai/trade'), isTrue);
    expect(cheIsTradeSeaHost('https://tradesea.ai'), isTrue);
    expect(cheIsTradeSeaHost('https://tradesea.ai.example.com/login'), isFalse);
    expect(cheIsTradeSeaHost('https://www.tradingview.com'), isFalse);
    // The existing desktop-agent rule is unchanged.
    expect(cheIsTradeSeaUrl('https://app.tradesea.ai/trade'), isTrue);
  });

  test('a site name never carries a path, query, port, user, subdomain or account number', () {
    expect(cheSafeSite('https://app.tradesea.ai/accounts/123456?token=abc#x'), 'tradesea.ai');
    expect(cheSafeSite('wss://rprotocol.rithmic.com:443/ws?user=owner'), 'rithmic.com');
    expect(cheSafeSite('https://owner:secret@charts.example.co/x'), 'example.co');
    expect(cheSafeSite('rprotocol.rithmic.com'), 'rithmic.com');
    expect(cheSafeSite('10.1.2.3'), 'a numeric address');
    expect(cheSafeSite('inline'), 'inline');
    expect(cheSafeSite(''), 'unknown');
    expect(cheSafeSite('javascript:alert(1)'), 'unknown');
  });

  test('the first check reads the page and starts watching; nothing it says comes from page text', () {
    final findings = cheTradeSeaFindings({
      'canvases': 0,
      'largestCanvas': [0, 0],
      'frames': ['https://app.tradesea.ai/chart/123456?session=abc'],
      'failedResources': {'cdn.tradesea.ai': 2},
      'cookies': true,
      'localStorage': false,
      'watch': null,
    }, pageErrors: [cheTradeSeaPageError(url: 'https://app.tradesea.ai/x?y=1', status: 503)]);
    expect(findings, [
      'CHE\'s web view reported one page failure: tradesea.ai answered HTTP 503.',
      'No chart drawing surface is on the page, so the chart has not started drawing.',
      'The page has embedded frames from tradesea.ai. A frame from another site gets no shared sign-in storage in an iPhone web view.',
      'Loads that failed: tradesea.ai (2).',
      'This web view refused site storage (cookies on, local storage off), so a sign-in may not stick.',
      'I am now watching TradeSea\'s live connections and new windows. Open your account and the chart, then say "check TradeSea" again.',
    ]);
    for (final f in findings) {
      expect(f, isNot(contains('123456')));
      expect(f, isNot(contains('session')));
      expect(f, isNot(contains('?')));
    }
  });

  test('the second check reports new windows, live-data connections and how they closed, by site', () {
    final findings = cheTradeSeaFindings({
      'canvases': 3,
      'largestCanvas': [393, 420],
      'frames': [],
      'failedResources': {},
      'cookies': true,
      'localStorage': true,
      'watch': {
        'opens': {'auth.example.com': 1},
        'blockedOpens': 1,
        'sockets': {'rprotocol.rithmic.com': 2},
        'socketErrors': {'rprotocol.rithmic.com': 2},
        'socketCloses': {'rprotocol.rithmic.com 1006': 2},
        'confirms': 1,
        'alerts': 0,
        'failedLoads': {},
      },
    });
    expect(findings, [
      'A chart surface is drawn, 393 by 420 points.',
      'TradeSea tried to open new windows: example.com (1). CHE\'s web view opens those in the same page, so a sign-in or chart window that needs its own window cannot work here. Compare in the Safari view.',
      'Live-data connections opened: rithmic.com (2). Failed: rithmic.com (2). Closed: rithmic.com code 1006 (2).',
      'TradeSea showed 1 pop-up message; CHE shows them to you and reads them aloud.',
    ]);
    expect(cheTradeSeaFindings({'canvases': 1, 'largestCanvas': [40, 40], 'watch': {'sockets': {}}}),
        ['The chart surface is there but tiny, 40 by 40 points, so the chart area looks empty.', 'No live-data connection opened since I started watching.']);
  });

  test('the spoken check is a numbered list with the two next steps, and never says "tap"', () {
    final spoken = cheTradeSeaSpoken(['First finding.', 'Second finding.']);
    expect(spoken, startsWith('TradeSea check, sir: 1, First finding. 2, Second finding. Say "retry TradeSea" to reload it, or "open TradeSea in Safari view" to compare.'));
    expect(spoken.toLowerCase(), isNot(contains('tap')));
    expect(cheTradeSeaPageError(url: 'https://app.tradesea.ai/trade', type: 'webContentProcessTerminated'), contains('iOS stopped the page\'s process on tradesea.ai'));
    expect(cheTradeSeaPageError(url: 'https://app.tradesea.ai/trade?acct=9', type: 'timedOut', code: -1001), 'tradesea.ai failed to load (timedOut -1001)');
  });

  test('the page scripts only count by site: no cookies, form values, page text or sending', () {
    for (final js in [cheTradeSeaWatchJs, cheTradeSeaProbeJs]) {
      for (final banned in ['document.cookie', '.value', 'innerText', 'textContent', 'fetch(', 'XMLHttpRequest', 'postMessage', 'CheVaultCapture', 'sendBeacon']) {
        expect(js, isNot(contains(banned)), reason: banned);
      }
    }
    // Each wrapped call still runs TradeSea's own code and returns its answer.
    expect(cheTradeSeaWatchJs, contains('open.apply(window, arguments)'));
    expect(cheTradeSeaWatchJs, contains('Reflect.construct(T, args, next)'));
    expect(cheTradeSeaWatchJs, contains('c.apply(window, arguments)'));
  });
}
