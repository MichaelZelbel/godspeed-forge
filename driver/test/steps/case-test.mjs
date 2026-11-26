// A tiny stand-in for node:test's test(name, fn) that marks each case the way test/cases.mjs does, so the
// moved tests of the release steps count as cases in test/run.sh ("case passed: <name>"). Cases run one after
// the other in the order they were declared; the file ends with `await runCases()`. A case that throws stops
// the file and is reported as failed by test/cases.mjs.
import { testCase } from "../../../test/cases.mjs";

const queue = [];

export function test(name, fn) {
  queue.push([name, fn]);
}

export async function runCases() {
  for (const [name, fn] of queue.splice(0)) {
    testCase(name);
    await fn();
  }
}

export default test;
