// Shared sample data for the showroom tests.
// Sample showroom records for the showroom tests and goldens (shape from capability_showroom.js showroomView).
Map<String, dynamic> showroom() => {
      'categories': [
        {
          'id': 'inventions',
          'number': 1,
          'title': 'Inventions & Engineering',
          'summary': 'Concept designs, parts and feasibility notes.',
          'capabilities': [
            {
              'id': 'invention_studio',
              'title': 'Invention Studio',
              'description': 'Concept to parts list, cost bands and feasibility notes.',
              'example': 'design me a desk lamp',
              'output': 'A project record with parts and labels',
              'state': 'ready',
              'status_label': 'Ready',
              'reason': '',
              'start': 'design me a desk lamp',
              'thumbnail': 'real',
              'thumbnail_note': 'Real saved output.',
              'recent_project': {'kind': 'invention', 'id': 'inv-1', 'title': 'Desk lamp'},
              'missing': [],
            },
            {
              'id': 'exo',
              'title': 'Exoskeleton concept',
              'description': 'A concept only: no powered build is claimed.',
              'example': 'concept an exoskeleton',
              'output': 'Concept notes',
              'state': 'partial',
              'status_label': 'Partial',
              'reason': 'Concept only, no verified parts.',
              'start': 'concept an exoskeleton',
              'thumbnail': 'illustration',
              'thumbnail_note': 'Concept example: an illustration, not an output CHE made.',
              'recent_project': null,
              'missing': ['verified parts list'],
            },
          ],
        },
        {
          'id': 'video',
          'number': 2,
          'title': 'Video, Film & Animation',
          'summary': 'Videos and pictures CHE renders.',
          'capabilities': [
            {
              'id': 'video',
              'title': 'Video renderer',
              'description': 'Short videos from a script.',
              'example': 'make a short video',
              'output': 'MP4',
              'state': 'needs_setup',
              'status_label': 'Needs setup',
              'reason': 'No renderer is connected.',
              'start': 'make a short video',
              'thumbnail': 'illustration',
              'thumbnail_note': 'Concept example: an illustration, not an output CHE made.',
              'recent_project': null,
              'missing': ['renderer'],
            },
          ],
        },
      ],
    };

