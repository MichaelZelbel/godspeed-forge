#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runSetupCommand } from '../lib/cli.mjs';
import { defaultPaths } from '../lib/config.mjs';
import { run } from '../lib/process.mjs';
import { answersFrom } from '../lib/setup.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';

const [command, repository] = process.argv.slice(2);
if (command !== 'setup' || !repository) {
  console.error('Run godspeed-forge setup owner/repository.');
  process.exit(1);
}
// Not awaited at the top level: if the input closes while a question waits, that question never settles, and
// Node would print a raw warning about an unsettled top-level await.
runSetupCommand(repository, async () => {
  const input = createInterface({ input: stdin, output: stdout });
  const answers = answersFrom(input);
  return {
    paths: defaultPaths(), commands: { run }, github: createGithubAdapter({ input: answers }), input,
    prompt: question => answers.question(`${question} `),
    output: message => console.log(message)
  };
});
