part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (memory).
extension _CheHomeMemory on _CHEHomeState {
  Future<void> saveMemory(String memory) async {
    if (!await _ensurePaired()) return;

    final clean = memory.trim();
    if (clean.isEmpty) return;

    final response = await http.post(
      Uri.parse('$cheAgentBaseUrl/api/memory/add'),
      headers: _authHeaders,
      body: jsonEncode({'memory': clean}),
    );

    if (response.statusCode == 401) {
      await _clearSecuritySession();
      return;
    }

    await _loadAgentState(silent: true);
  }

  Future<void> deleteMemory(int index) async {
    if (!await _ensurePaired()) return;

    final response = await http.post(
      Uri.parse('$cheAgentBaseUrl/api/memory/delete'),
      headers: _authHeaders,
      body: jsonEncode({'index': index}),
    );

    if (response.statusCode == 401) {
      await _clearSecuritySession();
      return;
    }

    await _loadAgentState(silent: true);
  }

  Future<void> clearAllMemories() async {
    if (!await _ensurePaired()) return;

    final response = await http.post(
      Uri.parse('$cheAgentBaseUrl/api/memory/clear'),
      headers: _authHeaders,
    );

    if (response.statusCode == 401) {
      await _clearSecuritySession();
      return;
    }

    await _loadAgentState(silent: true);
  }

