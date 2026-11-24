import { spawn } from 'node:child_process';

// Commands still running, so a setup that is told to stop can stop them too.
const running = new Set();

export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', () => { running.delete(child); reject(new Error(`Could not run ${command}.`)); });
    child.on('close', code => {
      running.delete(child);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${command} failed.`), { stdout, stderr }));
    });
  });
}

// A command that keeps running while its output is read as it comes and its input can be written, for a sign-in
// that prints a link and a code and then waits. Both output streams are read as one text. done resolves when the
// command ends, with started false when it could not start at all; it never rejects.
export function start(command, args = [], options = {}) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  running.add(child);
  let output = '';
  const watchers = new Set();
  const take = chunk => {
    output += chunk;
    for (const watcher of watchers) watcher(output);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.stdin.on('error', () => {});
  const done = new Promise(resolve => {
    child.on('error', () => { running.delete(child); resolve({ code: null, started: false, output }); });
    child.on('close', code => { running.delete(child); resolve({ code, started: true, output }); });
  });
  return {
    watch(watcher) { watchers.add(watcher); watcher(output); return () => watchers.delete(watcher); },
    write(text) { if (child.stdin.writable) child.stdin.write(text); },
    stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); },
    done
  };
}

export function stopRunning() {
  for (const child of running) child.kill('SIGTERM');
}
