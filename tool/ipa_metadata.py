"""Build CHE's canonical release metadata from the actual unsigned IPA.

Also the gate that stops a mismatched IPA from being published:
  python3 tool/ipa_metadata.py verify <ipa> <version> <build>
"""
import hashlib
import json
import plistlib
import re
import sys
import zipfile
from pathlib import Path

# SideStore installs an IPA only over an app with the same bundle identifier.
# The Worker's update source and install link use this same value.
BUNDLE_ID = 'com.cheyapp.chey'


def app_info(ipa):
    with zipfile.ZipFile(ipa) as archive:
        names = [n for n in archive.namelist() if re.fullmatch(r'Payload/[^/]+\.app/Info\.plist', n)]
        if len(names) != 1:
            raise ValueError('Expected exactly one app Info.plist')
        return plistlib.loads(archive.read(names[0]))


def verify(ipa, version=None, build=None):
    """Raise ValueError unless the IPA is CHE's app, and the expected version and build if given."""
    info = app_info(ipa)
    if info.get('CFBundleIdentifier') != BUNDLE_ID:
        raise ValueError(f"IPA bundle identifier is {info.get('CFBundleIdentifier')!r}, expected {BUNDLE_ID!r}")
    shown = str(info.get('CFBundleShortVersionString', ''))
    built = str(info.get('CFBundleVersion', ''))
    if not re.fullmatch(r'\d+\.\d+\.\d+', shown) or not re.fullmatch(r'\d+', built):
        raise ValueError('Missing or invalid app version/build')
    if version is not None and shown != str(version):
        raise ValueError(f'IPA version is {shown}, expected {version}')
    if build is not None and built != str(build):
        raise ValueError(f'IPA build is {built}, expected {build}')
    return shown, built


def metadata(ipa, commit, patchable):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Expected an exact source commit')
    version, build = verify(ipa)
    data = Path(ipa).read_bytes()
    return dict(version=version, build_number=build, commit_sha=commit,
                sha256=hashlib.sha256(data).hexdigest(), size=len(data),
                shorebird_base=patchable, update_lane='full', build_status='success',
                bundle_id=BUNDLE_ID, tag=f'che-ios-v{version}-b{build}')


if __name__ == '__main__':
    if sys.argv[1:2] == ['verify']:
        ipa, version, build = sys.argv[2:5]
        try:
            verify(ipa, version, build)
        except ValueError as exc:
            sys.exit(f'CHE IPA check failed: {exc}')
        print(f'Verified {BUNDLE_ID} {version} ({build})')
        sys.exit(0)
    ipa, commit, patchable, output = sys.argv[1:]
    result = metadata(ipa, commit, patchable == 'true')
    Path(output).write_text(json.dumps(result, indent=2) + '\n')
    notes = f"CHE iPhone {result['version']} ({result['build_number']}). Unsigned IPA for SideStore.\n\n<!-- CHE-META\n"
    for key, value in [('version', result['version']), ('build', result['build_number']),
                       ('bundle_id', result['bundle_id']),
                       ('commit', commit), ('sha256', result['sha256']), ('size', result['size']),
                       ('shorebird_base', str(result['shorebird_base']).lower())]:
        notes += f'{key}={value}\n'
    Path(output).with_suffix('.md').write_text(notes + '-->\n')
    print(result['tag'])
