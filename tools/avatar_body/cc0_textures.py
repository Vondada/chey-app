"""CC0 textures fetched at job time for CHE's Creation Engine (creation-gaps, 2026-10-25: "CC0 textures").

  python3 cc0_textures.py wood tile --cache DIR        (prints the record as JSON; for a manual check)

Source: Poly Haven's public API (https://api.polyhaven.com, documented in https://github.com/Poly-Haven/Public-API,
swagger.yml). Poly Haven publishes every asset under CC0 1.0 (https://polyhaven.com/license), and its API terms
(Public-API ToS.md, checked 2026-10-25) allow free use for any purpose including commercial, ask for a User-Agent that
names the software (2.4) and a visible credit where the live API's content is shown (2.5): CHE's receipt and the job's
completion note say "from Poly Haven ... (CC0 1.0)". Nothing is bought, no key is used, and no paid asset is touched.

How a material is chosen, deterministically: the /assets?t=textures listing, filtered to the material's Poly Haven
categories (CATEGORIES), highest download_count first, then id. The choice is remembered in the cache index, so later
jobs use the same asset. Files come from /files/<id> at 1k JPG: the Diffuse map (and nor_gl, the OpenGL normal map,
when present). Each download is checked against the API's md5 and size, then stored as <sha256>.jpg in the cache, so a
file is fetched once and every later job reuses it by hash (CHE_TEXTURE_CACHE, cached between runs by the workflow).

Any failure (no network, API down, nothing in a category, a checksum mismatch) is recorded with its reason and the
build carries on in plain colour: a texture is never claimed that was not fetched and verified.
"""
import hashlib
import json
import os
import sys
import time
import urllib.request

API = 'https://api.polyhaven.com'
USER_AGENT = 'CHE-creation-worker/1.0 (+https://github.com/Vondada/chey-app)'
SOURCE = 'Poly Haven'
LICENSE = 'CC0 1.0'
LICENSE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/'
POLICY_URL = 'https://polyhaven.com/license'
# CHE material -> (Poly Haven categories, any of which qualifies; preferred extra categories that rank first).
CATEGORIES = {
    'wood': (('wood',), ('floor', 'planks')),
    'stone': (('rock', 'stone'), ('floor',)),
    'metal': (('metal',), ()),
    'fabric': (('fabric', 'carpet'), ('carpet',)),
    'brick': (('brick',), ('wall',)),
    'concrete': (('concrete',), ('floor',)),
    'tile': (('tiles', 'tile'), ('floor',)),
}
MAPS = (('diffuse', 'Diffuse'), ('normal', 'nor_gl'))
RES = '1k'
MAX_BYTES = 12 * 1024 * 1024


