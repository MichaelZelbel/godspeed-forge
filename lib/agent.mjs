import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SIGN_IN_MESSAGE = 'Sign in to Claude Code or Codex, then ask me to set up the Forge again.';

export async function findSignedInAgent(runCommand) {
  const probes = [
    ['claude', ['auth', 'status']],
    ['codex', ['login', 'status']]
  ];
  for (const [name, args] of probes) {
    try {
      await runCommand(name, args);
      return name;
    } catch {}
  }
  return null;
}

export function createPlanningAgent({ agent, runCommand }) {
  return async ({ schema, prompt }) => {
    if (agent === 'claude') {
      const result = await runCommand('claude', ['--print', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--no-session-persistence', '--tools', '', prompt]);
      const envelope = JSON.parse(result.stdout);
      const value = envelope.structured_output ?? envelope.result;
      return typeof value === 'string' ? JSON.parse(value) : value;
    }
    if (agent === 'codex') {
      const directory = await mkdtemp(join(tmpdir(), 'forge-plan-'));
      const schemaPath = join(directory, 'schema.json');
      try {
        await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
        const result = await runCommand('codex', ['exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-rules', '--cd', directory, '--output-schema', schemaPath, prompt]);
        return JSON.parse(result.stdout);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    throw new Error('No signed-in planning agent is available.');
  };
}
