#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { defaultPaths, installDefaults, readConfig } from '../lib/config.mjs';
import { run } from '../lib/process.mjs';
import { setupRepository } from '../lib/setup.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';
import { createGithubRepository } from '../lib/github-repository.mjs';
import { createPlanningAgent, findSignedInAgent, SIGN_IN_MESSAGE } from '../lib/agent.mjs';
import { planRelease } from '../lib/planner.mjs';

export function parseArguments(argv) {
  const [command, repository, ...extra] = argv;
  if (extra.length || !['setup', 'plan'].includes(command) || (command === 'setup' && !repository)) throw new Error('Run godspeed-forge setup owner/repository or godspeed-forge plan [project].');
  return { command, repository };
}

async function main() {
  const { command, repository } = parseArguments(process.argv.slice(2));
  const paths = defaultPaths();
  await installDefaults(paths.config);
  const config = await readConfig(paths.config);
  const input = createInterface({ input: stdin, output: stdout });
  try {
    const prompt = question => input.question(`${question} `);
    const output = message => console.log(message);
    if (command === 'setup') {
      await setupRepository(repository, { config, paths, commands: { run }, github: createGithubAdapter({ input }), prompt, output });
    } else {
      const agent = await findSignedInAgent(run);
      if (!agent) { output(SIGN_IN_MESSAGE.replace('set up the Forge again', 'plan the release again')); return; }
      const planningAgent = createPlanningAgent({ agent, runCommand: run });
      await planRelease(repository, {
        stateRoot: paths.state, prompt, output,
        createRepository: name => createGithubRepository({ repository: name, runCommand: run, command: config.commands?.gh }),
        planWithAgent: planningAgent, verifyWithAgent: planningAgent
      });
    }
  } finally {
    input.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
