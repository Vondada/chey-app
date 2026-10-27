"""Copy one GPU face-preview job (pictures, receipt, log) to the results repository so Claude can verify it.

  RESULTS_TOKEN=... python3 scripts/che_gpu_push_results.py --job DIR [--repo https://github.com/OWNER/che-gpu-results]

The token is for a SEPARATE private results repository (default Vondada/che-gpu-results), never for chey-app: a token
that can write chey-app could also push to its unprotected main branch. Rules:
- Only the rendered views, receipt.json and log.txt are copied; nothing else in the job folder (no inputs, no photos).
- The token reaches git through GIT_CONFIG_* environment variables for this process only: it is not written to
  .git/config, not on any command line, and redacted from every message.
- Pushes go only to the `main` branch of the results repository; a rerun with nothing new pushes nothing.
Exit codes: 0 pushed or already up to date, 2 no token, 3 git failed.
"""
import argparse
import base64
import os
import shutil
import subprocess
import sys
import tempfile

KEEP = ('receipt.json', 'log.txt')


def results_files(job):
    """The files that leave the job folder: view PNGs, the receipt and the log."""
    return sorted(n for n in os.listdir(job)
                  if os.path.isfile(os.path.join(job, n)) and (n in KEEP or (n.startswith('view_') and n.endswith('.png'))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--job', required=True); ap.add_argument('--repo', default='https://github.com/Vondada/che-gpu-results')
    ap.add_argument('--branch', default='main')
    a = ap.parse_args()
    token = os.environ.get('RESULTS_TOKEN', '').strip()
    if not token:
        print('NO RESULTS_TOKEN: nothing pushed. The pictures and receipt are saved in Google Drive:', a.job)
        return 2
    job_name = os.path.basename(os.path.normpath(a.job))
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_CONFIG_COUNT='1',
               GIT_CONFIG_KEY_0='http.https://github.com/.extraheader',
               GIT_CONFIG_VALUE_0='AUTHORIZATION: basic ' + base64.b64encode(f'x-access-token:{token}'.encode()).decode())
    env.pop('RESULTS_TOKEN', None)

    def git(*args, cwd=None, check=True):
        r = subprocess.run(['git', *args], cwd=cwd, env=env, capture_output=True, text=True)
        out = (r.stdout + r.stderr).replace(token, '***')
        if check and r.returncode:
            raise RuntimeError(f'git {args[0]} failed: {out.strip()[-1500:]}')
        return r.returncode, out

    work = tempfile.mkdtemp(prefix='che-results-')
    try:
        code, _ = git('clone', '-q', '--depth', '1', '-b', a.branch, a.repo, work, check=False)
        if code:   # empty repository: start its first branch
            shutil.rmtree(work); os.makedirs(work)
            git('init', '-q', '-b', a.branch, cwd=work); git('remote', 'add', 'origin', a.repo, cwd=work)
        dst = os.path.join(work, 'results', job_name); os.makedirs(dst, exist_ok=True)
        files = results_files(a.job)
        for n in files: shutil.copy2(os.path.join(a.job, n), dst)
        git('add', '-A', cwd=work)
        if not git('status', '--porcelain', cwd=work)[1].strip():
            print(f'UP TO DATE: results/{job_name} is already in {a.repo}'); return 0
        status = 'unknown'
        try:
            import json; status = json.load(open(os.path.join(a.job, 'receipt.json'))).get('status', 'unknown')
        except (OSError, ValueError): pass
        git('-c', 'user.name=CHE Colab', '-c', 'user.email=che-colab@users.noreply.github.com',
            'commit', '-q', '-m', f'GPU face preview {job_name}: {status}', cwd=work)
        git('push', '-q', 'origin', f'HEAD:refs/heads/{a.branch}', cwd=work)
        print(f'PUSHED results/{job_name} ({", ".join(files)}) to {a.repo}')
        return 0
    except RuntimeError as e:
        print('PUSH FAILED (the results are still in Google Drive):', e); return 3
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
