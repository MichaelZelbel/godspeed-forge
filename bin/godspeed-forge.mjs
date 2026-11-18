#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { defaultPaths } from '../lib/config.mjs';
import { run } from '../lib/process.mjs';
import { answersFrom, setupCommand, UNEXPECTED_MESSAGE } from '../lib/setup.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';

async function main() {
  const [command, repository] = process.argv.slice(2);
  if (command !== 'setup' || !repository) {
    console.error('Run godspeed-forge setup owner/repository.');
    return 1;
  }
  const readline = createInterface({ input: stdin, output: stdout });
  const input = answersFrom(readline);
  try {
    return await setupCommand(repository, {
      paths: defaultPaths(), commands: { run }, github: createGithubAdapter({ input }),
      prompt: question => input.question(`${question} `),
      output: message => console.log(message)
    });
  } finally {
    readline.close();
  }
}

main().then(code => { process.exitCode = code; }, () => {
  console.log(UNEXPECTED_MESSAGE);
  process.exitCode = 1;
});
