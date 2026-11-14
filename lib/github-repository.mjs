function parse(output) { return output.trim() ? JSON.parse(output) : null; }
function text(value, limit) { return typeof value === 'string' ? value.slice(0, limit) : ''; }

export function createGithubRepository({ repository, runCommand, command = 'gh' }) {
  const api = async (path, extra = []) => {
    const pages = parse((await runCommand(command, ['api', '--paginate', '--slurp', path, ...extra])).stdout);
    if (!Array.isArray(pages)) return pages;
    if (pages.length === 1 && !Array.isArray(pages[0])) return pages[0];
    return pages.flat();
  };
  return {
    async collect() {
      const [viewer, repo, releases, issues, pulls, mergedPulls, workflows] = await Promise.all([
        api('/user'), api(`/repos/${repository}`), api(`/repos/${repository}/releases?per_page=100`),
        api(`/repos/${repository}/issues?state=open&per_page=100`), api(`/repos/${repository}/pulls?state=open&per_page=100`),
        api(`/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100`), api(`/repos/${repository}/actions/workflows?per_page=100`)
      ]);
      const latestRelease = releases?.find(value => !value.draft && value.published_at) ?? null;
      const since = latestRelease?.published_at ? `?sha=${encodeURIComponent(repo.default_branch)}&since=${encodeURIComponent(latestRelease.published_at)}` : `?sha=${encodeURIComponent(repo.default_branch)}`;
      const [commits, runs] = await Promise.all([
        api(`/repos/${repository}/commits${since}`), api(`/repos/${repository}/actions/runs?branch=${encodeURIComponent(repo.default_branch)}&per_page=100`)
      ]);
      return {
        viewer: viewer.login, defaultBranch: repo.default_branch,
        latestRelease: latestRelease && { tag: latestRelease.tag_name, publishedAt: latestRelease.published_at },
        commits: (commits ?? []).slice(0, 100).map(value => ({ sha: value.sha, title: text(value.commit?.message?.split('\n')[0], 300), date: value.commit?.author?.date, author: value.author?.login })),
        mergedPullRequests: (mergedPulls ?? []).filter(value => value.merged_at && (!latestRelease?.published_at || value.merged_at > latestRelease.published_at)).slice(0, 100).map(value => ({ id: value.number, title: text(value.title, 300), mergedAt: value.merged_at, author: value.user?.login })),
        issues: (issues ?? []).filter(value => !value.pull_request).slice(0, 100).map(value => ({ id: value.number, title: text(value.title, 300), body: text(value.body, 2000), labels: (value.labels ?? []).map(label => text(label.name, 100)).slice(0, 20), createdAt: value.created_at, author: value.user?.login })),
        pullRequests: (pulls ?? []).slice(0, 100).map(value => ({ id: value.number, title: text(value.title, 300), body: text(value.body, 2000), labels: (value.labels ?? []).map(label => text(label.name, 100)).slice(0, 20), createdAt: value.created_at, author: value.user?.login })),
        checks: [
          ...(runs?.workflow_runs ?? []).filter(value => value.status === 'completed' && value.conclusion !== 'success').map(value => ({ name: value.name, conclusion: value.conclusion })),
          ...(workflows?.workflows ?? []).filter(value => value.state !== 'active').map(value => ({ name: value.name, conclusion: 'disabled' }))
        ]
      };
    },
    async createIssue({ title, body }) {
      const value = parse((await runCommand(command, ['api', `/repos/${repository}/issues`, '--method', 'POST', '-f', `title=${title}`, '-f', `body=${body}`])).stdout);
      return { number: value.number, url: value.html_url };
    }
  };
}
