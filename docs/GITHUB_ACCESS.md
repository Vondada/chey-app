# GitHub access note (Vondada/chey-app)

Checked 2026-09-29 (America/Chicago). No push was attempted. No pull request was opened.

## Current readiness: NO

| Check | Result |
|---|---|
| `gh auth status` | not logged into any GitHub host |
| Cursor GitHub `get_me` | connected account **Vondada** (user id 95867380) |
| Cursor GitHub `get_repository` `Vondada/chey-app` | `scm_repo_not_accessible` — GitHub cannot see this repo with the connected account (not granted to Cursor's GitHub App, private, or missing) |
| Working tree `/workspace/agent-app` | no `.git` directory |

Write access is not established. Do not `git push` until both the Cursor app and `gh` can see the private repo.

## Exact grant steps

1. Signed in as **Vondada**, confirm `https://github.com/Vondada/chey-app` exists and is the intended private repo. If it does not exist, create it first (do not make it public just to unblock the app).
2. Open [GitHub → Settings → Applications → Installed GitHub Apps](https://github.com/settings/installations), select **Cursor**.
3. Under Repository access, choose **All repositories** or **Only select repositories** and add `chey-app`. Save. If the app is not installed, install it on the Vondada account with access to that repo (Contents and Pull requests read/write; Actions if self-update workflow dispatch is required later).
4. In Cursor, retry repository access for `Vondada/chey-app`. It should return the repo object, not `scm_repo_not_accessible`.
5. On a machine that should push: `gh auth login` (GitHub.com, account Vondada, `repo` scope). Confirm with `gh repo view Vondada/chey-app`.
6. Only then initialize or attach git and push. This checkout is not a git repo yet, so there is nothing to push.
7. CHE self-patch stays a **draft pull request**. Do not merge or deploy from an agent.

## Not done

- No `gh auth login` (interactive).
- No remote add, commit, or push.
- No invented PR.
