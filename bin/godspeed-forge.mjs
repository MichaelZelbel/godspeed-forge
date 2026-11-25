#!/usr/bin/env node
// Node marks its built-in SQLite as experimental and says so on every run; the owner never needs that line.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (/SQLite is an experimental feature/.test(String(warning?.message ?? warning)) ? undefined : emitWarning(warning, ...rest));
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { runSetupCommand } from '../lib/cli.mjs';
import { defaultPaths } from '../lib/config.mjs';
import { run, start } from '../lib/process.mjs';
import { signIn } from '../lib/signin.mjs';
import { createFactorySetup } from '../lib/factory-setup.mjs';
import { answersFrom } from '../lib/setup.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';
import { runDriverCommand, driverAfterSetup } from '../driver/cli.mjs';

const [command, repository] = process.argv.slice(2);
if (command === '--version') {
  const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
  console.log(`godspeed-forge ${version}`);
  process.exit(0);
}
if (command === 'driver') process.exit(await runDriverCommand(process.argv.slice(3)));
if (command === 'inbox') process.exit(await (await import('../lib/inbox.mjs')).runInboxCommand());
if (command === 'watch') process.exit(await (await import('../lib/watch.mjs')).runWatchCommand(process.argv.slice(3)));
if (command === 'setup-chat' && repository) process.exit(await (await import('../lib/chat-setup-command.mjs')).runChatSetupCommand(repository));
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
    paths: defaultPaths(), commands: { run }, github: createGithubAdapter({ input: answers }), input, answers,
    prompt: question => answers.question(`${question} `),
    promptSecret: question => answers.secretQuestion(`${question} `),
    output: message => console.log(message),
    signIn: context => signIn({ ...context, start }),
    factorySetup: createFactorySetup(),
    // Setup ends with the page where the owner watches the factory: its address and sign-in are the last lines.
    afterSetup: async (repo, config, result) => {
      await driverAfterSetup(repo, { paths: defaultPaths(), config, agent: result?.agent, output: message => console.log(message) });
      const { watchLines } = await import('../lib/watch.mjs');
      for (const line of (await watchLines({ paths: defaultPaths(), say: message => console.log(message) })).lines) console.log(line);
    }
  };
});
