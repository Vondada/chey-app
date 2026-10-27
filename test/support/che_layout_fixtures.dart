// Realistic offline payloads for layout tests, copied from the screens' own tests (same shapes the Worker returns).
// ignore_for_file: prefer_single_quotes

Map<String, dynamic> layoutSecurityCore({List<Map<String, dynamic>> pulses = const [], String state = 'MONITORING'}) =>
    {
      'core': {'version': '1.0.0', 'product_name': 'Security', 'engines': List.filled(13, 'x')},
      'spoken': 'Security is monitoring: No security check in the last day. Readiness 80 out of 100. This lowers risk; no system can be made unhackable.',
      'status': 'Lockdown is off. No serious security events in the last day.',
      'protection': {
        'locked_down': false,
        'internal_only': false,
        'state': state,
        'reason': 'No security check in the last day.',
      },
      'readiness': {
        'score': 80,
        'how': 'Weighted average of 2 measured component(s) out of 8; unmeasured components are excluded, not counted as passing. A readiness score measures preparation, not immunity.',
        'components': [
          {
            'id': 'open_incidents',
            'label': 'No open incidents',
            'weight': 20,
            'score': 1,
            'status': 'pass',
            'evidence': '0 open incident(s)',
          },
          {
            'id': 'backup',
            'label': 'Trusted snapshot within a week',
            'weight': 10,
            'score': 0,
            'status': 'fail',
            'evidence': 'no trusted snapshot',
          },
        ],
        'unknown': ['recent_check'],
      },
      'world': {
        'nodes': [
          {
            'id': 'worker',
            'kind': 'server',
            'label': 'CHE server',
            'status': pulses.isEmpty ? 'ok' : 'alert',
            'events_24h': pulses.length,
          },
          {
            'id': 'vault',
            'kind': 'vault',
            'label': 'Password vault (on your phone)',
            'status': 'unknown',
            'events_24h': 0,
            'detail': 'Kept only on the phone; the server cannot see it.',
          },
          {'id': 'repository', 'kind': 'repository', 'label': 'Code repository', 'status': 'ok', 'events_24h': 0},
        ],
        'links': [],
        'pulses': pulses,
        'simulated': false,
      },
      'systems': [
        {'id': 'worker', 'kind': 'server', 'label': 'CHE server', 'status': 'ok', 'events_24h': 0},
      ],
      'defense': {'active': [], 'recent': []},
      'sections': {'threats': [], 'identity': [], 'code': [], 'dependencies': [], 'secrets': [], 'malware': []},
      'access': {
        'principals': [
          {
            'id': 'che',
            'kind': 'agent',
            'name': 'CHE',
            'scopes': ['chat'],
            'status': 'active',
          },
          {
            'id': 'tool:wide',
            'kind': 'tool',
            'name': 'Wide tool',
            'scopes': ['*'],
            'status': 'active',
          },
          {
            'id': 'app:spotify',
            'kind': 'app',
            'name': 'spotify',
            'scopes': ['open'],
            'status': 'active',
          },
          {
            'id': 'device:d1',
            'kind': 'device',
            'name': 'Owner iPhone',
            'scopes': ['owner'],
            'status': 'active',
          },
        ],
        'review': {
          'findings': [
            {'id': 'tool:wide', 'kind': 'tool', 'severity': 'high', 'issue': 'holds every scope (wildcard)'},
          ],
        },
      },
      'backups': {'last_snapshot_at': null},
      'knowledge': {'private': [], 'shared': [], 'portability': [], 'categories': []},
      'policies': {
        'list': [
          {'id': 'defensive_only', 'rule': 'No offensive hacking, exploitation, retaliation or counter-attack, ever.'},
        ],
      },
      'simulations': {
        'scenarios': [
          {'id': 'pairing_flood', 'name': 'Repeated wrong pairing codes'},
        ],
        'recent': [],
      },
      'physical': {
        'architecture_only': true,
        'devices': [],
        'note': 'Physical security is architecture only: no camera, lock, alarm or sensor is connected.',
      },
      'lockdown': {'active': false},
    };

