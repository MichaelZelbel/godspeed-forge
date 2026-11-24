import { setTimeout as sleep } from 'node:timers/promises';
import { setupCommand, UNEXPECTED_MESSAGE } from './setup.mjs';
import { stopRunning } from './process.mjs';

// How long setup may take to exit after a signal before it ends by that signal instead.
const EXIT_DEADLINE_MS = 3000;

// Ends the process by the signal that stopped it, which a shell reports as the same 130 or 143 that
// process.exit would give. process.exit cannot end the process while a file write or other request is stuck:
// it waits for that request first.
function endBySignal(signal) {
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}

// Whether a file write, lookup or other request this process started has not finished.
const requestPending = () => process.getActiveResourcesInfo().some(name => /Req/.test(name));

// Runs `godspeed-forge setup` and ends the process with its exit code. makeOptions builds setupCommand's
// options once signals are watched; options.input, when given, is the readline interface the questions use, and
// options.answers the answersFrom(...) reading from it. Ctrl-C at a terminal reaches readline rather than the
// process, so readline's SIGINT counts as one too. After a signal the stop sentence starts on a line of its own,
// not after an open question or a typed ^C, and setup exits within three seconds even when a file write or other
// request never finishes, then ending by that signal.
export async function runSetupCommand(repository, makeOptions) {
  let options;
  let signalled = null;
  let resolveInterrupted;
  const interrupted = new Promise(resolve => { resolveInterrupted = resolve; });
  const notify = signal => {
    if (!signalled) {
      const ended = options?.answers?.endOpenQuestion?.() ?? false;
      if (!ended && options?.input?.terminal) process.stdout.write('\n');
      setTimeout(() => endBySignal(signal), EXIT_DEADLINE_MS);
      signalled = signal;
    }
    resolveInterrupted(signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => notify(signal));
  let code = 1;
  try {
    options = await makeOptions();
    options.input?.on('SIGINT', () => notify('SIGINT'));
    code = await setupCommand(repository, { ...options, interrupted });
    if (signalled) stopRunning();
  } catch {
    // setupCommand reports every stop itself; this is only a failure building its options.
    console.log(UNEXPECTED_MESSAGE);
  } finally {
    options?.input?.close();
  }
  // process.exit would wait for a stuck request, so after a signal it waits here, where the deadline can end it.
  if (signalled) {
    while (requestPending()) await sleep(50);
  }
  // A step left waiting (a question, a command) would otherwise keep the process alive.
  process.exit(code);
}
