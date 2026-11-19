import { ReportedSetupError, SetupInterrupted, setupRepository } from './setup.mjs';
import { stopRunning } from './process.mjs';

// Runs `godspeed-forge setup` and ends the process with its exit code. makeOptions builds setupRepository's
// options once signals are watched; options.input, when given, is the readline interface the questions use.
// Ctrl-C at a terminal reaches readline rather than the process, so readline's SIGINT counts as one too.
// In a terminal the stop sentence starts on a line of its own, not after an open question or a typed ^C.
export async function runSetupCommand(repository, makeOptions) {
  let options;
  let signalled = false;
  let resolveInterrupted;
  const interrupted = new Promise(resolve => { resolveInterrupted = resolve; });
  const notify = signal => {
    if (!signalled && options?.input?.terminal) process.stdout.write('\n');
    signalled = true;
    resolveInterrupted(signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => notify(signal));
  let code = 0;
  try {
    options = await makeOptions();
    options.input?.on('SIGINT', () => notify('SIGINT'));
    await setupRepository(repository, { ...options, interrupted });
  } catch (error) {
    if (!(error instanceof ReportedSetupError)) console.error(error.message);
    code = error instanceof SetupInterrupted ? error.exitCode : 1;
    if (error instanceof SetupInterrupted) stopRunning();
  } finally {
    options?.input?.close();
  }
  // A step left waiting (a question, a command) would otherwise keep the process alive.
  process.exit(code);
}