Map<String, dynamic> layoutWorkflows({bool disabled = false, List<Map<String, dynamic>> candidates = const []}) => {
  'workflows': [
    {
      'id': 'trading_desk',
      'name': 'Trading desk',
      'kind': 'system',
      'summary': 'Charts and paper trades.',
      'approval': 'money',
      'disabled': disabled,
      'stats': {'runs': 5, 'success_rate': 100, 'avg_model_calls': 0},
    },
    {
      'id': 'safety_gate',
      'name': 'Safety gate',
      'kind': 'system',
      'summary': 'Holds money and delete actions.',
      'approval': 'money',
      'disabled': false,
      'stats': {'runs': 0},
    },
    for (var i = 0; i < 100; i++)
      {
        'id': 'cmd:c$i',
        'name': '/c$i',
        'kind': 'command',
        'summary': 'Command $i.',
        'approval': 'none',
        'disabled': disabled && i == 99,
        'stats': {'runs': 0},
      },
    {
      'id': 'learned:ab12',
      'name': 'earn today → /money-dashboard',
      'kind': 'learned',
      'summary': 'Learned.',
      'approval': 'none',
      'disabled': false,
      'stats': {'runs': 1, 'success_rate': 100, 'avg_model_calls': 0},
    },
  ],
  'efficiency': {
    'requests': 8,
    'via_workflow': 6,
    'via_model_only': 2,
    'percent_via_workflow': 75,
    'avg_model_calls_workflow': 0,
    'avg_model_calls_model_path': 2,
    'model_calls_avoided': 12,
    'learned_runs': 1,
  },
  'candidates': candidates,
};

const layoutConversations = <String, dynamic>{
  'threads': [
    {
      'id': 'meeting:m1',
      'kind': 'war_room',
      'title': 'Launch plan',
      'participants': ['CHE', 'Nova'],
      'status': 'done',
      'updated_at': '2026-10-04T01:05:00Z',
      'messages': [
        {'from': 'CHE', 'kind': 'brief', 'text': 'Goal: launch', 'at': '2026-10-04T01:00:00Z'},
        {
          'from': 'Nova',
          'to': 'Knox',
          'kind': 'critique',
          'text': 'Your draft misses pricing',
          'at': '2026-10-04T01:05:00Z',
        },
      ],
    },
  ],
};

Map<String, dynamic> layoutFilm({String state = 'making'}) => {
  'film': {
    'id': 'film_0123456789abcdef',
    'title': 'The Keeper',
    'topic': 'a lighthouse keeper',
    'state': state,
    'target_s': 600,
    'plan': {'ok': true, 'shots': 100, 'tier_a': 0, 'tier_b': 100, 'segments': 10, 'eta_s': 420, 'estimated': true},
    'notes': ['No free GPU farm is connected, so every shot is a still picture with camera motion.'],
    'stats': {'stills_made': 40},
  },
  'progress': {
    'state': state,
    'shots_total': 100,
    'shots_verified': 40,
    'shots_failed': 0,
    'elapsed_s': 120,
    'eta_s': 420,
    'remaining_s': 300,
  },
  'spoken': '"The Keeper": 40 of 100 shots done. 2 minutes in, against an estimate of 7 minutes.',
  'shots': [
    {
      'n': 1,
      'scene': 1,
      'tier': 'B',
      'status': 'verified',
      'description': 'Mara climbs the stairs',
      'still_key': '',
      'reuses': 1,
      'reason': '',
      'downgraded': '',
    },
    {
      'n': 2,
      'scene': 1,
      'tier': 'B',
      'status': 'failed',
      'description': 'Mara looks out',
      'still_key': '',
      'reuses': 2,
      'reason': 'almost no detail (a blank or flat frame)',
      'downgraded': '',
    },
  ],
  'providers': [
    {
      'id': 'workers_ai',
      'name': 'Cloudflare Workers AI',
      'status': 'connected',
      'detail': '3000 of the film\'s 6000 neurons left today.',
    },
    {
      'id': 'kaggle',
      'name': 'Kaggle',
      'status': 'not set up',
      'detail': 'Paste your Kaggle API token in Keys as username:token.',
    },
    {
      'id': 'colab',
      'name': 'Google Colab',
      'status': 'not automated',
      'detail': 'Colab has no official way to start a notebook without a person opening it in a browser, so I cannot run it for you.',
    },
  ],
};
