#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { defaultPaths, installDefaults, readConfig } from '../lib/config.mjs';
import { run } from '../lib/process.mjs';
import { setupRepository } from '../lib/setup.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';

async function main() {
  const [command, repository] = process.argv.slice(2);
  if (command !== 'setup' || !repository) throw new Error('Run godspeed-forge setup owner/repository.');
  const paths = defaultPaths();
  await installDefaults(paths.config);
  const config = await readConfig(paths.config);
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
