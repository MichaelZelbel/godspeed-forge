#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runSetupCommand } from '../lib/cli.mjs';
import { defaultPaths } from '../lib/config.mjs';
import { run } from '../lib/process.mjs';
import { answersFrom, START_AFRESH_PARTS } from '../lib/setup.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';

// godspeed-forge setup owner/repository [--start-afresh <part>]
const [command, repository, ...rest] = process.argv.slice(2);
const startAfresh = rest[0] === '--start-afresh' && rest.length === 2 ? rest[1] : undefined;
if (command !== 'setup' || !repository || (rest.length > 0 && !START_AFRESH_PARTS.includes(startAfresh))) {
  console.error('Run godspeed-forge setup owner/repository.');
  process.exit(1);
}
// Not awaited at the top level: if the input closes while a question waits, that question never settles, and
// Node would print a raw warning about an unsettled top-level await.
runSetupCommand(repository, async () => {
  const input = createInterface({ input: stdin, output: stdout });
  const answers = answersFrom(input);
  return {
    paths: defaultPaths(), commands: { run }, github: createGithubAdapter({ input: answers }), input, answers, startAfresh,
    prompt: question => answers.question(`${question} `),
    output: message => console.log(message)
  };
});
