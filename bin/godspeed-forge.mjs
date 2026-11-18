#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runSetupCommand } from '../lib/cli.mjs';
import { defaultPaths } from '../lib/config.mjs';
import { run } from '../lib/process.mjs';
import { loadSettings } from '../lib/setup.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';

const [command, repository] = process.argv.slice(2);
if (command !== 'setup' || !repository) {
  console.error('Run godspeed-forge setup owner/repository.');
  process.exit(1);
}
await runSetupCommand(repository, async () => {
  const paths = defaultPaths();
  const output = message => console.log(message);
  const config = await loadSettings(paths.config, output);
  const input = createInterface({ input: stdin, output: stdout });
  return {
    config, paths, commands: { run }, github: createGithubAdapter({ input }), input,
    prompt: question => input.question(`${question} `),
    output
  };
});
