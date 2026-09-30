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

  Widget _hubMemoryTab() {
    return CheMemoryBrainRoom(
      dots: cheBuildMemoryDots(
        savedMemories: savedMemories,
        memoryNotes: memoryNotes,
        learnedPersonality: learnedPersonality,
        learnedKnowledge: learnedKnowledge,
      ),
      onReadAloud: (t) => speakText(t, record: false),
      onRefresh: () => _loadAgentState(silent: true),
    );
  }

  Widget _hubInsightsTab(bool active) {
    return CheInsightsRoom(
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
      map: InsightsBrainScene(
        active: active,
        learnedAboutYou: learnedPersonality,
        learnedKnowledge: learnedKnowledge,
        suggestions: suggestions,
      ),
    );
  }

  Widget _integrationCard(
    IconData icon,
    String title,
    String description,
    bool connected, {
    VoidCallback? onTap,
  }) {
    return Card(
      child: ListTile(
        onTap: onTap,
        leading: Icon(icon),
        title: Text(title),
        subtitle: Text(description),
        trailing: Text(
          connected ? 'CONNECTED' : (onTap != null ? 'SET UP' : 'NOT CONNECTED'),
          style: TextStyle(
            color: connected
                ? const Color(0xFF34E0B8)
                : (onTap != null ? Colors.amberAccent : Colors.white38),
            fontSize: 10,
            fontWeight: FontWeight.bold,
          ),
        ),
      ),
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

  Widget _hubMarketsTab() {
    return CheMarketsRoom(
      baseUrl: () => cheAgentBaseUrl,
      headers: () => _authHeaders,
      onAsk: _runHubPrompt,
      actions: [
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
    return _hubList(
      'Business',
      'Run planning and operations now; connected services unlock live records, leads and payments.',
      [
        _integrationCard(
          Icons.groups_rounded,
          'Business War Room',
          'Convene CHE’s agents on a business goal: they draft, cross-check each other and CHE delivers the plan.',
          true,
          onTap: () {
            Navigator.of(context).pop();
            _openOfficeFloor();
          },
        ),
        _integrationCard(
          Icons.handshake_outlined,
          'Client Pipeline',
          'Leads → proposals → builds → Stripe payment links. CHE drafts and builds; you approve and send.',
          true,
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
        _integrationCard(
          Icons.storefront_outlined,
          'CHE Studio Store',
          'Products and classes you approve, sold through Stripe payment links. Real sales only.',
          integrations['payments'] == true,
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
        _integrationCard(
          Icons.dashboard_customize_outlined,
          'Business Operations',
          'Plans, workflows, CRM, scheduling, fulfillment and operating systems.',
          integrations['business'] == true,
          onTap: () => _runHubPrompt(
            'Start a business operations task with me. Help me turn the goal into an efficient plan, workflow, responsibilities, metrics and next actions.',
          ),
        ),
        _integrationCard(
          Icons.account_balance_wallet_outlined,
          'Cash Flow',
          'Budgets, runway, forecasts, invoices and reconciliations.',
          integrations['business'] == true,
          onTap: () => _runHubPrompt(
            'Help me work through my business cash flow. Ask for only the numbers you actually need, then build the budget, runway and forecast.',
          ),
        ),
        _integrationCard(
          Icons.person_search_outlined,
          'Lead Discovery',
          'Lawful public/professional prospect research through a connected source.',
          integrations['leads'] == true,
          onTap: () => _runHubPrompt(
            'Find and organize lawful public or professional leads for my business using connected lead and research tools. Do not use sensitive personal targeting.',
          ),
        ),
        _integrationCard(
          Icons.payments_outlined,
          'Payments + Billing',
          'Authorized invoicing and payment actions with explicit customer terms.',
          integrations['payments'] == true,
          onTap: () => _runHubPrompt(
            'Help me set up CHE payments and billing. Do not charge anyone unless the payment connector confirms authorization, pricing and customer terms.',
          ),
        ),
        _integrationCard(
          Icons.manage_search_outlined,
          'Public Records',
          'Research records that are lawfully public through an authorized source.',
          integrations['public_records'] == true,
          onTap: () => _runHubPrompt(
            'Help me research lawful public records. Use a connected public-record or research source if available and clearly separate confirmed records from anything unverified.',
          ),
        ),
      ],
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
    );
  }

  /// Starts a real cloud job (keeps running with the phone locked).
  Future<void> _startCloudJob(String title, String prompt) async {
    if (!await _ensurePaired() || !mounted) return;
    try {
      await _postAgentJson('/api/job/create', {'title': title, 'prompt': prompt});
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

  Widget _createProjectsScene(bool active) {
    return CreateGalleryScene(
      active: active,
      projects: projects,
      vaultCount: vaultItems.length,
      researchConnected: integrations['web_research'] == true,
      imageConnected: integrations['image_generation'] == true,
      videoConnected: integrations['video_generation'] == true,
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

  void _openOfficeFloor() {
    HapticFeedback.selectionClick();
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CheOfficeFloorScreen(
          client: _agentRuntime,
          onSpeak: speakText,
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
      onSpeak: speakText,
      onTalkToChe: () => Navigator.of(context).popUntil((route) => route.isFirst),
    );
  }

}
