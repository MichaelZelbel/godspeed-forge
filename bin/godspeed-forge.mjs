#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { defaultPaths, installDefaults, readConfig } from '../lib/config.mjs';
import { run } from '../lib/process.mjs';
import { setupRepository } from '../lib/setup.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';
import { createQuestionsGithub } from '../lib/questions/github.mjs';
import { createGodspeedAdapter } from '../lib/questions/godspeed.mjs';
import { runQuestionRelay } from '../lib/questions/relay.mjs';

async function main() {
  const [command, repository] = process.argv.slice(2);
  if (!((command === 'setup' && repository) || (command === 'questions' && !repository))) {
    throw new Error('Run godspeed-forge setup owner/repository or godspeed-forge questions.');
  }
  const paths = defaultPaths();
  await installDefaults(paths.config);
  const config = await readConfig(paths.config);
  if (command === 'questions') {
    const github = createQuestionsGithub({ run, command: config.commands?.gh ?? 'gh' });
    const godspeed = createGodspeedAdapter({ root: config.godspeedRoot, modelCommand: config.modelCommand, run });
    await runQuestionRelay({ stateRoot: paths.state, github, godspeed, output: message => console.error(message) });
    return;
  }
  const input = createInterface({ input: stdin, output: stdout });
  const github = createGithubAdapter({ input });
  try {
    await setupRepository(repository, {
      config, paths, commands: { run }, github,
      prompt: question => input.question(`${question} `),
      output: message => console.log(message)
    });
  } finally {
    input.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
