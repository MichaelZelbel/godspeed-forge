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

export function stopRunning() {
  for (const child of running) child.kill('SIGTERM');
}
