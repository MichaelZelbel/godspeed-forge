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
