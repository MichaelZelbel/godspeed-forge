// Imported first by the setup tests: setup keeps the Archon source under the home folder, so each test file gets its own.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'forge-home-'));

// The line setup says once the factory's browser has opened a local page.
export const BROWSER_PASSED = "The browser check passed: the browser opened a local page and read its text.";

// The browser tool as a script on a stand-in PATH: it says the fixed word when asked for a page's text.
export const AGENT_BROWSER_STAND_IN = 'case "$*" in *"get text"*) echo forge-browser-proof;; esac';
