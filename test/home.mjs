// Imported first by the setup tests: setup keeps the Archon source under the home folder, so each test file gets its own.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'forge-home-'));
