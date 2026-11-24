// The factory driver's own tests (driver/test): every file runs here, one case after the other, so the markers
// never mix. A file written for node:test has its cases collected by driver/test/harness.mjs; the three
// release-driver files are scripts of assertions, each one case.
// test cases: 423
import { testCase } from "./cases.mjs";

const plain = new Set(["test-release-driver", "test-release-driver-cut", "test-release-driver-owner-steps"]);
const files = [
  "test-act",
  "test-ai",
  "test-briefs",
  "test-causes",
  "test-checkouts",
  "test-deadman",
  "test-driver",
  "test-duties",
  "test-gate",
  "test-housekeeping",
  "test-install-driver",
  "test-install",
  "test-inventory",
  "test-journal",
  "test-keeper",
  "test-ladder",
  "test-obstacles",
  "test-onduty",
  "test-progress",
  "test-release-driver-cut",
  "test-release-driver-owner-steps",
  "test-release-clock",
  "test-release-clock-always",
  "test-release-driver",
  "test-replay",
  "test-rescues",
  "test-settings",
  "test-shipped",
  "test-standstill",
  "test-steps",
  "test-watcher",
  "test-world"
];
for (const f of files) {
  const url = new URL(`../driver/test/${f}.mjs`, import.meta.url).href;
  if (plain.has(f)) { testCase(`the driver: ${f}`); await import(url); continue; }
  globalThis.__forgeCases = [];
  await import(url);
  const cases = globalThis.__forgeCases;
  globalThis.__forgeCases = null;
  for (const c of cases) { testCase(`${f}: ${c.name}`); await c.body({}); }
}
