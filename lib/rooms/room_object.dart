import 'package:flutter/material.dart';

enum RoomObjectKind { data, action, notConnected }

/// Every tappable/visible object in Office, Create, Music, Devices, Insights MUST be registered.
class RoomObjectSpec {
  const RoomObjectSpec({
    required this.id,
    required this.room,
    required this.label,
    required this.kind,
    this.open,
    this.dataSourceId,
    this.requiredCapability,
    this.requiredPluginLabel,
  });

  final String id;
  final String room;
  final String label;
  final RoomObjectKind kind;

  /// Opens the real content or performs the real action.
  final void Function(BuildContext context)? open;

  /// e.g. 'office.tasks', 'office.notes', 'create.projects', 'insights.memory'
  final String? dataSourceId;

  /// For placeholders: capability id from the Worker catalog, e.g. 'music'.
  final String? requiredCapability;

  /// Human text, e.g. 'a music plugin (Spotify or Apple Music)'.
  final String? requiredPluginLabel;

  String? validate() {
    switch (kind) {
      case RoomObjectKind.data:
        return (dataSourceId == null || open == null) ? '$room/$id: data object needs dataSourceId and open' : null;
      case RoomObjectKind.action:
        return open == null ? '$room/$id: action object needs open' : null;
      case RoomObjectKind.notConnected:
        return (requiredCapability == null || requiredPluginLabel == null)
            ? '$room/$id: placeholder must name the capability and plugin it needs'
            : null;
    }
  }

  void onTap(BuildContext context) {
    if (kind == RoomObjectKind.notConnected) {
      showNotConnectedSheet(context, label, requiredPluginLabel!);
    } else {
      open!(context);
    }
  }
}

class RoomRegistry {
  static final List<RoomObjectSpec> _all = [];
  static void register(RoomObjectSpec s) => _all.add(s);
  static void registerAll(Iterable<RoomObjectSpec> specs) => _all.addAll(specs);
  static List<RoomObjectSpec> get all => List.unmodifiable(_all);
  static void clear() => _all.clear();
}

void showNotConnectedSheet(BuildContext context, String label, String pluginLabel) {
  showModalBottomSheet<void>(
    context: context,
    builder: (_) => Padding(
      padding: const EdgeInsets.all(24),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('$label — Not connected', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Text('To use this, CHE needs $pluginLabel. Add it under Settings → Plugins.'),
      ]),
    ),
  );
}

/// Paper/report viewer: pinch-zoom, pan, edit, and provenance.
class ZoomableDocument extends StatefulWidget {
  const ZoomableDocument({
    super.key,
    required this.title,
    required this.body,
    required this.createdBy,
    required this.why,
    required this.createdAt,
    required this.verifiedByChe,
    this.onSave,
  });
  final String title, body, createdBy, why;
  final DateTime createdAt;
  final bool verifiedByChe;
  final Future<void> Function(String newBody)? onSave;

  @override
  State<ZoomableDocument> createState() => _ZoomableDocumentState();
}

class _ZoomableDocumentState extends State<ZoomableDocument> {
  late final TextEditingController _c = TextEditingController(text: widget.body);
  bool _editing = false;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title), actions: [
        if (widget.onSave != null)
          IconButton(
            icon: Icon(_editing ? Icons.check : Icons.edit),
            onPressed: () async {
              if (_editing) await widget.onSave!(_c.text);
              if (mounted) setState(() => _editing = !_editing);
            },
          ),
      ]),
      body: Column(children: [
        ListTile(
          dense: true,
          title: Text('By ${widget.createdBy} · ${widget.createdAt.toLocal()}'),
          subtitle: Text('Why: ${widget.why}'),
          trailing: Text(widget.verifiedByChe ? 'Verified by CHE' : 'Not verified'),
        ),
        Expanded(
          child: _editing
              ? Padding(
                  padding: const EdgeInsets.all(16),
                  child: TextField(controller: _c, maxLines: null, expands: true))
              : InteractiveViewer(
                  minScale: 1,
                  maxScale: 5,
                  child: SingleChildScrollView(
                      padding: const EdgeInsets.all(16), child: SelectableText(_c.text)),
                ),
        ),
      ]),
    );
  }
}