def default_cache():
    return os.environ.get('CHE_TEXTURE_CACHE') or os.path.join(os.path.expanduser('~'), '.cache', 'che-cc0-textures')


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': '*/*'})
    with urllib.request.urlopen(req, timeout=timeout) as r:   # noqa: S310 (fixed https host)
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES: raise ValueError(f'{url} is larger than {MAX_BYTES} bytes')
    return data


def _index_path(cache): return os.path.join(cache, 'index.json')


def _load_index(cache):
    try: return json.load(open(_index_path(cache)))
    except (OSError, ValueError): return {'choices': {}, 'files': {}}


def _save_index(cache, idx):
    tmp = _index_path(cache) + '.tmp'
    with open(tmp, 'w') as f: json.dump(idx, f, indent=1, sort_keys=True)
    os.replace(tmp, _index_path(cache))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    return h.hexdigest()


def choose(listing, material):
    """The asset id for a material from the /assets listing, or None. Deterministic for a given listing."""
    want, prefer = CATEGORIES[material]
    rows = []
    for aid, meta in (listing or {}).items():
        cats = {str(c).lower() for c in (meta or {}).get('categories', [])}
        if not cats & set(want): continue
        rows.append((-len(cats & set(prefer)), -int((meta or {}).get('download_count') or 0), aid))
    return sorted(rows)[0][2] if rows else None


def _file(cache, idx, url, md5, size, get):
    """The cached path of a downloaded file, checked by md5 and size; fetched only when not cached by its sha256."""
    rec = idx['files'].get(url)
    if rec:
        path = os.path.join(cache, f"{rec['sha256']}.jpg")
        if os.path.isfile(path) and sha256_file(path) == rec['sha256']:
            return path, rec['sha256'], os.path.getsize(path), True
    data = get(url)
    if size and len(data) != int(size): raise ValueError(f'{url}: {len(data)} bytes, the API said {size}')
    if md5 and hashlib.md5(data).hexdigest() != md5: raise ValueError(f'{url}: md5 does not match the API')  # noqa: S324 (integrity check the API publishes)
    sha = hashlib.sha256(data).hexdigest()
    path = os.path.join(cache, f'{sha}.jpg')
    with open(path + '.tmp', 'wb') as f: f.write(data)
    os.replace(path + '.tmp', path)
    idx['files'][url] = {'sha256': sha, 'bytes': len(data), 'md5': md5, 'fetched_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    return path, sha, len(data), False


def fetch(materials, cache=None, get=_get):
    """{material: record} for each wanted material. A record is {status: 'ok', source, license, license_url, policy_url,
    asset_id, asset_page, maps: {diffuse: {path, url, sha256, bytes}, normal?: {...}}, cached} or
    {status: 'unavailable', reason}. Never raises for a network or API failure."""
    out = {}
    wanted = [m for m in dict.fromkeys(materials or []) if m in CATEGORIES]
    if not wanted: return out
    if os.environ.get('CHE_TEXTURES', '1') == '0':
        return {m: {'status': 'unavailable', 'reason': 'textures switched off for this run (CHE_TEXTURES=0)'} for m in wanted}
    cache = cache or default_cache(); os.makedirs(cache, exist_ok=True)
    idx = _load_index(cache)
    listing = None
    for m in wanted:
        try:
            aid = idx['choices'].get(m)
            if not aid:
                if listing is None: listing = json.loads(get(f'{API}/assets?t=textures'))
                aid = choose(listing, m)
                if not aid: out[m] = {'status': 'unavailable', 'reason': f'Poly Haven lists no {m} texture'}; continue
            files = json.loads(get(f'{API}/files/{aid}'))
            maps = {}; cached = True
            for key, name in MAPS:
                f = ((files.get(name) or {}).get(RES) or {}).get('jpg')
                if not f or not str(f.get('url', '')).startswith('https://'):
                    if key == 'diffuse': raise ValueError(f'{aid} has no {RES} JPG diffuse map')
                    continue
                path, sha, n, hit = _file(cache, idx, f['url'], f.get('md5'), f.get('size'), get)
                cached = cached and hit
                maps[key] = {'path': path, 'url': f['url'], 'sha256': sha, 'bytes': n}
            idx['choices'][m] = aid
            out[m] = {'status': 'ok', 'source': SOURCE, 'license': LICENSE, 'license_url': LICENSE_URL, 'policy_url': POLICY_URL,
                      'asset_id': aid, 'asset_page': f'https://polyhaven.com/a/{aid}', 'maps': maps, 'cached': cached}
        except Exception as e:   # noqa: BLE001 (any failure is recorded; the build carries on in plain colour)
            out[m] = {'status': 'unavailable', 'reason': f'{type(e).__name__}: {str(e)[:160]}'}
    _save_index(cache, idx)
    return out


def receipt_view(records):
    """The record for the receipt: no local paths."""
    return {m: {**{k: v for k, v in r.items() if k != 'maps'},
                **({'maps': {k: {kk: vv for kk, vv in mv.items() if kk != 'path'} for k, mv in r['maps'].items()}} if r.get('maps') else {})}
            for m, r in records.items()}


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    cache = sys.argv[sys.argv.index('--cache') + 1] if '--cache' in sys.argv else None
    if cache in args: args.remove(cache)
    print(json.dumps(fetch(args, cache), indent=1))
