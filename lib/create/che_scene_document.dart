// CHE scene document, the phone side of server/cloudflare/scene_document.js (M2b, owner 2026-10-28).
//
// The same rules as the Worker: a known kind, asset references, declared properties with their ranges, unique IDs.
// The phone checks an edit before sending it, so a bad value is shown at once. The Worker checks again on save and is
// the one that decides. Undo and redo are kept here for every editing mode.

const kinds = <String>{'character', 'object', 'room', 'terrain', 'light', 'camera'};
final assetId = RegExp(r'^[A-Za-z0-9_.:-]{1,120}$');
final colour = RegExp(r'^#[0-9a-fA-F]{6}$');
const maxObjects = 500;
const maxHistory = 100;

/// Declared editable properties per kind: number ranges, a colour, or a choice from options.
const Map<String, Map<String, Object>> properties = {
  'character': {
    'height_m': [0.5, 3.0],
    'skin_tone': [0.0, 1.0],
    'pore_detail': [0.0, 1.0],
    'hair_length': [0.0, 1.0],
  },
  'object': {
    'color': 'color',
    'roughness': [0.0, 1.0],
    'metallic': [0.0, 1.0],
  },
  'room': {
    'wall_color': 'color',
    'light': ['warm', 'neutral', 'cool'],
  },
  'terrain': {
    'roughness': [0.0, 1.0],
    'gravel_density': [0.0, 1.0],
  },
  'light': {
    'intensity': [0.0, 100.0],
  },
  'camera': {
    'focal_length_mm': [10.0, 200.0],
  },
};

class SceneException implements Exception {
  SceneException(this.message, [this.field = '']);
  final String message;
  final String field;
  @override
  String toString() => message;
}

class Vec3 {
  const Vec3(this.x, this.y, this.z);
  final double x;
  final double y;
  final double z;

  Map<String, double> toJson() => {'x': x, 'y': y, 'z': z};

  static const zero = Vec3(0, 0, 0);
  static const one = Vec3(1, 1, 1);

  static Vec3 fromJson(Object? v) {
    final m = v is Map ? v : const {};
    double axis(String k, double fallback) => (m[k] as num?)?.toDouble() ?? fallback;
    return Vec3(axis('x', 0), axis('y', 0), axis('z', 0));
  }
}

class Transform {
  const Transform({this.position = Vec3.zero, this.rotation = Vec3.zero, this.scale = Vec3.one});
  final Vec3 position;
  final Vec3 rotation;
  final Vec3 scale;

  Map<String, Object> toJson() => {
        'position': position.toJson(),
        'rotation': rotation.toJson(),
        'scale': scale.toJson(),
      };

  static Transform fromJson(Object? v) {
    final m = v is Map ? v : const {};
    return Transform(
      position: Vec3.fromJson(m['position']),
      rotation: Vec3.fromJson(m['rotation']),
      scale: Vec3.fromJson(m['scale'] ?? {'x': 1, 'y': 1, 'z': 1}),
    );
  }
}

/// Checks one property value. Returns the cleaned value or throws a SceneException the owner can read.
Object validateProperty(String kind, String name, Object value) {
  final spec = properties[kind]?[name];
  if (spec == null) {
    throw SceneException('"$name" is not an editable property of this kind ($kind).', name);
  }
  if (spec is List && spec.first is num) {
    if (value is! num || value < spec[0] || value > spec[1]) {
      throw SceneException('$name must be a number from ${spec[0]} to ${spec[1]}.', name);
    }
    return value.toDouble();
  }
  if (spec == 'color') {
    if (value is! String || !colour.hasMatch(value)) {
      throw SceneException('$name must be a colour like #aabbcc.', name);
    }
    return value.toLowerCase();
  }
  final options = spec as List;
  if (!options.contains(value)) {
    throw SceneException('$name must be one of: ${options.join(', ')}.', name);
  }
  return value;
}

class SceneObject {
  const SceneObject({
    required this.id,
    required this.kind,
    required this.name,
    required this.assetRef,
    this.transform = const Transform(),
    this.props = const {},
  });

  final String id;
  final String kind;
  final String name;
  final String assetRef;
  final Transform transform;
  final Map<String, Object> props;

  SceneObject withProperty(String name, Object value) {
    return SceneObject(
      id: id,
      kind: kind,
      name: this.name,
      assetRef: assetRef,
      transform: transform,
      props: {...props, name: value},
    );
  }

  SceneObject withTransform(Transform t) =>
      SceneObject(id: id, kind: kind, name: name, assetRef: assetRef, transform: t, props: props);

  Map<String, Object> toJson() => {
        'id': id,
        'kind': kind,
        'name': name,
        'asset_ref': assetRef,
        'transform': transform.toJson(),
        'properties': props,
        'hidden': false,
      };

