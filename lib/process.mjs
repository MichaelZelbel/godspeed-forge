import { spawn } from 'node:child_process';

export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', () => reject(new Error(`Could not run ${command}.`)));
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${command} failed.`), { stdout, stderr }));
    });
  });
}
