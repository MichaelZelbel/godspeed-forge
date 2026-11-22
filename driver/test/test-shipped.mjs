import { test } from "./harness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const driver = path.join(here, ".."), repo = path.join(driver, "..");
const walk = (dir, out = []) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== "node_modules" && d.name !== ".git") walk(f, out); } else out.push(f);
  }
  return out;
};
const rel = f => path.relative(repo, f).split(path.sep).join("/");
// Every file that goes onto a server or to a user: driver/ (except its tests), lib/, bin/, install.sh, skills/.
const shipped = () => [
  ...walk(driver).filter(f => !/^driver\/test\//.test(rel(f))),
  ...walk(path.join(repo, "lib")), ...walk(path.join(repo, "bin")), ...walk(path.join(repo, "skills")), path.join(repo, "install.sh"),
].filter(f => !/\.(png|jpg|gif|ico|woff2?)$/.test(f));

// What may not be in a shipped file: the first owner's name, repositories, server, factory user and key paths.
// The Forge's own public address, in the installer's text, is the one allowance.
const BANNED = [
  [/MichaelZelbel/, "an owner's login"],
  [/\/home\/godspeed-forge/, "the first server's factory user's home"],
  [/godspeed-archon/, "the first server's name"],
  [/\/[\w.@-]+(?:\/[\w.@-]+)*\/keys\.env\b/, "a key file given as an absolute path"],
  [/\/usr\/local\/lib\/godspeed-forge\/godspeed-dev/, "the first server's records checkout"],
  [/\/var\/lib\/godspeed-[a-z-]+/, "one of the first server's state folders"],
  [/\/usr\/local\/lib\/godspeed-(factory|test|forge\/factory)/, "one of the first server's program folders"],
  [/godspeed-forge-web|godspeed-forge-login|godspeed-forge-netns/, "one of the first server's units"],
  [/\/root\/\.hermes|\/root\/godspeed\b/, "the first owner's own folders"],
  [/\bAX41\b|\bmc-vps\b/, "the first server's name"],
  [/godspeed-engine|godspeed-factory-watch|godspeed-mission-control/, "one of the first owner's repositories"],
];
const ALLOWED = /(?:github\.com|api\.github\.com\/repos)\/MichaelZelbel\/godspeed-forge\b/g;

test("no shipped file names the first owner, his repositories, his server, his factory user or his key paths", () => {
  const files = shipped();
  assert.ok(files.length > 40, `looked at ${files.length} shipped files`);
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8").replace(ALLOWED, "");
    text.split("\n").forEach((line, i) => { for (const [re, what] of BANNED) if (re.test(line)) hits.push(`${rel(f)}:${i + 1}: ${what}: ${line.trim().slice(0, 90)}`); });
  }
  assert.deepEqual(hits, []);
});

test("the ban catches what it should, and the README and the installer may name the Forge's own address", () => {
  const caught = s => BANNED.some(([re]) => re.test(s.replace(ALLOWED, "")));
  for (const s of ["MichaelZelbel/x", "/home/godspeed-forge/.local/bin/claude", "factory-driver@godspeed-archon.invalid", "EnvironmentFile=/etc/godspeed-forge/keys.env", "/usr/local/lib/godspeed-forge/godspeed-dev/releases"]) assert.ok(caught(s), s);
  assert.ok(!caught("https://github.com/MichaelZelbel/godspeed-forge/archive/refs/heads/main.tar.gz"), "the Forge's own public address");
  assert.ok(!caught("the file keys.env in the settings folder"), "a name is not a path");
});

test("every file the installed entry points import is in the installed set, and nothing installed reaches into tests", () => {
  const set = walk(driver).filter(f => !/^driver\/test\//.test(rel(f)) && !/^driver\/units\//.test(rel(f)));
  const names = new Set(set.map(f => path.relative(driver, f).split(path.sep).join("/")));
  assert.ok(names.has("driver.mjs") && names.has("deadman/deadman.mjs") && names.has("keeper.mjs") && names.has("watcher/factory-watch.mjs") && names.has("steps.mjs") && names.has("settings.mjs"));
  const IMPORT = /(?:import|from|import\()\s*(?:[^"'`;]*?\s)?["'](\.{1,2}\/[^"']+)["']/g;
  const walkImports = entry => {
    const seen = new Set(), queue = [entry], bad = [];
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue; seen.add(file);
      for (const m of fs.readFileSync(path.join(driver, file), "utf8").matchAll(IMPORT)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
        if (target.startsWith("..") || target.startsWith("test/") || !names.has(target)) bad.push(`${file} imports ${m[1]}`);
        else if (target.endsWith(".mjs")) queue.push(target);
      }
    }
    return { seen, bad };
  };
  for (const entry of ["driver.mjs", "deadman/deadman.mjs", "keeper.mjs", "watcher/factory-watch.mjs", "pause.mjs", "install.mjs"]) {
    const { seen, bad } = walkImports(entry);
    assert.deepEqual(bad, [], `${entry}: every import resolves inside the installed set`);
    assert.ok(seen.size >= 1);
  }
  // each step module (found by reading the folder) too, whatever it brings
  for (const f of [...names].filter(n => /^steps\/[^/]+\.mjs$/.test(n))) assert.deepEqual(walkImports(f).bad, [], `${f}: every import resolves inside the installed set`);
  // the dead-man and the keeper stand alone: they are installed outside the driver's folder, where nothing else of it is
  for (const f of ["deadman/deadman.mjs", "keeper.mjs"]) assert.deepEqual([...fs.readFileSync(path.join(driver, f), "utf8").matchAll(IMPORT)].map(m => m[1]), [], `${f} imports nothing of the driver`);
});

test("the example settings and the installed units name nobody either, and the units' placeholders are all known", () => {
  const unitDir = path.join(driver, "units");
  const known = new Set(["NODE", "DRIVER_DIR", "KEEPER_DIR", "SETTINGS_DIR", "ENV_FILE", "AFTER_UNITS", "RECORDS_PULL", "STATE_DIRECTORY", "DEADMAN_STATE_DIRECTORY", "UNITS_DIR"]);
  for (const f of fs.readdirSync(unitDir)) {
    const text = fs.readFileSync(path.join(unitDir, f), "utf8");
    for (const m of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) assert.ok(known.has(m[1]), `${f} names ${m[1]}`);
  }
  assert.ok(fs.existsSync(path.join(driver, "settings.example.json")));
});
