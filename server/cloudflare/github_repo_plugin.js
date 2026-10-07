// Read-only GitHub tools in the same shape as the weather plugin.
// Opening a pull request is not here. That stays on openSelfUpdatePr,
// which needs the owner and CHE_GITHUB_TOKEN.

export const githubRepoPlugin = {
  id: 'github-repo',
  name: 'GitHub Repo',
  version: '1.0.0',
  author: 'CHE',
  description: 'Read a public GitHub file or repository listing. Does not open pull requests.',
  icon: 'book',
  color: '#E6EDF3',
  permissions: ['network:api.github.com'],
  instructions: 'To read a public repo, call repo_file with owner, repo, and path. To list a public repo root, call repo_list with owner and repo. This tool is read-only. Do not say a pull request was opened; that is a separate owner-approved update.',
  quickActions: ['Read the CHE activity file on GitHub'],
  tools: [
    {
      name: 'repo_file',
      description: 'Read one public file from a GitHub repo. Path is the file path, such as server/cloudflare/activity.js.',
      params: { owner: 'string', repo: 'string', path: 'string' },
      request: { method: 'GET', url: 'https://api.github.com/repos/{{owner}}/{{repo}}/contents/{{path}}' },
    },
    {
      name: 'repo_list',
      description: 'List the public root of a GitHub repo.',
      params: { owner: 'string', repo: 'string' },
      request: { method: 'GET', url: 'https://api.github.com/repos/{{owner}}/{{repo}}/contents/' },
    },
  ],
};
