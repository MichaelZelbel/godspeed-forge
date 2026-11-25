// `godspeed-forge setup-chat owner/repository`: the worker the chat's setup requests start (lib/owner/setup.mjs). It runs
// the same setup as the terminal command, asking its questions through lib/chat-setup.mjs's files instead of a readline.
import { runSetupCommand } from './cli.mjs';
import { defaultPaths } from './config.mjs';
import { createFactorySetup } from './factory-setup.mjs';
import { createChatSetup, openSession } from './chat-setup.mjs';
import { driverAfterSetup } from '../driver/cli.mjs';

export function runChatSetupCommand(repository) {
  const paths = defaultPaths();
  return runSetupCommand(repository, async () => {
    const session = openSession(paths, repository);
    // Whatever ends the worker before setup finished leaves it stopped, never forever running.
    process.on('exit', () => { if (session.state.status !== 'done') session.finish('stopped'); });
    const { options } = createChatSetup({
      repository, paths, session,
      deps: { afterSetup: (name, config, result) => driverAfterSetup(name, { paths, config, agent: result?.agent, output: text => session.say(text) }) }
    });
    return { ...options, factorySetup: createFactorySetup() };
  });
}
