import { TEST_ENV } from "./env.mjs";
// node --test driver/test/test-install.mjs
// 2026-11-22: gate.mjs was imported by driver.mjs but missing from the installed set, so the installed driver could not start.
// Every file an installed entry point imports, however deep, must resolve inside the installed set (driver/ without test/).
import { test } from "./harness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = ["driver.mjs", "deadman/deadman.mjs", "keeper.mjs", "watcher/factory-watch.mjs", "pause.mjs"];
const IMPORT = /(?:import|from|import\()\s*(?:[^"'`;]*?\s)?["'](\.{1,2}\/[^"']+)["']/g;

test("every relative import of an installed entry point resolves inside the installed set", () => {
  const seen = new Set(), missing = [], queue = ENTRY.map(f => path.join(root, f));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(fs.existsSync(file), `${path.relative(root, file)} exists`);
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT)) {
      const target = path.resolve(path.dirname(file), m[1]);
      const rel = path.relative(root, target);
      if (rel.startsWith("..") || rel.split(path.sep)[0] === "test" || !fs.existsSync(target)) missing.push(`${path.relative(root, file)} imports ${m[1]}`);
      else if (target.endsWith(".mjs")) queue.push(target);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(seen.size > 15, `walked ${seen.size} files`);
});
