// "Where can I watch the factory?" in the chat: the page's address and the user name to sign in with. The password
// never goes into the chat (its words pass through the assistant's provider and stay in the chat's history); setup
// showed it, and `godspeed-forge watch` in the server's terminal shows it again.
import { addressOf, readRecord, UNIT } from '../watch.mjs';
import { runCommand } from '../godspeed.mjs';

export const SAY = {
  here: (address, user) => `You can watch the factory at ${address}. Sign in as ${user} with the password setup showed you. If you no longer have it, type godspeed-forge watch in your server's terminal, logged in as root, and it shows it again.`,
  stopped: address => `The page where you watch the factory, ${address}, is not running right now. Type godspeed-forge watch in your server's terminal, logged in as root, and it starts the page again and shows how to sign in.`,
  none: "The page where you watch the factory is not set up on this server yet. Type godspeed-forge watch in your server's terminal, logged in as root, and it sets the page up and shows how to sign in.",
};

// ctx: the inbox's { paths, ... }; ctx.run stands in for the server's commands in a test.
export async function watch(request, ctx) {
  const record = readRecord(ctx.paths);
  if (!record || !record.revision || !record.host || !record.port) return { ok: false, say: SAY.none };
  const active = await (ctx.run || runCommand)('systemctl', ['is-active', '--quiet', `${UNIT}.service`]);
  if (active.status !== 0) return { ok: false, say: SAY.stopped(addressOf(record)) };
  return { ok: true, say: SAY.here(addressOf(record), record.user) };
}
