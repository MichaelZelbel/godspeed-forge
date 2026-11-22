// install.sh runs this with the Node it found: FORGE_SOURCE names the Forge being installed, FORGE_MINIMUM_GODSPEED the
// oldest Godspeed it works with. What it does is in server.mjs.
import { installServer } from './server.mjs';

process.exitCode = await installServer();