  void openMemoryManager() {
    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFF162532),
      isScrollControlled: true,
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setModalState) {
            return SizedBox(
              height: MediaQuery.of(context).size.height * 0.70,
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  children: [
                    const Text(
                      'C.H.E. MEMORY',
                      style: TextStyle(
                        color: Color(0xFF34E0B8),
                        fontSize: 22,
                        fontWeight: FontWeight.bold,
                        letterSpacing: 2,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '${savedMemories.length} encrypted agent memories',
                      style: const TextStyle(color: Colors.white54),
                    ),
                    const SizedBox(height: 20),
                    Expanded(
                      child: savedMemories.isEmpty
                          ? const Center(
                              child: Text(
                                'No saved memories yet.',
                                style: TextStyle(
                                  color: Colors.white54,
                                  fontSize: 16,
                                ),
                              ),
                            )
                          : ListView.builder(
                              itemCount: savedMemories.length,
                              itemBuilder: (context, index) {
                                return Card(
                                  color: const Color(0xFF243747),
                                  child: ListTile(
                                    leading: const Icon(
                                      Icons.memory,
                                      color: Color(0xFF34E0B8),
                                    ),
                                    title: Text(
                                      savedMemories[index],
                                      style: const TextStyle(
                                        color: Colors.white,
                                      ),
                                    ),
                                    trailing: IconButton(
                                      icon: const Icon(
                                        Icons.delete_outline,
                                        color: Colors.redAccent,
                                      ),
                                      onPressed: () async {
                                        await deleteMemory(index);
                                        setModalState(() {});
                                      },
                                    ),
                                  ),
                                );
                              },
                            ),
                    ),
                    if (savedMemories.isNotEmpty)
                      TextButton.icon(
                        onPressed: () async {
                          await clearAllMemories();
                          setModalState(() {});
                        },
                        icon: const Icon(
                          Icons.delete_forever,
                          color: Colors.redAccent,
                        ),
                        label: const Text(
                          'CLEAR ALL MEMORIES',
                          style: TextStyle(color: Colors.redAccent),
                        ),
                      ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  Future<Map<String, dynamic>?> _postAgentJson(
    String path,
    Map<String, dynamic> body,
  ) async {
    if (!await _ensurePaired()) return null;

    final response = await http.post(
      Uri.parse('$cheAgentBaseUrl$path'),
      headers: _authHeaders,
      body: jsonEncode(body),
    );

    if (response.statusCode == 401) {
      await _clearSecuritySession();
      throw const _CHEAgentException('Pair this device again, sir.');
    }

    final data = response.body.isEmpty
        ? <String, dynamic>{}
        : Map<String, dynamic>.from(jsonDecode(response.body) as Map);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _CHEAgentException(
        data['detail']?.toString() ?? 'CHE could not complete that action.',
      );
    }

    return data;
  }

  Future<void> _ingestOwnerContext({
    required String source,
    required String title,
    String text = '',
    Map<String, String>? attachment,
  }) async {
    try {
      final payload = <String, dynamic>{
        'source': source,
        'title': title,
        if (text.trim().isNotEmpty) 'text': text.trim(),
      };
      if (attachment != null) {
        payload['attachment'] = attachment;
      }

      final result = await _postAgentJson('/api/context/ingest', payload);
      if (result == null) return;

      await _loadAgentState(silent: true);
      if (!mounted) return;

      final item = result['item'] is Map
          ? Map<String, dynamic>.from(result['item'] as Map)
          : <String, dynamic>{};
      final type = item['type']?.toString() ?? 'knowledge';
      final owner = item['owner_agent_name']?.toString() ?? 'CHE Office';

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('CHE learned this as $type • owned by $owner.')),
      );
    } catch (error) {
      if (!mounted) return;
      final message = error
          .toString()
          .replaceFirst('CHEAgentException: ', '')
          .replaceFirst('_CHEAgentException: ', '');
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            message.isEmpty
                ? 'CHE could not learn from that source.'
                : message,
          ),
        ),
      );
    }
  }

  bool _isTextLikeFile(String name) {
    final lower = name.toLowerCase();
    const extensions = [
      '.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.log',
      '.dart', '.js', '.ts', '.html', '.css', '.py', '.sql', '.rtf',
    ];
    return extensions.any(lower.endsWith);
  }

  Future<void> _learnFromFiles() async {
    final result = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      withData: true,
    );
    if (result == null || result.files.isEmpty) return;

    for (final file in result.files.take(8)) {
      final bytes = file.bytes;
      if (bytes == null || bytes.isEmpty) continue;
      if (bytes.length > 5 * 1024 * 1024) continue;

      if (_isTextLikeFile(file.name)) {
        final text = utf8.decode(bytes, allowMalformed: true);
        await _ingestOwnerContext(
          source: 'files',
          title: file.name,
          text: text.length > 12000 ? text.substring(0, 12000) : text,
        );
      } else {
        await _ingestOwnerContext(
          source: 'files',
          title: file.name,
          attachment: {
            'name': file.name,
            'media_type': _mediaTypeFromName(file.name),
            'base64': base64Encode(bytes),
          },
        );
      }
    }
  }

  Future<void> _learnFromPhoto() async {
    final file = await _imagePicker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 82,
      maxWidth: 1800,
    );
    if (file == null) return;
    final bytes = await file.readAsBytes();
    if (bytes.length > 5 * 1024 * 1024) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Choose a photo under 5 MB for learning.')),
        );
      }
      return;
    }
    await _ingestOwnerContext(
      source: 'photos_videos',
      title: file.name,
      attachment: {
        'name': file.name,
        'media_type': 'image',
        'base64': base64Encode(bytes),
      },
    );
  }

  Future<void> _learnFromVideo() async {
    final file = await _imagePicker.pickVideo(
      source: ImageSource.gallery,
      maxDuration: const Duration(minutes: 2),
    );
    if (file == null) return;
    final bytes = await file.readAsBytes();
    if (bytes.length > 5 * 1024 * 1024) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Choose a short video under 5 MB for learning.')),
        );
      }
      return;
    }
    await _ingestOwnerContext(
      source: 'photos_videos',
      title: file.name,
      attachment: {
        'name': file.name,
        'media_type': 'video',
        'base64': base64Encode(bytes),
      },
    );
  }

  Future<void> _learnFromClipboard() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text?.trim() ?? '';
    if (text.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Copy a message, email, webpage text or note first.'),
          ),
        );
      }
      return;
    }
    await _ingestOwnerContext(
      source: 'shared_text',
      title: 'Shared text',
      text: text.length > 12000 ? text.substring(0, 12000) : text,
    );
  }

  Future<void> _learnFromBrowserPage(
    String title,
    String url,
    String pageText,
  ) async {
    final cleanText = pageText.trim();
    await _ingestOwnerContext(
      source: 'che_browser',
      title: title.trim().isEmpty ? Uri.tryParse(url)?.host ?? 'Web page' : title,
      text: [
        if (url.trim().isNotEmpty) 'URL: $url',
        if (cleanText.isNotEmpty)
          cleanText.length > 12000 ? cleanText.substring(0, 12000) : cleanText,
      ].join('\n\n'),
    );
  }

  Future<void> _openPersonalSources() async {
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF162532),
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Wrap(
            children: [
              const ListTile(
                title: Text(
                  'PERSONAL SOURCES',
                  style: TextStyle(
                    color: Color(0xFF34E0B8),
                    fontWeight: FontWeight.w800,
                  ),
                ),
                subtitle: Text(
                  'You choose what CHE can learn. Nothing here silently bypasses iPhone privacy controls.',
                ),
              ),
              ListTile(
                leading: const Icon(Icons.photo_library_outlined),
                title: const Text('Photos'),
                subtitle: const Text('Choose a photo for CHE to analyze and organize.'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  unawaited(_learnFromPhoto());
                },
              ),
              ListTile(
                leading: const Icon(Icons.video_library_outlined),
                title: const Text('Videos'),
                subtitle: const Text('Choose a short video for connected multimodal analysis.'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  unawaited(_learnFromVideo());
                },
              ),
              ListTile(
                leading: const Icon(Icons.folder_open_outlined),
                title: const Text('Files'),
                subtitle: const Text('Import documents, notes, data, audio or other files.'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  unawaited(_learnFromFiles());
                },
              ),
              ListTile(
                leading: const Icon(Icons.content_paste_outlined),
                title: const Text('Messages, email or shared text'),
                subtitle: const Text('Copy/share text, then let CHE classify it into her brain.'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  unawaited(_learnFromClipboard());
                },
              ),
              ListTile(
                leading: const Icon(Icons.language_outlined),
                title: const Text('CHE browser'),
                subtitle: const Text('Open a page in Apps, then tap the brain icon to teach CHE that page.'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  Future<void>.delayed(
                    const Duration(milliseconds: 150),
                    () => _openAssistantHub(tab: 8),
                  );
                },
              ),
              ListTile(
                leading: const Icon(Icons.mail_outline),
                title: const Text('Email account sync'),
                subtitle: const Text('Full mailbox sync needs an authorized email connector/OAuth plugin.'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  _runHubPrompt(
                    'Set up an authorized email connector for CHE so she can learn from the mailboxes I explicitly connect. Keep credentials server-side and let me choose folders and sync scope.',
                  );
                },
              ),
              const ListTile(
                leading: Icon(Icons.sms_outlined),
                title: Text('Apple Messages'),
                subtitle: Text(
                  'iOS does not expose the full Messages database to normal apps. Use share/copy import or a companion connector.',
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _createProjectDialog() async {
    if (!await _ensurePaired() || !mounted) return;

    final titleController = TextEditingController();
    final briefController = TextEditingController();
    var projectType = 'general';
    var busy = false;
    String? errorText;

    final created = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (dialogContext, setDialogState) {
            Future<void> create() async {
              final title = titleController.text.trim();
              if (title.isEmpty) {
                setDialogState(() => errorText = 'Give the project a name.');
                return;
              }

              setDialogState(() {
                busy = true;
                errorText = null;
              });

              try {
                final result = await _postAgentJson('/api/project/create', {
                  'title': title,
                  'type': projectType,
                  'brief': briefController.text.trim(),
                });
                final project = result?['project'];
                if (project is! Map) {
                  throw const _CHEAgentException(
                    'CHE did not return the new project.',
                  );
                }
                await _loadAgentState(silent: true);
                if (dialogContext.mounted) {
                  Navigator.pop(
                    dialogContext,
                    Map<String, dynamic>.from(project),
                  );
                }
              } catch (e) {
                setDialogState(() {
                  busy = false;
                  errorText = e.toString();
                });
              }
            }

            return AlertDialog(
              backgroundColor: const Color(0xFF162532),
              title: const Text('NEW CHE PROJECT'),
              content: SizedBox(
                width: 460,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      TextField(
                        controller: titleController,
                        decoration: const InputDecoration(
                          labelText: 'Project name',
                          hintText: 'Harriet’s Dream website',
                        ),
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        initialValue: projectType,
                        decoration: const InputDecoration(
                          labelText: 'Project type',
                        ),
                        items: const [
                          DropdownMenuItem(value: 'general', child: Text('General project')),
                          DropdownMenuItem(value: 'website', child: Text('Website')),
                          DropdownMenuItem(value: 'app', child: Text('App')),
                          DropdownMenuItem(value: 'book', child: Text('Book')),
                          DropdownMenuItem(value: 'screenplay', child: Text('Movie / screenplay')),
                          DropdownMenuItem(value: 'invention', child: Text('Invention / prototype')),
                          DropdownMenuItem(value: 'business', child: Text('Business')),
                          DropdownMenuItem(value: 'roblox_game', child: Text('Roblox · Game')),
                          DropdownMenuItem(value: 'roblox_weapon', child: Text('Roblox · Weapon')),
                          DropdownMenuItem(value: 'roblox_clothing', child: Text('Roblox · Clothing / UGC')),
                          DropdownMenuItem(value: 'roblox_pass', child: Text('Roblox · Game Pass')),
                        ],
                        onChanged: busy
                            ? null
                            : (value) {
                                if (value != null) {
                                  setDialogState(() => projectType = value);
                                }
                              },
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: briefController,
                        minLines: 4,
                        maxLines: 8,
                        decoration: const InputDecoration(
                          labelText: 'Tell CHE what to build',
                          hintText: 'Describe the idea, style, goals and requirements.',
                          alignLabelWithHint: true,
                        ),
                      ),
                      if (errorText != null) ...[
                        const SizedBox(height: 10),
                        Text(
                          errorText!,
                          style: const TextStyle(color: Colors.redAccent),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: busy ? null : () => Navigator.pop(dialogContext),
                  child: const Text('CANCEL'),
                ),
                FilledButton.icon(
                  onPressed: busy ? null : create,
                  icon: busy
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.auto_awesome),
                  label: Text(busy ? 'BUILDING...' : 'CREATE'),
                ),
              ],
            );
          },
        );
      },
    );

    titleController.dispose();
    briefController.dispose();

    if (created != null && mounted) {
      await _openProjectEditor(created);
    }
  }

  Future<void> _openProjectEditor(Map<String, dynamic> source) async {
    if (!mounted) return;

    var project = Map<String, dynamic>.from(source);
    final titleController = TextEditingController(
      text: project['title']?.toString() ?? '',
    );
    final contentController = TextEditingController(
      text: project['content']?.toString() ?? '',
    );
    final instructionController = TextEditingController();
    var busy = false;
    String? statusText;

    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF101821),
      isScrollControlled: true,
      builder: (sheetContext) {
        return StatefulBuilder(
          builder: (sheetContext, setSheetState) {
            Future<void> save() async {
              setSheetState(() {
                busy = true;
                statusText = 'Saving to CHE Vault...';
              });
              try {
                final result = await _postAgentJson('/api/project/update', {
                  'id': project['id'],
                  'title': titleController.text.trim(),
                  'content': contentController.text,
                  'status': 'draft',
                });
                final updated = result?['project'];
                if (updated is Map) {
                  project = Map<String, dynamic>.from(updated);
                }
                await _loadAgentState(silent: true);
                setSheetState(() {
                  busy = false;
                  statusText = 'Saved.';
                });
              } catch (e) {
                setSheetState(() {
                  busy = false;
                  statusText = e.toString();
                });
              }
            }

            Future<void> develop() async {
              final instruction = instructionController.text.trim();
              if (instruction.isEmpty) {
                setSheetState(() {
                  statusText = 'Tell CHE what you want developed next.';
                });
                return;
              }

              setSheetState(() {
                busy = true;
                statusText = 'CHE is developing the project...';
              });

              try {
                final result = await _postAgentJson('/api/project/generate', {
                  'id': project['id'],
                  'instruction': instruction,
                });
                final updated = result?['project'];
                if (updated is Map) {
                  project = Map<String, dynamic>.from(updated);
                  titleController.text = project['title']?.toString() ?? '';
                  contentController.text = project['content']?.toString() ?? '';
                }
                instructionController.clear();
                await _loadAgentState(silent: true);
                setSheetState(() {
                  busy = false;
                  statusText = 'Project updated.';
                });
              } catch (e) {
                setSheetState(() {
                  busy = false;
                  statusText = e.toString();
                });
              }
            }

            Future<void> remove() async {
              setSheetState(() {
                busy = true;
                statusText = 'Deleting project...';
              });
              try {
                await _postAgentJson('/api/project/delete', {
                  'id': project['id'],
                });
                await _loadAgentState(silent: true);
                if (sheetContext.mounted) Navigator.pop(sheetContext);
              } catch (e) {
                setSheetState(() {
                  busy = false;
                  statusText = e.toString();
                });
              }
            }

            return SafeArea(
              child: Padding(
                padding: EdgeInsets.only(
                  left: 18,
                  right: 18,
                  top: 16,
                  bottom: MediaQuery.of(sheetContext).viewInsets.bottom + 18,
                ),
                child: SizedBox(
                  height: MediaQuery.of(sheetContext).size.height * 0.88,
                  child: Column(
                    children: [
                      Row(
                        children: [
                          const Icon(
                            Icons.auto_awesome,
                            color: Color(0xFF34E0B8),
                          ),
                          const SizedBox(width: 10),
                          const Expanded(
                            child: Text(
                              'CHE CREATOR STUDIO',
                              style: TextStyle(
                                fontWeight: FontWeight.bold,
                                letterSpacing: 1.4,
                              ),
                            ),
                          ),
                          IconButton(
                            onPressed: busy ? null : remove,
                            icon: const Icon(
                              Icons.delete_outline,
                              color: Colors.redAccent,
                            ),
                          ),
                        ],
                      ),
                      TextField(
                        controller: titleController,
                        decoration: const InputDecoration(
                          labelText: 'Project name',
                        ),
                      ),
                      const SizedBox(height: 10),
                      Expanded(
                        child: TextField(
                          controller: contentController,
                          expands: true,
                          minLines: null,
                          maxLines: null,
                          textAlignVertical: TextAlignVertical.top,
                          decoration: const InputDecoration(
                            labelText: 'Working project',
                            alignLabelWithHint: true,
                            border: OutlineInputBorder(),
                          ),
                        ),
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        controller: instructionController,
                        minLines: 2,
                        maxLines: 4,
                        decoration: const InputDecoration(
                          labelText: 'Tell CHE what to do next',
                          hintText: 'Example: Write the opening scene with more tension.',
                        ),
                      ),
                      if (statusText != null) ...[
                        const SizedBox(height: 8),
                        Text(
                          statusText!,
                          style: const TextStyle(color: Colors.white70),
                        ),
                      ],
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: busy ? null : save,
                              icon: const Icon(Icons.save_outlined),
                              label: const Text('SAVE'),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: FilledButton.icon(
                              onPressed: busy ? null : develop,
                              icon: busy
                                  ? const SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : const Icon(Icons.auto_awesome),
                              label: const Text('DEVELOP'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        );
      },
    );

    titleController.dispose();
    contentController.dispose();
    instructionController.dispose();
  }

  Future<void> _addVaultNote() async {
    if (!await _ensurePaired() || !mounted) return;

    final nameController = TextEditingController();
    final contentController = TextEditingController();
    var busy = false;
    String? errorText;

    await showDialog<void>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (dialogContext, setDialogState) {
            Future<void> save() async {
              final name = nameController.text.trim();
              final content = contentController.text.trim();
              if (name.isEmpty || content.isEmpty) {
                setDialogState(() => errorText = 'Add a name and content.');
                return;
              }

              setDialogState(() {
                busy = true;
                errorText = null;
              });

              try {
                await _postAgentJson('/api/vault/add', {
                  'name': name,
                  'content': content,
                  'kind': 'note',
                });
                await _loadAgentState(silent: true);
                if (dialogContext.mounted) Navigator.pop(dialogContext);
              } catch (e) {
                setDialogState(() {
                  busy = false;
                  errorText = e.toString();
                });
              }
            }

            return AlertDialog(
              backgroundColor: const Color(0xFF162532),
              title: const Text('SAVE TO CHE VAULT'),
              content: SizedBox(
                width: 440,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextField(
                      controller: nameController,
                      decoration: const InputDecoration(labelText: 'Name'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: contentController,
                      minLines: 5,
                      maxLines: 10,
                      decoration: const InputDecoration(
                        labelText: 'Content',
                        alignLabelWithHint: true,
                      ),
                    ),
                    if (errorText != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        errorText!,
                        style: const TextStyle(color: Colors.redAccent),
                      ),
                    ],
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: busy ? null : () => Navigator.pop(dialogContext),
                  child: const Text('CANCEL'),
                ),
                FilledButton(
                  onPressed: busy ? null : save,
                  child: Text(busy ? 'SAVING...' : 'SAVE'),
                ),
              ],
            );
          },
        );
      },
    );

    nameController.dispose();
    contentController.dispose();
  }

  Future<void> _openVault() async {
    await _loadAgentState(silent: true);
    if (!mounted) return;

    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF101821),
      isScrollControlled: true,
      builder: (sheetContext) {
        return StatefulBuilder(
          builder: (sheetContext, setSheetState) {
            return SafeArea(
              child: SizedBox(
                height: MediaQuery.of(sheetContext).size.height * 0.82,
                child: Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(18, 16, 12, 8),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.storage_outlined,
                            color: Color(0xFF34E0B8),
                          ),
                          const SizedBox(width: 10),
                          const Expanded(
                            child: Text(
                              'CHE CORE DATA VAULT',
                              style: TextStyle(
                                fontWeight: FontWeight.bold,
                                letterSpacing: 1.3,
                              ),
                            ),
                          ),
                          IconButton(
                            onPressed: () async {
                              await _addVaultNote();
                              setSheetState(() {});
                            },
                            icon: const Icon(Icons.add_circle_outline),
                          ),
                        ],
                      ),
                    ),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 18),
                      child: Text(
                        'Persistent CHE storage for notes and project data. Large binary files use separate object storage when connected.',
                        style: TextStyle(color: Colors.white54),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Expanded(
                      child: vaultItems.isEmpty
                          ? const Center(
                              child: Text(
                                'No vault notes yet.',
                                style: TextStyle(color: Colors.white54),
                              ),
                            )
                          : ListView.builder(
                              padding: const EdgeInsets.all(14),
                              itemCount: vaultItems.length,
                              itemBuilder: (context, index) {
                                final item = vaultItems[index];
                                return Card(
                                  child: ListTile(
                                    leading: const Icon(Icons.description_outlined),
                                    title: Text(item['name']?.toString() ?? 'Vault item'),
                                    subtitle: Text(
                                      item['content']?.toString() ?? '',
                                      maxLines: 3,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                    onTap: () {
                                      showDialog<void>(
                                        context: context,
                                        builder: (context) => AlertDialog(
                                          title: Text(
                                            item['name']?.toString() ?? 'Vault item',
                                          ),
                                          content: SingleChildScrollView(
                                            child: SelectableText(
                                              item['content']?.toString() ?? '',
                                            ),
                                          ),
                                          actions: [
                                            TextButton(
                                              onPressed: () => Navigator.pop(context),
                                              child: const Text('CLOSE'),
                                            ),
                                          ],
                                        ),
                                      );
                                    },
                                    trailing: IconButton(
                                      icon: const Icon(Icons.delete_outline),
                                      onPressed: () async {
                                        try {
                                          await _postAgentJson('/api/vault/delete', {
                                            'id': item['id'],
                                          });
                                          await _loadAgentState(silent: true);
                                          setSheetState(() {});
                                        } catch (_) {}
                                      },
                                    ),
                                  ),
                                );
                              },
                            ),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  CheWorldState get _currentWorldState {
    if (_isSpeaking) return CheWorldState.speaking;
    if (_isSending) return CheWorldState.thinking;
    if (isListening) return CheWorldState.listening;
    if (cheSleeping) return CheWorldState.asleep;
    return CheWorldState.idle;
  }

  void _openVirtualOffice() {
    HapticFeedback.selectionClick();
    Navigator.of(context).push(
      CupertinoPageRoute<void>(
        builder: (routeContext) => CheWorldHubScreen(
          state: _currentWorldState,
          onOpenTab: (tab) {
            HapticFeedback.selectionClick();
            Navigator.of(routeContext).pop();
            _openAssistantHub(tab: tab);
          },
        ),
      ),
    );
  }

  void _openAssistantHub({int tab = 0}) {
    _selectedTab = tab < 0 ? 0 : (tab > 9 ? 9 : tab);
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF101821),
      isScrollControlled: true,
      builder: (context) {
        return SizedBox(
          height: MediaQuery.of(context).size.height * 0.90,
          child: CheImmersiveHubShell(
            initialIndex: _selectedTab,
            onIndexChanged: (index) => _selectedTab = index,
            tabs: const [
              Tab(icon: Icon(Icons.memory_outlined), text: 'Memory'),
              Tab(icon: Icon(Icons.auto_awesome_outlined), text: 'Insights'),
              Tab(icon: Icon(Icons.show_chart), text: 'Markets'),
              Tab(icon: Icon(Icons.business_center_outlined), text: 'Business'),
              Tab(icon: Icon(Icons.devices_other_outlined), text: 'Devices'),
              Tab(icon: Icon(Icons.music_note_outlined), text: 'Music'),
              Tab(icon: Icon(Icons.lightbulb_outline), text: 'Create'),
              Tab(icon: Icon(Icons.workspaces_outline), text: 'Office'),
              Tab(icon: Icon(Icons.apps_rounded), text: 'Apps'),
              Tab(icon: Icon(Icons.theaters_outlined), text: 'Theater'),
            ],
            pages: [
              (_) => _hubMemoryTab(),
              (active) => _hubInsightsTab(active),
              (_) => _hubMarketsTab(),
              (_) => _hubBusinessTab(),
              (active) => _hubDevicesTab(active),
              (active) => _hubMusicTab(active),
              (active) => _hubCreateTab(active),
              (active) => _hubOfficeTab(active),
              (_) => CheAppsHubTab(onLearnPage: _learnFromBrowserPage),
              (_) {
                _ensureOfficeRuntime();
                return CheTheaterRoom(
                  runtime: _officeRuntime,
                  client: _agentRuntime,
                  onOpenOffice: _openOfficeFloor,
                  onAskAboutScene: (prompt, jpeg) async {
                    if (jpeg != null) {
                      _set(() => _pendingAttachment = {
                            'name': 'theater-scene.jpg',
                            'media_type': 'image',
                            'base64': jpeg,
                          });
                    }
                    Navigator.of(context).popUntil((route) => route.isFirst);
                    controller.text = prompt;
                    await sendMessage();
                  },
                );
              },
            ],
          ),
        );
      },
    );
  }

  String _mediaTypeFromName(String name) {
    final lower = name.toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.heic', '.webp', '.gif'];
    const videoExts = ['.mp4', '.mov', '.m4v', '.webm'];
    const audioExts = ['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg'];

    if (imageExts.any(lower.endsWith)) return 'image';
    if (videoExts.any(lower.endsWith)) return 'video';
    if (audioExts.any(lower.endsWith)) return 'audio';
    return 'document';
  }

  Future<void> _setMultimodalAttachment(
    String name,
    List<int> bytes,
  ) async {
    const maxBytes = 5 * 1024 * 1024;
    if (bytes.isEmpty) return;

    if (bytes.length > maxBytes) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Keep multimodal attachments under 5 MB for now.'),
        ),
      );
      return;
    }

    if (!mounted) return;
    _set(() {
      _pendingAttachment = {
        'name': name,
        'media_type': _mediaTypeFromName(name),
        'base64': base64Encode(bytes),
      };
    });
  }

  Future<void> _pickMultimodalFile() async {
    final result = await FilePicker.platform.pickFiles(
      allowMultiple: false,
      withData: true,
    );
    if (result == null || result.files.isEmpty) return;

    final file = result.files.single;
    final bytes = file.bytes;
    if (bytes == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('CHE could not read that file on this device.'),
        ),
      );
      return;
    }

    await _setMultimodalAttachment(file.name, bytes);
  }

  Future<void> _captureMultimodalImage({
    required ImageSource source,
  }) async {
    final file = await _imagePicker.pickImage(
      source: source,
      imageQuality: 82,
      maxWidth: 1800,
    );
    if (file == null) return;
    await _setMultimodalAttachment(file.name, await file.readAsBytes());
  }

  Future<void> _captureMultimodalVideo() async {
    final file = await _imagePicker.pickVideo(
      source: ImageSource.camera,
      maxDuration: const Duration(minutes: 2),
    );
    if (file == null) return;
    await _setMultimodalAttachment(file.name, await file.readAsBytes());
  }

  Future<void> _openMultimodalPicker() async {
    if (!mounted) return;

    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF162532),
      builder: (context) {
        return SafeArea(
          child: Wrap(
            children: [
              const ListTile(
                title: Text(
                  'MULTIMODAL INPUT',
                  style: TextStyle(
                    color: Color(0xFF34E0B8),
                    fontWeight: FontWeight.bold,
                  ),
                ),
                subtitle: Text(
                  'Give CHE a photo, video, audio file, document or data file.',
                ),
              ),
              ListTile(
                leading: const Icon(Icons.camera_alt_outlined),
                title: const Text('Take photo'),
                onTap: () {
                  Navigator.pop(context);
                  _captureMultimodalImage(source: ImageSource.camera);
                },
              ),
              ListTile(
                leading: const Icon(Icons.photo_library_outlined),
                title: const Text('Choose photo'),
                onTap: () {
                  Navigator.pop(context);
                  _captureMultimodalImage(source: ImageSource.gallery);
                },
              ),
              ListTile(
                leading: const Icon(Icons.videocam_outlined),
                title: const Text('Record video'),
                onTap: () {
                  Navigator.pop(context);
                  _captureMultimodalVideo();
                },
              ),
              ListTile(
                leading: const Icon(Icons.attach_file),
                title: const Text('Choose audio, document or data file'),
                onTap: () {
                  Navigator.pop(context);
                  _pickMultimodalFile();
                },
              ),
              if (_pendingAttachment != null)
                ListTile(
                  leading: const Icon(Icons.close, color: Colors.redAccent),
                  title: const Text('Remove current attachment'),
                  onTap: () {
                    _set(() => _pendingAttachment = null);
                    Navigator.pop(context);
                  },
                ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _loadSharedScreenContext() async {
    try {
      final data = await Clipboard.getData(Clipboard.kTextPlain);
      final value = data?.text?.trim();

      if (value == null || value.isEmpty) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Copy the text you want C.H.E. to read, then tap this again.',
            ),
          ),
        );
        return;
      }

      _pendingScreenContext =
          value.length > 12000 ? value.substring(0, 12000) : value;

      if (!mounted) return;
      _set(() {});

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(          content: Text(
            'Shared screen/text context is ready for your next C.H.E. request.',
          ),
        ),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'This platform did not allow clipboard access.',
          ),
        ),
      );
    }
  }

  List<String> _requestedCapabilities(String message) {
    final lower = message.toLowerCase();
    final result = <String>[];

    bool hasAny(List<String> markers) =>
        markers.any((marker) => lower.contains(marker));

    if (hasAny([
      'search the web',
      'look up',
      'find online',
      'latest',
      'current news',
      'real time',
      'real-time',
      'track down',
      'research',
    ])) {
      result.add('web_research');
    }

    if (hasAny([
      'cross reference',
      'cross-reference',
      'verify',
      'fact check',
      'fact-check',
      'double check',
      'double-check',
      'confirm this',
      'is this true',
      'compare sources',
      'check multiple sources',
    ])) {
      result.add('cross_reference');
      if (!result.contains('web_research')) {
        result.add('web_research');
      }
    }

    if (hasAny([
      'render',
      'draw',
      'create an image',
      'generate an image',
      'make a picture',
      'visualize',
      'diagram',
    ])) {
      result.add('rendering');
      result.add('image_generation');
    }

    if (hasAny([
      'generate a video',
      'create a video',
      'make a video',
      'render a video',
      'video generation',
      'animate this',
      'make this move',
    ])) {
      result.add('video_generation');
    }

    if (hasAny([
      'my screen',
      'read the screen',
      'what am i looking at',
      'look at this screen',
    ])) {
      result.add('screen_context');
    }

    if (hasAny([
      'text ',
      'message ',
      'call ',
      'phone ',
      'reply to',
      'open the app',
    ])) {
      result.add('phone_action');
    }

    if (hasAny([
      'windows',
      'on my pc',
      'on my computer',
      'desktop',
    ])) {
      result.add('windows_action');
    }

    if (hasAny([
      'stock',
      'stocks',
      'nasdaq',
      's&p',
      'market',
      'trading',
      'futures',
      'nq',
      'crypto',
      'bitcoin',
      'ethereum',
      'setup',
      'entry',
      'stop loss',
      'take profit',
    ])) {
      result.add('market_data');
      if (!result.contains('web_research')) {
        result.add('web_research');
      }
    }

    if (hasAny([
      'backtest',
      'backtesting',
      'historical test',
      'strategy test',
      'indicator',
      'scanner',
    ])) {
      result.add('backtesting');
    }

    if (hasAny([
      'copy trade',
      'copy trading',
      'mirror trade',
      'live account',
      'broker account',
      'place trade',
      'execute trade',
    ])) {
      result.add('broker_execution');
    }

    if (hasAny([
      'prop firm',
      'propfirm',
      'funded account',
      'evaluation account',
    ])) {
      result.add('prop_firm');
    }

    if (hasAny([
      'public record',
      'public records',
      'court record',
      'property record',
      'business filing',
      'became public',
    ])) {
      result.add('public_records');
      if (!result.contains('web_research')) {
        result.add('web_research');
      }
    }

    if (hasAny([
      'face verify',
      'face verification',
      'recognize my face',
      'facial recognition',
      'face recognition',
    ])) {
      result.add('face_verify');
    }

    if (hasAny([
      'recognize this data',
      'analyze this data',
      'read this document',
      'extract this table',
      'scan this document',
      'understand this screenshot',
      'data recognition',
    ])) {
      result.add('data_recognition');
    }

    if (_pendingAttachment != null ||
        hasAny([
          'analyze this photo',
          'analyze this image',
          'watch this video',
          'analyze this video',
          'listen to this audio',
          'analyze this audio',
          'read this file',
          'analyze this file',
          'multimodal',
        ])) {
      result.add('multimodal');
    }

    if (hasAny([
      'cash flow',
      'business plan',
      'manage my business',
      'invoice',
      'billing',
      'customer',
      'crm',
      'expense',
      'revenue',
      'bookkeeping',
    ])) {
      result.add('business_ops');
    }

    if (hasAny([
      'advertising',
      'advertise',
      'ad campaign',
      'ad campaigns',
      'marketing campaign',
      'paid ads',
      'facebook ads',
      'instagram ads',
      'google ads',
      'tiktok ads',
      'meta ads',
      'ad copy',
      'media buying',
      'campaign budget',
      'campaign performance',
    ])) {
      result.add('advertising');
    }

    if (hasAny([
      'find clients',
      'find customers',
      'find leads',
      'people who need my service',
      'people who need my services',
      'prospects',
      'lead generation',
    ])) {
      result.add('lead_generation');
    }

    if (hasAny([
      'charge customer',
      'charge client',
      'take payment',
      'collect payment',
      'send invoice',
    ])) {
      result.add('payments');
    }

    if (hasAny([
      'music',
      'song',
      'playlist',
      'apple music',
      'play ',
      'pause ',
      'next song',
    ])) {
      result.add('music_control');
    }

    if (hasAny([
      'bluetooth',
      'car',
      'carplay',
      'vehicle',
    ])) {
      result.add('car_bluetooth');
    }

    if (hasAny([
      'light',
      'lights',
      'homekit',
      'matter',
      'smart home',
      'smart-home',
    ])) {
      result.add('smart_home');
    }

    if (hasAny([
      'invent',
      'innovate',
      'invention',
      'prototype',
      'feasible',
      'feasibility',
      'humanly possible',
      'artistically possible',
      'new idea',
      'never been done',
    ])) {
      result.add('innovation_mode');
      if (!result.contains('web_research')) {
        result.add('web_research');
      }
    }

    if (hasAny([
      'change your ui',
      'change the ui',
      'redesign your',
      'redesign the ui',
      'modify your app',
      'update your app',
      'change your screen',
      'move this button',
      'move this control',
      'proofread code',
      'review code',
      'write code',
      'edit code',
      'refactor',
      'add it to yourself',
      'add this to yourself',
      'your code',
    ])) {
      result.add('self_development');
    }

    if (hasAny([
      'write a book',
      'book idea',
      'novel',
      'movie',
      'film',
      'screenplay',
      'script',
      'episode',
      'scene',
      'story',
      'character arc',
    ])) {
      result.add('creative_writing');
    }

    if (hasAny([
      'marketing',
      'social media',
      'instagram',
      'tiktok',
      'facebook',
      'youtube content',
      'content calendar',
      'brand strategy',
      'ad copy',
      'campaign',
    ])) {
      result.add('marketing_social');
    }

    if (hasAny([
      'how long',
      'wait time',
      'eta',
      'estimate',
      'estimated time',
    ])) {
      result.add('estimated_wait_time');
    }

    if (hasAny([
      'quantum',
      'quantum computer',
      'quantum computing',
      'quantum optimization',
      'quantum simulation',
    ])) {
      result.add('quantum_compute');
    }

    if (hasAny([
      'fine tune',
      'fine-tune',
      'fine tuning',
      'fine-tuning',
      'train model',
      'train a model',
      'lora',
      'adapter tuning',
      'vmware private ai',
      'vmware training',
      'hugging face training',
      'huggingface training',
    ])) {
      result.add('fine_tuning');
    }

    if (hasAny([
      'at the same time',
      'while you',
      'also do',
      'multitask',
      'multiple things',
      'all of these',
      'all of that',
      'batch',
      'batching',
      'behind the scenes',
      'behind-the-scenes',
      'in the background',
      'background work',
      'parallel',
      'fast as possible',
      'fastest way',
    ])) {
      result.add('multitasking');
      result.add('background_work');
      result.add('speed_mode');
    }

    return result;
  }
}