  static SceneObject fromJson(Map<String, dynamic> m) {
    final kind = m['kind'] as String? ?? '';
    final rawProps = (m['properties'] as Map?) ?? const {};
    final props = <String, Object>{};
    rawProps.forEach((k, v) {
      props[k as String] = validateProperty(kind, k, v as Object);
    });
    final object = SceneObject(
      id: m['id'] as String? ?? '',
      kind: kind,
      name: m['name'] as String? ?? '',
      assetRef: m['asset_ref'] as String? ?? '',
      transform: Transform.fromJson(m['transform']),
      props: props,
    );
    _checkObject(object);
    return object;
  }
}

void _checkObject(SceneObject o) {
  if (!assetId.hasMatch(o.id)) throw SceneException('An object needs an ID.', 'id');
  if (!kinds.contains(o.kind)) throw SceneException('Kind must be one of: ${kinds.join(', ')}.', 'kind');
  if (o.name.isEmpty || o.name.length > 80) throw SceneException('A name must be 1 to 80 characters.', 'name');
  if (!assetId.hasMatch(o.assetRef)) {
    throw SceneException('An object needs an asset reference (the ID of the record it uses).', 'asset_ref');
  }
}

class SceneDocument {
  const SceneDocument({required this.id, required this.name, required this.objects});

  final String id;
  final String name;
  final List<SceneObject> objects;

  Map<String, Object> toJson() => {
        'schema': 1,
        'id': id,
        'name': name,
        'objects': [for (final o in objects) o.toJson()],
      };

  static SceneDocument fromJson(Map<String, dynamic> m) {
    if (m['schema'] != 1) throw SceneException('Unsupported scene schema ${m['schema']}.', 'schema');
    final list = (m['objects'] as List?) ?? const [];
    if (list.length > maxObjects) throw SceneException('A scene holds at most $maxObjects objects.', 'objects');
    final seen = <String>{};
    final objects = <SceneObject>[];
    for (final raw in list) {
      final o = SceneObject.fromJson(Map<String, dynamic>.from(raw as Map));
      if (!seen.add(o.id)) throw SceneException('Object ID "${o.id}" is used twice.', 'id');
      objects.add(o);
    }
    return SceneDocument(id: m['id'] as String? ?? '', name: m['name'] as String? ?? '', objects: objects);
  }

  SceneDocument _replace(List<SceneObject> next) => SceneDocument(id: id, name: name, objects: next);
}

/// Every change keeps the one before it. Undo and redo work for every editing mode.
class SceneHistory {
  const SceneHistory._(this.past, this.present, this.future);

  factory SceneHistory.start(SceneDocument scene) => SceneHistory._(const [], scene, const []);

  final List<SceneDocument> past;
  final SceneDocument present;
  final List<SceneDocument> future;

  SceneHistory _commit(SceneDocument next) {
    final kept = [...past, present];
    final trimmed = kept.length > maxHistory ? kept.sublist(kept.length - maxHistory) : kept;
    return SceneHistory._(trimmed, next, const []);
  }

  SceneObject _find(String objectId) {
    for (final o in present.objects) {
      if (o.id == objectId) return o;
    }
    throw SceneException('No object with ID "$objectId".', 'id');
  }

  SceneHistory addObject(SceneObject object) {
    if (present.objects.length >= maxObjects) {
      throw SceneException('A scene holds at most $maxObjects objects.', 'objects');
    }
    _checkObject(object);
    if (present.objects.any((o) => o.id == object.id)) {
      throw SceneException('Object ID "${object.id}" already exists.', 'id');
    }
    return _commit(present._replace([...present.objects, object]));
  }

  SceneHistory setProperty(String objectId, String name, Object value) {
    final target = _find(objectId);
    final clean = validateProperty(target.kind, name, value);
    final next = present.objects.map((o) => o.id == objectId ? o.withProperty(name, clean) : o).toList();
    return _commit(present._replace(next));
  }

  SceneHistory setTransform(String objectId, Transform t) {
    _find(objectId);
    final next = present.objects.map((o) => o.id == objectId ? o.withTransform(t) : o).toList();
    return _commit(present._replace(next));
  }

  SceneHistory removeObject(String objectId) {
    _find(objectId);
    return _commit(present._replace(present.objects.where((o) => o.id != objectId).toList()));
  }

  SceneHistory undo() {
    if (past.isEmpty) return this;
    return SceneHistory._(past.sublist(0, past.length - 1), past.last, [present, ...future]);
  }

  SceneHistory redo() {
    if (future.isEmpty) return this;
    return SceneHistory._([...past, present], future.first, future.sublist(1));
  }

  bool get canUndo => past.isNotEmpty;
  bool get canRedo => future.isNotEmpty;
}
