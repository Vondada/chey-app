part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (hub rooms).
extension _CheHomeHubRooms on _CHEHomeState {
  Widget _hubList(String title, String subtitle, List<Widget> children) {
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        Text(
          title,
          style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 4),
        Text(subtitle, style: const TextStyle(color: Colors.white54)),
        const SizedBox(height: 16),
        ...children,
      ],
    );
  }

  /// One Brain tab: constellation map + soul/facts + log (sheets), no Map|Brain|Log split.
  Widget _hubBrainTab(bool active) {
    return CheTwoBrainsView(
      live: CheInsightsRoom(
      brain: _brain,
      log: _brainLog,
      onOpenCloudLogs: _deviceToken == null
          ? null
          : () => Navigator.of(context).push(MaterialPageRoute<void>(
                builder: (_) => CheCloudLogsScreen(
                  baseUrl: () => cheAgentBaseUrl,
                  headers: () => _authHeaders,
                ),
              )),
      map: CheMemoryBrainRoom(
        active: active,
        dots: cheBuildMemoryDots(
          savedMemories: savedMemories,
          memoryRecords: memoryRecords,
          memoryNotes: memoryNotes,
          learnedPersonality: learnedPersonality,
          learnedKnowledge: learnedKnowledge,
          brainLinks: brainLinks,
          suggestions: suggestions,
          conversationMemories: conversationMemories,
          brainRecords: _brainReplicaRecords(),
        ),
        brainLinks: brainLinks,
        roster: team,
        loading: _brainSyncing,
        offline: _brainReplica.lastReceipt?.unreachable == true,
        error: _brainReplica.lastReceipt?.syncNotice,
        pendingSync: _brainReplica.pendingOps,
        onReadAloud: (t) => speakText(t, record: false, readOnDemand: true),
        onRefresh: () => _loadAgentState(silent: true),
        onOpenAgent: (name) => _openOfficeFloor(agentName: name),
      ),
      ),
      offline: CheOfflineBrainPanel(compact: true, replicaLine: _brainReplicaLine()),
    );
  }

  void _runHubPrompt(String prompt) {
    if (!mounted) return;
    Navigator.of(context).pop();
    controller.text = prompt;
    Future<void>.delayed(const Duration(milliseconds: 120), () async {
      if (mounted) await sendMessage();
    });
  }

  void _openTradingApp(String name) {
    final app = cheAppForName(name);
    if (app == null || !mounted) return;
    HapticFeedback.selectionClick();
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CheEmbeddedAppScreen(
          app: app,
          onLearnPage: _learnFromBrowserPage,
        ),
      ),
    );
  }

  Widget _hubMarketsTab() {
    return CheMarketsRoom(
      baseUrl: () => cheAgentBaseUrl,
      headers: () => _authHeaders,
      onAsk: _runHubPrompt,
      onRead: (words) { speakText(words, record: false, readOnDemand: true); },
      onOpenTradingApp: _openTradingApp,
      actions: [
        CheDeskAction(
          icon: Icons.insights_rounded,
          title: 'Swings + Entry Points',
          body: 'Swing highs and lows, trend, candlestick patterns and rule-based entries. Free live crypto, daily stocks.',
          connected: true,
          connectorName: '',
          onRun: () => _runHubPrompt('Find the swing highs, swing lows and entry points on bitcoin'),
        ),
        CheDeskAction(
          icon: Icons.history_rounded,
          title: 'Backtest (years of data)',
          body: 'Every strategy on the full history. Last 30% kept unseen as the honest test.',
          connected: true,
          connectorName: '',
          onRun: () => _runHubPrompt('Backtest bitcoin'),
        ),
        CheDeskAction(
          icon: Icons.receipt_long_rounded,
          title: 'Paper Trades',
          body: 'Simulated trades only. The crew journals every trade and learns what works.',
          connected: true,
          connectorName: '',
          onRun: () => _runHubPrompt('How are the trades doing?'),
        ),
        CheDeskAction(
          icon: Icons.candlestick_chart,
          title: 'Analyze Markets',
          body: 'Stocks, futures and crypto structure, catalysts, volatility and risk.',
          connected: integrations['market_data'] == true,
          connectorName: 'Live market data (CHE_MARKET_DATA_URL)',
          onRun: () => _runHubPrompt(
            'Analyze the market I am focused on right now. Use any connected live market and research tools, separate live facts from assumptions, and give me structure, catalysts, invalidation and risk.',
          ),
        ),
        CheDeskAction(
          icon: Icons.science_outlined,
          title: 'Backtesting Lab',
          body: 'Strategy tests with sample size, drawdown and out-of-sample checks.',
          connected: integrations['backtesting'] == true,
          connectorName: 'Backtest engine (CHE_BACKTEST_URL)',
          onRun: () => _runHubPrompt(
            'Open a backtesting task with me. Help me define the setup, rules, timeframe, data needed, sample size, drawdown and out-of-sample validation. Use the connected backtest system if available.',
          ),
        ),
        CheDeskAction(
          icon: Icons.functions,
          title: 'Custom Indicators',
          body: 'Indicator and scanner logic (VWAP, order blocks, custom rules).',
          connected: integrations['backtesting'] == true,
          connectorName: 'Historical data / backtest engine',
          onRun: () => _runHubPrompt(
            'Help me build a custom trading indicator or scanner. Ask only for the missing rules, then produce the logic and a validation plan.',
          ),
        ),
        CheDeskAction(
          icon: Icons.menu_book_rounded,
          title: 'Trading Journal + Review',
          body: 'Log trades, review execution against your rules, find repeat mistakes.',
          connected: true,
          connectorName: '',
          onRun: () => _runHubPrompt(
            'Start a trading journal review with me. Ask for my recent trades (or read the ones I paste), check each against my rules, and summarize what to repeat and what to stop.',
          ),
        ),
        CheDeskAction(
          icon: Icons.account_balance,
          title: 'Live Broker',
          body: 'Authorized order routing with explicit risk controls and confirmation.',
          connected: integrations['broker'] == true,
          connectorName: 'Broker connector (CHE_BROKER_URL)',
          onRun: () => _runHubPrompt(
            'Help me connect and configure my broker for CHE. Do not place any order until the broker connector confirms authorization and the trade details and risk controls are explicit.',
          ),
        ),
        CheDeskAction(
          icon: Icons.copy_all_outlined,
          title: 'Prop-Firm Copy Trading',
          body: 'Rule-aware mirroring only after the prop-firm connection and limits are verified.',
          connected: integrations['prop_firm'] == true,
          connectorName: 'Prop-firm connector (CHE_PROP_FIRM_URL)',
          onRun: () => _runHubPrompt(
            'Help me connect my prop-firm account and configure compliant copy trading. Verify account rules, sizing and loss limits before any execution.',
          ),
        ),
      ],
    );
  }

  Widget _hubBusinessTab() {
    // Business is a set of things to do. Each row says what it does, whether it is connected, and gives one button.
    // Real counts come from the Projects board (businesses and pipeline deals), never from text.
    final board = _boardItems();
    // Deals carry the "Business / pipeline" label too, so businesses exclude them to avoid counting each deal twice.
    final businesses = board.where((i) => i.kind != CheBoardKind.deal && i.typeLabel.toLowerCase().contains('business')).toList();
    final deals = board.where((i) => i.kind == CheBoardKind.deal).toList();
    // The same stages the Worker's pipelineSummary calls needs_you (proposal and review) need the owner.
    final attention = [...businesses, ...deals].where((i) {
      final s = i.statusLabel.toLowerCase();
      return s.contains('block') || s.contains('fail') || s == 'proposal' || s == 'review';
    }).length;
    final paymentsOn = integrations['payments'] == true;
    return _hubList(
      'Business',
      'What you can do here, and what is connected.',
      [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Text(
              businesses.isEmpty && deals.isEmpty
                  ? 'No business or deals yet. Start one below and it appears here.'
                  : '${businesses.length} ${businesses.length == 1 ? 'business' : 'businesses'} · ${deals.length} ${deals.length == 1 ? 'deal' : 'deals'} · ${attention == 0 ? 'nothing waiting on you' : '$attention waiting on you'}',
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
            ),
          ),
        ),
        _businessRow(
          icon: Icons.groups_rounded,
          title: 'Plan with the team',
          what: 'Agents draft a business goal, check each other, and CHE brings you the plan.',
          status: 'Ready',
          action: 'Start',
          onTap: () {
            Navigator.of(context).pop();
            _openOfficeFloor();
          },
        ),
        _businessRow(
          icon: Icons.handshake_outlined,
          title: 'Clients and deals',
          what: 'Track leads, proposals and builds. You approve every send.',
          status: deals.isEmpty ? 'No deals yet' : '${deals.length} in the pipeline',
          action: 'Open',
          onTap: () {
            Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ChePipelineRoom(
                  baseUrl: () => cheAgentBaseUrl,
                  headers: () => _authHeaders,
                  onAsk: (prompt) {
                    Navigator.of(context).pop();
                    _runHubPrompt(prompt);
                  },
                ),
              ),
            );
          },
        ),
        _businessRow(
          icon: Icons.storefront_outlined,
          title: 'Sell a product or class',
          what: 'Products you approve, sold through Stripe payment links. Only real sales are counted.',
          status: paymentsOn ? 'Stripe connected' : 'Needs Stripe',
          action: paymentsOn ? 'Open' : 'Set up',
          onTap: () {
            Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => CheStoreRoom(
                  baseUrl: () => cheAgentBaseUrl,
                  headers: () => _authHeaders,
                  onAsk: (prompt) {
                    Navigator.of(context).pop();
                    _runHubPrompt(prompt);
                  },
                ),
              ),
            );
          },
        ),
        _businessRow(
          icon: Icons.account_balance_wallet_outlined,
          title: 'Money and cash flow',
          what: 'Budget, runway and forecast from numbers you give CHE. No revenue is shown until a payment connector confirms it.',
          status: paymentsOn ? 'Payments connected' : 'No revenue connected',
          action: 'Ask CHE',
          onTap: () => _runHubPrompt(
            'Help me work through my business cash flow. Ask for only the numbers you actually need, then build the budget, runway and forecast.',
          ),
        ),
        _businessRow(
          icon: Icons.person_search_outlined,
          title: 'Find leads',
          what: 'Public or professional prospects from a connected lead source. No sensitive personal targeting.',
          status: integrations['leads'] == true ? 'Connected' : 'Needs a lead source',
          action: 'Ask CHE',
          onTap: () => _runHubPrompt(
            'Find and organize lawful public or professional leads for my business using connected lead and research tools. Do not use sensitive personal targeting.',
          ),
        ),
        _businessRow(
          icon: Icons.add_business_rounded,
          title: 'Start a business',
          what: 'Name the business, its first offer and the next three steps. Nothing is published or paid.',
          status: 'Ready',
          action: 'Start',
          onTap: () => _runHubPrompt(
            'Start a business plan with me. Help me pick the first offer, the customer, and the next three steps. Do not publish, charge or buy anything.',
          ),
        ),
      ],
    );
  }

  /// One Business action: what it is, what is connected, and the one thing the button does.
  Widget _businessRow({
    required IconData icon,
    required String title,
    required String what,
    required String status,
    required String action,
    required VoidCallback onTap,
  }) {
    return Card(
      child: ListTile(
        onTap: onTap,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        leading: Icon(icon),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text('$what\n$status', style: const TextStyle(height: 1.35)),
        ),
        isThreeLine: true,
        trailing: FilledButton.tonal(onPressed: onTap, child: Text(action)),
      ),
    );
  }

  Widget _hubDevicesTab(bool active) {
    return DevicesHubScene(
      active: active,
      phoneConnected: _deviceToken != null,
      integrations: integrations,
      onPrompt: _runHubPrompt,
      onVault: () {
        unawaited(_openVault());
      },
      onMultimodal: () {
        unawaited(_openMultimodalPicker());
      },
      onOpenShare: () => unawaited(_openPlatformDevices()),
    );
  }

  /// Starts a real cloud job (keeps running with the phone locked).
  Future<void> _startCloudJob(String title, String prompt) async {
    if (!await _ensurePaired() || !mounted) return;
    try {
      final created = await _postAgentJson('/api/job/create', {'title': title, 'prompt': prompt});
      final job = created?['job'];
      if (job is Map && job['id'] is String) cheWatchedJobId.value = job['id'] as String;
      await _loadAgentState(silent: true);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$title is rendering in the cloud.')),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not start the cloud job.')),
        );
      }
    }
  }

  Future<void> _openJob(Map<String, dynamic> job) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: CheColors.panel,
      builder: (sheetContext) => SizedBox(
        height: MediaQuery.of(sheetContext).size.height * 0.75,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 32),
          children: [
            Text('${job['title'] ?? 'Job'}',
                style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text('${job['status'] ?? ''}', style: const TextStyle(color: Colors.white54)),
            const SizedBox(height: 16),
            SelectableText(
              '${job['result'] ?? ''}'.isNotEmpty
                  ? '${job['result']}'
                  : '${job['error'] ?? ''}'.isNotEmpty
                      ? '${job['error']}'
                      : 'Still working. This keeps going on the CHE server.',
              style: const TextStyle(height: 1.45),
            ),
            if ('${job['result'] ?? ''}'.isNotEmpty) ...[
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: () => Clipboard.setData(ClipboardData(text: '${job['result']}')),
                icon: const Icon(Icons.copy_rounded),
                label: const Text('Copy'),
              ),
            ],
          ],
        ),
      ),
    );
  }

  // Office agents who are in this room walk across the bottom of the tab.
  Widget _withVisitors(Widget scene, Set<String> rooms) {
    _ensureOfficeRuntime();
    return Stack(children: [
      Positioned.fill(child: scene),
      Positioned(
        left: 0,
        right: 0,
        bottom: 96,
        child: CheRoomVisitors(runtime: _officeRuntime, rooms: rooms, onOpenOffice: _openOfficeFloor),
      ),
    ]);
  }

  Widget _hubMusicTab(bool active) => _withVisitors(_hubMusicScene(active), const {'music', 'studio'});

  Widget _hubMusicScene(bool active) {
    final musicReady = integrations['music'] == true;
    final voiceReady = integrations['natural_voice'] == true;
    return CheCreatorStudio(
      speaking: _isSpeaking,
      jobs: backgroundJobs,
      onOpenJob: (job) => unawaited(_openJob(job)),
      seriesPanel: CheSeriesStudioPanel(baseUrl: () => cheAgentBaseUrl, headers: () => _authHeaders, onAsk: _runHubPrompt),
      musicScene: MusicStudioScene(
        active: active,
        musicConnected: musicReady,
        carConnected: integrations['car'] == true,
        onMusic: () => _runHubPrompt(
          'Help me connect and control my music through CHE. Use the authorized music integration if connected.',
        ),
        onCar: () => _runHubPrompt(
          'Help me connect my car audio to CHE. Use only supported authorized audio controls.',
        ),
      ),
      actions: [
        CheStudioAction(
          icon: Icons.music_note_rounded,
          title: 'Make music',
          body: 'Songs, beats, stems and lyrics at the connected engine\'s highest quality.',
          connected: musicReady,
          connectorName: 'Music engine (CHE_MUSIC_URL)',
          onRun: () => _runHubPrompt(
            'Let\'s make a track. Ask only what you need (genre, mood, tempo, length, vocals), then create it with the connected music engine at the highest quality. If none is connected, write the full production brief and lyrics.',
          ),
        ),
        CheStudioAction(
          icon: Icons.record_voice_over_rounded,
          title: 'Voice + narration',
          body: 'Voiceovers and narration in natural voices.',
          connected: voiceReady,
          connectorName: 'Natural voice (CHE_OPENAI_API_KEY or CHE_VOICE_URL)',
          onRun: () => _runHubPrompt('Help me record a voiceover. Ask for the script and tone, then produce it with the connected voice engine.'),
        ),
        CheStudioAction(
          icon: Icons.podcasts_rounded,
          title: 'Podcast episode',
          body: 'Outline, full script, show notes and chapter markers.',
          connected: true,
          connectorName: '',
          background: true,
          onRun: () => unawaited(_startCloudJob(
            'Podcast episode draft',
            'Write a complete podcast episode package for the owner: working title, hook, segment outline, full conversational script, show notes and chapter markers. Base it on the owner\'s saved projects and interests if relevant; label assumptions.',
          )),
        ),
        CheStudioAction(
          icon: Icons.movie_creation_outlined,
          title: 'Script + storyboard',
          body: 'Scenes, shot list and storyboard frames for video.',
          connected: true,
          connectorName: '',
          onRun: () => _runHubPrompt('Let\'s write a video script and storyboard. Ask for the idea and length, then give me scenes, a shot list and frame-by-frame storyboard notes.'),
        ),
        CheStudioAction(
          icon: Icons.slideshow_rounded,
          title: 'Presentation',
          body: 'Slide-by-slide deck with speaker notes.',
          connected: true,
          connectorName: '',
          onRun: () => _runHubPrompt('Build a presentation with me. Ask for the audience and goal, then produce slide-by-slide content with speaker notes.'),
        ),
        CheStudioAction(
          icon: Icons.videocam_rounded,
          title: 'Generate video',
          body: 'Video clips from a prompt or storyboard.',
          connected: integrations['video_generation'] == true,
          connectorName: 'Video generator (CHE_VIDEO_GEN_URL)',
          onRun: () => _runHubPrompt('Create a video for me. Ask only for any essential missing detail, then use the connected CHE video generator if available.'),
        ),
      ],
    );
  }

  Widget _hubCreateTab(bool active) => _withVisitors(_hubCreateScene(active), const {'gallery'});

  Widget _hubCreateScene(bool active) {
    return CheRoomSegments(
      labels: const ['Projects', 'Art Studio'],
      icons: const [Icons.collections_bookmark_outlined, Icons.palette_outlined],
      children: [
        () => _createProjectsScene(active),
        () => CheArtStudio(
              baseUrl: () => cheAgentBaseUrl,
              headers: () => _authHeaders,
              onSaveToVault: (name, content) async {
                await _postAgentJson('/api/vault/add', {'name': name, 'content': content, 'kind': 'art'});
                await _loadAgentState(silent: true);
              },
            ),
      ],
    );
  }

  /// The Capability Showroom's real states, from the Worker (owner device token; nothing is spoken).
  /// The Capability Showroom, reachable from the Creation Room and More. Opening it speaks nothing.
  void _openShowroom() {
    unawaited(Navigator.of(context).push(CheShowroomPage.route(
      load: _loadShowroom,
      onStart: _runHubPrompt,
      onOpenRecent: _openShowroomRecent,
    )));
  }

  Future<Map<String, dynamic>> _loadShowroom() async {
    final res = await http.get(Uri.parse('$cheAgentBaseUrl/api/showroom'), headers: _authHeaders);
    final body = jsonDecode(res.body);
    if (res.statusCode != 200 || body is! Map) throw StateError('HTTP ${res.statusCode}');
    return Map<String, dynamic>.from(body);
  }

  /// "Open example" on a card with a real saved output: the invention, video or picture it names.
  void _openShowroomRecent(Map<String, dynamic> recent) {
    final id = '${recent['id'] ?? ''}';
    if (id.isEmpty) return;
    final route = switch ('${recent['kind'] ?? ''}') {
      'invention' => CheInventionStudioPage.route(baseUrl: cheAgentBaseUrl, headers: _authHeaders),
      'video' || 'image' => MaterialPageRoute<void>(
          builder: (_) => CheCreationViewer(
            item: {'id': id, 'kind': recent['kind'], 'title': '${recent['title'] ?? 'Creation'}'},
            baseUrl: cheAgentBaseUrl,
            headers: _authHeaders,
          ),
        ),
      _ => null,
    };
    if (route != null) unawaited(Navigator.of(context).push(route));
  }

  Widget _createProjectsScene(bool active) {
    return CreateGalleryScene(
      active: active,
      projects: projects,
      vaultCount: vaultItems.length,
      researchConnected: integrations['web_research'] == true,
      imageConnected: integrations['image_generation'] == true,
      videoConnected: integrations['video_generation'] == true,
      creations: CheCreationsStrip(baseUrl: cheAgentBaseUrl, headers: _authHeaders, active: active),
      onInventions: () => unawaited(Navigator.of(context).push(CheInventionStudioPage.route(baseUrl: cheAgentBaseUrl, headers: _authHeaders))),
      onShowroom: _openShowroom,
      onNewProject: () {
        unawaited(_createProjectDialog());
      },
      onOpenProject: _openProjectEditor,
      onVault: () {
        unawaited(_openVault());
      },
      onResearch: () => _runHubPrompt(
        'Help me research the novelty and feasibility of the project I am working on. Use connected live research if available and clearly separate confirmed facts from assumptions.',
      ),
      onImage: () => _runHubPrompt(
        'Create an image for me. Ask only for any essential missing detail, then use the connected CHE image generator if available.',
      ),
      onVideo: () => _runHubPrompt(
        'Create a video for me. Ask only for any essential missing detail, then use the connected CHE video generator if available.',
      ),
    );
  }

  void _openOfficeFloor({String? agentName}) {
    HapticFeedback.selectionClick();
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CheOfficeFloorScreen(
          client: _agentRuntime,
          onSpeak: (text) => speakText(text, record: false, readOnDemand: true),
          initialAgentName: agentName,
          // Tapping CHE's desk returns to the conversation.
          onTalkToChe: () => Navigator.of(context).popUntil((route) => route.isFirst),
        ),
      ),
    ).then((_) => _loadAgentState(silent: true));
  }

  Widget _hubOfficeTab(bool active) {
    // The live Office world IS the Office tab: desks, walking agents and the
    // War Room, with read-aloud on every summary.
    return CheOfficeFloorScreen(
      client: _agentRuntime,
      embedded: true,
      onSpeak: (text) => speakText(text, record: false, readOnDemand: true),
      onTalkToChe: () => Navigator.of(context).popUntil((route) => route.isFirst),
    );
  }

}
