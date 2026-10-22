# Lists the Material icon names whose glyphs are in a built, tree-shaken MaterialIcons font (owner, 2026-10-22:
# patched screens showed "?" boxes for icons the installed build never compiled).
# Build the IPA commit for the web (same icon tree shaking), then:
#   python3 tool/compiled_icons.py build/web/assets/fonts/MaterialIcons-Regular.otf > compiled.txt
# Needs fontTools (pip install fonttools) and the Flutter SDK's icons.dart (from $FLUTTER_ROOT).
import os
import re
import sys

from fontTools.ttLib import TTFont

font = TTFont(sys.argv[1])
codepoints = set(font.getBestCmap().keys())
icons = os.path.join(os.environ.get('FLUTTER_ROOT', '/opt/flutter-sdk/flutter'), 'packages/flutter/lib/src/material/icons.dart')
names = {}
for m in re.finditer(r'static const IconData (\w+) = IconData\(\s*0x([0-9a-f]+)', open(icons).read()):
    names.setdefault(int(m.group(2), 16), []).append(m.group(1))
print('\n'.join(sorted(n for cp in codepoints for n in names.get(cp, []))))
