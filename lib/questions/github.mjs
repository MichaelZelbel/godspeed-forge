export function createQuestionsGithub({ run, command = 'gh' }) {
  async function json(args) {
    const result = await run(command, args);
    return JSON.parse(result.stdout);
  }
  return {
    async find(repository) {
      const issues = await json(['issue', 'list', '--repo', repository, '--state', 'open', '--search', 'Owner decisions needed in:title', '--json', 'number,title,body']);
      const matches = issues.filter(issue => issue.title === 'Owner decisions needed');
      if (matches.length > 1) throw new Error(`${repository} has more than one open decisions issue.`);
      if (!matches.length) return null;
      const issue = matches[0];
      issue.comments = await json(['api', `repos/${repository}/issues/${issue.number}/comments`]);
      return issue;
    },
    async comment(repository, number, body) {
      await run(command, ['issue', 'comment', String(number), '--repo', repository, '--body', body]);
    }
  };
}
