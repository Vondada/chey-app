"""Build CHE's canonical release metadata from the actual unsigned IPA."""
import hashlib
import json
import plistlib
import re
import sys
import zipfile
from pathlib import Path


def metadata(ipa, commit, patchable):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Expected an exact source commit')
    with zipfile.ZipFile(ipa) as archive:
        names = [n for n in archive.namelist() if re.fullmatch(r'Payload/[^/]+\.app/Info\.plist', n)]
        if len(names) != 1:
            raise ValueError('Expected exactly one app Info.plist')
        info = plistlib.loads(archive.read(names[0]))
    if info.get('CFBundleIdentifier') != 'com.cheyapp.chey':
        raise ValueError('Unexpected app bundle identifier')
    version = str(info.get('CFBundleShortVersionString', ''))
    build = str(info.get('CFBundleVersion', ''))
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or not re.fullmatch(r'\d+', build):
        raise ValueError('Missing or invalid app version/build')
    data = Path(ipa).read_bytes()
    return dict(version=version, build_number=build, commit_sha=commit,
                sha256=hashlib.sha256(data).hexdigest(), size=len(data),
                shorebird_base=patchable, update_lane='full', build_status='success',
                tag=f'che-ios-v{version}-b{build}')


if __name__ == '__main__':
    ipa, commit, patchable, output = sys.argv[1:]
    result = metadata(ipa, commit, patchable == 'true')
    Path(output).write_text(json.dumps(result, indent=2) + '\n')
    notes = f"CHE iPhone {result['version']} ({result['build_number']}). Unsigned IPA for SideStore.\n\n<!-- CHE-META\n"
    for key, value in [('version', result['version']), ('build', result['build_number']),
                       ('commit', commit), ('sha256', result['sha256']), ('size', result['size']),
                       ('shorebird_base', str(result['shorebird_base']).lower())]:
        notes += f'{key}={value}\n'
    Path(output).with_suffix('.md').write_text(notes + '-->\n')
    print(result['tag'])
